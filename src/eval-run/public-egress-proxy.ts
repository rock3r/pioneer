import { timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { URL } from "node:url";
import { isPublicInternetAddress } from "./isolation.js";

export interface PublicEgressProxy {
  readonly url: string;
  close(): Promise<void>;
}

export interface ResolvedTarget {
  readonly address: string;
  readonly family: 4 | 6;
}

export type EgressTargetResolver = (hostname: string) => Promise<ResolvedTarget>;

const LOCAL_HOST_SUFFIXES = [
  "localhost",
  ".localhost",
  ".local",
  ".lan",
  ".internal",
  ".home.arpa",
] as const;

function normalizeHostname(hostname: string): string {
  const unwrapped =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return unwrapped.replace(/\.$/, "").toLowerCase();
}

export async function resolvePublicTarget(hostname: string): Promise<ResolvedTarget> {
  const normalized = normalizeHostname(hostname);
  if (
    normalized.length === 0 ||
    LOCAL_HOST_SUFFIXES.some((suffix) => normalized === suffix || normalized.endsWith(suffix))
  ) {
    throw new Error(`Local network destination is not allowed: ${hostname}`);
  }

  if (net.isIP(normalized) !== 0) {
    if (!isPublicInternetAddress(normalized)) {
      throw new Error(`Non-public destination is not allowed: ${hostname}`);
    }
    return {
      address: normalized,
      family: net.isIP(normalized) as 4 | 6,
    };
  }

  const addresses = await lookup(normalized, { all: true, verbatim: true });
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !isPublicInternetAddress(address))
  ) {
    throw new Error(`Destination does not resolve exclusively to public addresses: ${hostname}`);
  }
  const selected = addresses[0];
  if (!selected) {
    throw new Error(`Destination did not resolve: ${hostname}`);
  }
  return { address: selected.address, family: selected.family === 6 ? 6 : 4 };
}

export async function resolveAnyTarget(hostname: string): Promise<ResolvedTarget> {
  const normalized = normalizeHostname(hostname);
  if (normalized.length === 0) throw new Error("Empty network destination");
  const family = net.isIP(normalized);
  if (family !== 0) return { address: normalized, family: family as 4 | 6 };
  const addresses = await lookup(normalized, { all: true, verbatim: true });
  const selected = addresses[0];
  if (!selected) throw new Error(`Destination did not resolve: ${hostname}`);
  return { address: selected.address, family: selected.family === 6 ? 6 : 4 };
}

function authorized(request: IncomingMessage, token: string): boolean {
  const supplied = request.headers["proxy-authorization"];
  if (typeof supplied !== "string" || !supplied.startsWith("Basic ")) {
    return false;
  }
  const expected = Buffer.from(`pioneer:${token}`).toString("base64");
  const actual = supplied.slice("Basic ".length);
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function reject(response: ServerResponse, status: number, message: string): void {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(`${message}\n`);
}

interface ProxyLifecycle {
  closing: boolean;
  readonly sockets: Set<net.Socket>;
  readonly requests: Set<http.ClientRequest>;
}

function trackSocket(lifecycle: ProxyLifecycle, socket: net.Socket): void {
  lifecycle.sockets.add(socket);
  socket.once("close", () => lifecycle.sockets.delete(socket));
  if (lifecycle.closing) socket.destroy();
}

function trackRequest(lifecycle: ProxyLifecycle, request: http.ClientRequest): void {
  lifecycle.requests.add(request);
  request.once("close", () => lifecycle.requests.delete(request));
  request.on("socket", (socket) => trackSocket(lifecycle, socket));
  if (lifecycle.closing) request.destroy();
}

async function forwardHttp(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  resolveTarget: EgressTargetResolver,
  lifecycle: ProxyLifecycle,
): Promise<void> {
  if (lifecycle.closing) {
    request.destroy();
    response.destroy();
    return;
  }
  if (!authorized(request, token)) {
    reject(response, 407, "Proxy authentication required");
    return;
  }

  let target: URL;
  try {
    target = new URL(request.url ?? "");
  } catch {
    reject(response, 400, "Absolute public URL required");
    return;
  }
  if (target.protocol !== "http:") {
    reject(response, 400, "Use CONNECT for non-HTTP targets");
    return;
  }

  try {
    const resolved = await resolveTarget(target.hostname);
    if (lifecycle.closing) {
      request.destroy();
      response.destroy();
      return;
    }
    const headers = { ...request.headers, host: target.host };
    delete headers["proxy-authorization"];
    const upstream = http.request(
      {
        host: resolved.address,
        family: resolved.family,
        port: target.port === "" ? 80 : Number(target.port),
        method: request.method,
        path: `${target.pathname}${target.search}`,
        headers,
      },
      (upstreamResponse) => {
        if (lifecycle.closing || response.destroyed) {
          upstreamResponse.resume();
          return;
        }
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.statusMessage,
          upstreamResponse.headers,
        );
        upstreamResponse.pipe(response);
      },
    );
    trackRequest(lifecycle, upstream);
    upstream.on("error", (error) => reject(response, 502, error.message));
    if (lifecycle.closing) {
      upstream.destroy();
      request.destroy();
      response.destroy();
    } else {
      request.pipe(upstream);
    }
  } catch (error) {
    reject(response, 403, error instanceof Error ? error.message : "Destination denied");
  }
}

