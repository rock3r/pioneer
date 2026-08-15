import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  type PublicEgressProxy,
  type ResolvedTarget,
  resolvePublicTarget,
  startEgressProxy,
  startPublicEgressProxy,
} from "./public-egress-proxy.js";

function requestThrough(
  proxy: PublicEgressProxy,
  target: string,
  authorization?: string,
): Promise<number> {
  const proxyUrl = new URL(proxy.url);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: proxyUrl.hostname,
      port: Number(proxyUrl.port),
      method: "GET",
      path: target,
      headers: authorization ? { "proxy-authorization": authorization } : undefined,
    });
    request.once("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once("error", reject);
    request.end();
  });
}

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind");
  return address.port;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for proxy lifecycle state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("public egress proxy", () => {
  let proxy: PublicEgressProxy | undefined;
  afterEach(async () => {
    await proxy?.close();
    proxy = undefined;
  });

  it("requires its per-run authentication token", async () => {
    proxy = await startPublicEgressProxy("a".repeat(32));
    expect(await requestThrough(proxy, "http://example.com/")).toBe(407);
  });

  it("rejects authenticated requests to loopback before connecting", async () => {
    const token = "b".repeat(32);
    proxy = await startPublicEgressProxy(token);
    const authorization = `Basic ${Buffer.from(`pioneer:${token}`).toString("base64")}`;
    expect(await requestThrough(proxy, "http://127.0.0.1:9/", authorization)).toBe(403);
  });

  it("closes promptly while a client socket is still connected", async () => {
    proxy = await startPublicEgressProxy("c".repeat(32));
    const proxyUrl = new URL(proxy.url);
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const client = new net.Socket();
      client.once("error", reject);
      client.connect(Number(proxyUrl.port), proxyUrl.hostname, () => resolve(client));
    });
    const started = performance.now();
    await proxy.close();
    expect(performance.now() - started).toBeLessThan(500);
    socket.destroy();
    proxy = undefined;
  });

  it("closes CONNECT upstreams and does not create one after shutdown begins", async () => {
    const upstreamSockets = new Set<net.Socket>();
    const upstreamServer = net.createServer((socket) => {
      upstreamSockets.add(socket);
      socket.once("close", () => upstreamSockets.delete(socket));
    });
    const upstreamPort = await listen(upstreamServer);
    let releaseResolution: ((target: ResolvedTarget) => void) | undefined;
    let resolutionCount = 0;
    const resolveTarget = async (): Promise<ResolvedTarget> => {
      resolutionCount += 1;
      if (resolutionCount === 1) return { address: "127.0.0.1", family: 4 };
      return await new Promise((resolve) => {
        releaseResolution = resolve;
      });
    };
    proxy = await startEgressProxy("d".repeat(32), resolveTarget);
    const proxyUrl = new URL(proxy.url);
    const client = net.createConnection(Number(proxyUrl.port), proxyUrl.hostname);
    client.write(
      `CONNECT target.test:${upstreamPort} HTTP/1.1\r\nHost: target.test:${upstreamPort}\r\nProxy-Authorization: Basic ${Buffer.from(`pioneer:${"d".repeat(32)}`).toString("base64")}\r\n\r\n`,
    );
    await waitFor(() => upstreamSockets.size === 1);

    const secondClient = net.createConnection(Number(proxyUrl.port), proxyUrl.hostname);
    secondClient.write(
      `CONNECT target.test:${upstreamPort} HTTP/1.1\r\nHost: target.test:${upstreamPort}\r\nProxy-Authorization: Basic ${Buffer.from(`pioneer:${"d".repeat(32)}`).toString("base64")}\r\n\r\n`,
    );
    await waitFor(() => resolutionCount === 2);
    const closing = proxy.close();
    releaseResolution?.({ address: "127.0.0.1", family: 4 });
    await closing;
    await waitFor(() => upstreamSockets.size === 0);
    client.destroy();
    secondClient.destroy();
    proxy = undefined;
    await new Promise<void>((resolve, reject) =>
      upstreamServer.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("closes HTTP upstream sockets during shutdown", async () => {
    const upstreamSockets = new Set<net.Socket>();
    const upstreamServer = http.createServer((_request, response) => {
      const socket = response.socket;
      if (socket !== null) {
        upstreamSockets.add(socket);
        socket.once("close", () => upstreamSockets.delete(socket));
      }
      // Keep the response open so proxy.close() must destroy the upstream socket.
    });
    const upstreamPort = await listen(upstreamServer);
    const token = "e".repeat(32);
    proxy = await startEgressProxy(token, async () => ({ address: "127.0.0.1", family: 4 }));
    const proxyUrl = new URL(proxy.url);
    const request = http.request({
      host: proxyUrl.hostname,
      port: Number(proxyUrl.port),
      path: `http://target.test:${upstreamPort}/held-open`,
      headers: {
        "proxy-authorization": `Basic ${Buffer.from(`pioneer:${token}`).toString("base64")}`,
      },
    });
    request.on("error", () => undefined);
    request.end();
    await waitFor(() => upstreamSockets.size === 1);
    await proxy.close();
    await waitFor(() => upstreamSockets.size === 0);
    request.destroy();
    proxy = undefined;
    await new Promise<void>((resolve, reject) =>
      upstreamServer.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it.each(["localhost", "printer.lan", "10.0.0.1", "fc00::1"])(
    "rejects non-public target %s",
    async (target) => {
      await expect(resolvePublicTarget(target)).rejects.toThrow(/not allowed/i);
    },
  );
});
