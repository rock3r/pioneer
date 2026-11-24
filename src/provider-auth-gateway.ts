import { randomBytes, timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type EgressTargetResolver, resolvePublicTarget } from "./eval-run/public-egress-proxy.js";

type AuthHeader = "authorization" | "x-api-key";
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const AUTH_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "proxy-authorization",
]);

export interface ProviderAuthRoute {
  readonly upstream: URL;
  readonly suffix: string;
  readonly optionalQuery?: "beta=true";
  readonly model: string;
  readonly actorHeader: AuthHeader;
  readonly upstreamHeader: AuthHeader;
  readonly credential: () => Promise<string>;
}

export interface ProviderAuthGateway {
  readonly baseUrl: string;
  readonly port: number;
  readonly placeholder: string;
  close(): Promise<void>;
}

function reject(response: ServerResponse, status: number): void {
  if (!response.headersSent && !response.destroyed) {
    response.writeHead(status, { "content-type": "application/json" });
    response.end('{"error":{"message":"Controller provider request failed"}}');
  }
}

function headerValue(header: AuthHeader, key: string): string {
  return header === "authorization" ? `Bearer ${key}` : key;
}

function hasExpectedHeader(
  request: IncomingMessage,
  header: AuthHeader,
  placeholder: string,
): boolean {
  const supplied = request.headersDistinct[header];
  if (supplied?.length !== 1 || supplied[0] === undefined) return false;
  const expected = Buffer.from(headerValue(header, placeholder));
  const actual = Buffer.from(supplied[0]);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
  return Object.entries(request.headersDistinct).every(
    ([name, values]) =>
      name === header ||
      (!AUTH_HEADERS.has(name) && !values?.some((value) => value.includes(placeholder))),
  );
}

async function readModelRequest(
  request: IncomingMessage,
  expectedModel: string,
): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) return undefined;
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks, bytes);
  try {
    const payload: unknown = JSON.parse(body.toString("utf8"));
    if (
      typeof payload === "object" &&
      payload !== null &&
      "model" in payload &&
      payload.model === expectedModel
    )
      return Buffer.from(JSON.stringify(payload));
  } catch {
    // Malformed requests cannot use the credential.
  }
  return undefined;
}

function redactResponse(key: string): Transform {
  const needle = Buffer.from(key);
  let pending = Buffer.alloc(0);
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      pending = Buffer.concat([pending, chunk]);
      for (let index = pending.indexOf(needle); index >= 0; index = pending.indexOf(needle)) {
        this.push(pending.subarray(0, index));
        this.push("[REDACTED]");
        pending = pending.subarray(index + needle.length);
      }
      const safeBytes = Math.max(0, pending.length + 1 - needle.length);
      this.push(pending.subarray(0, safeBytes));
      pending = pending.subarray(safeBytes);
      done();
    },
    flush(done) {
      done(null, pending);
    },
  });
}

export async function startProviderAuthGateway(
  route: ProviderAuthRoute,
  resolve: EgressTargetResolver = resolvePublicTarget,
  send: (
    options: https.RequestOptions,
    response: (result: IncomingMessage) => void,
  ) => http.ClientRequest = https.request,
): Promise<ProviderAuthGateway> {
  const upstream = new URL(route.upstream);
  const pinned = await resolve(upstream.hostname, 443).catch(() => {
    throw new Error(
      "[PI_CONTROLLER_PROVIDER_AUTH_UNSUPPORTED] The configured provider host must resolve to public addresses",
    );
  });
  const placeholder = randomBytes(32).toString("hex");
  const routePrefix = `/${randomBytes(24).toString("hex")}`;
  const requestPath = `${routePrefix}${route.suffix}`;
  const requests = new Set<http.ClientRequest>();
  let port = 0;
  let closed = false;
  const server = http.createServer(
    { headersTimeout: 5_000, requestTimeout: 30_000 },
    (request, response) => {
      void (async () => {
        const query =
          route.optionalQuery !== undefined &&
          request.url === `${requestPath}?${route.optionalQuery}`
            ? `?${route.optionalQuery}`
            : "";
        if (
          request.method !== "POST" ||
          request.url !== `${requestPath}${query}` ||
          request.headers.host !== `127.0.0.1:${port}`
        ) {
          reject(response, 404);
          return;
        }
        if (!hasExpectedHeader(request, route.actorHeader, placeholder)) {
          reject(response, 401);
          return;
        }
        const body = await readModelRequest(request, route.model);
        if (body === undefined) {
          reject(response, 400);
          return;
        }
        const credential = await route.credential();
        if (closed || response.destroyed) return;
        const headers: Record<string, string | number> = {
          host: upstream.host,
          "content-type": "application/json",
          "content-length": body.length,
          "accept-encoding": "identity",
          [route.upstreamHeader]: headerValue(route.upstreamHeader, credential),
        };
        for (const name of ["anthropic-version", "anthropic-beta"]) {
          const value = request.headers[name];
          if (typeof value === "string") headers[name] = value;
        }
        const outgoing = send(
          {
            host: pinned.address,
            family: pinned.family,
            port: 443,
            servername: upstream.hostname,
            rejectUnauthorized: true,
            method: "POST",
            path: `${upstream.pathname.replace(/\/$/, "")}${route.suffix}${query}`,
            headers,
            agent: false,
          },
          (result) => {
            const status = result.statusCode ?? 502;
            const encoding = result.headers["content-encoding"];
            if (
              (status >= 300 && status < 400) ||
              (encoding !== undefined && encoding !== "identity")
            ) {
              result.destroy();
              reject(response, 502);
              return;
            }
            const type =
              result.headers["content-type"]?.startsWith("text/event-stream") === true
                ? "text/event-stream"
                : "application/json";
            response.writeHead(status, { "content-type": type });
            void pipeline(result, redactResponse(credential), response).catch(() =>
              response.destroy(),
            );
          },
        );
        requests.add(outgoing);
        outgoing.once("error", () => {
          if (response.headersSent) response.destroy();
          else reject(response, 502);
        });
        outgoing.once("close", () => requests.delete(outgoing));
        response.once("close", () => outgoing.destroy());
        outgoing.end(body);
      })().catch(() => reject(response, 502));
    },
  );
  server.maxConnections = 16;
  await new Promise<void>((bound, failure) => {
    server.once("error", failure);
    server.listen(0, "127.0.0.1", bound);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error(
      "[PI_CONTROLLER_PROVIDER_AUTH_UNSUPPORTED] Could not bind the private provider gateway",
    );
  }
  port = address.port;
  let closeResult: Promise<void> | undefined;
  return {
    baseUrl: `http://127.0.0.1:${port}${routePrefix}`,
    port,
    placeholder,
    close: () => {
      closeResult ??= new Promise<void>((done, failure) => {
        closed = true;
        for (const request of requests) request.destroy();
        server.close((error) => (error === undefined ? done() : failure(error)));
        server.closeAllConnections();
      });
      return closeResult;
    },
  };
}