async function forwardConnect(
  request: IncomingMessage,
  client: Duplex,
  head: Buffer,
  token: string,
  resolveTarget: EgressTargetResolver,
  lifecycle: ProxyLifecycle,
): Promise<void> {
  if (lifecycle.closing) {
    client.destroy();
    return;
  }
  if (!authorized(request, token)) {
    client.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
    return;
  }

  const authority = request.url ?? "";
  const separator = authority.lastIndexOf(":");
  if (separator <= 0) {
    client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  const hostname = authority.slice(0, separator);
  const port = Number(authority.slice(separator + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }

  try {
    const resolved = await resolveTarget(hostname);
    if (lifecycle.closing) {
      client.destroy();
      return;
    }
    const upstream = net.connect({
      host: resolved.address,
      family: resolved.family,
      port,
    });
    trackSocket(lifecycle, upstream);
    upstream.once("connect", () => {
      if (lifecycle.closing) {
        upstream.destroy();
        client.destroy();
        return;
      }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        upstream.write(head);
      }
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", (error) => {
      if (process.env.PIONEER_DEBUG)
        console.error(`[PioneerProxy] CONNECT upstream: ${error.message}`);
      client.destroy();
    });
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
  } catch (error) {
    if (process.env.PIONEER_DEBUG) {
      console.error(
        `[PioneerProxy] CONNECT rejected: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  }
}

export async function startPublicEgressProxy(token: string): Promise<PublicEgressProxy> {
  return startEgressProxy(token, resolvePublicTarget);
}

export async function startEgressProxy(
  token: string,
  resolveTarget: EgressTargetResolver,
): Promise<PublicEgressProxy> {
  if (token.length < 32) {
    throw new Error("Public egress proxy token must contain at least 32 characters");
  }
  const lifecycle: ProxyLifecycle = {
    closing: false,
    sockets: new Set(),
    requests: new Set(),
  };
  const server = http.createServer((request, response) => {
    void forwardHttp(request, response, token, resolveTarget, lifecycle);
  });
  server.on("connection", (socket) => {
    trackSocket(lifecycle, socket);
  });
  server.on("connect", (request, socket, head) => {
    void forwardConnect(request, socket, head, token, resolveTarget, lifecycle);
  });
  await new Promise<void>((resolve, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectPromise);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Public egress proxy did not bind a TCP port");
  }
  let closePromise: Promise<void> | undefined;
  return {
    url: `http://pioneer:${token}@127.0.0.1:${address.port}`,
    close: () => {
      closePromise ??= (async () => {
        lifecycle.closing = true;
        for (const request of lifecycle.requests) request.destroy();
        for (const socket of lifecycle.sockets) socket.destroy();
        await new Promise<void>((resolve, rejectPromise) =>
          server.close((error) => (error === undefined ? resolve() : rejectPromise(error))),
        );
        while (lifecycle.requests.size > 0 || lifecycle.sockets.size > 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      })();
      return closePromise;
    },
  };
}
