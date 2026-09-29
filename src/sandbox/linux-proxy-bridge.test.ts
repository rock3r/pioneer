import http from "node:http";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerManagedTempPaths } from "../../test/support/temp-dir.js";
import { startLinuxLoopbackBridge, startLinuxProxyBridge } from "./linux-proxy-bridge.js";

const { createTempDir } = registerManagedTempPaths();

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("Linux proxy bridge", () => {
  it.skipIf(process.platform === "win32")(
    "relays bytes from a Unix socket only to the selected loopback proxy",
    async () => {
      const upstream = http.createServer((_request, response) => response.end("bridged"));
      await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
      cleanups.push(() => new Promise((resolve) => upstream.close(() => resolve())));
      const address = upstream.address();
      if (address === null || typeof address === "string") throw new Error("missing port");
      const root = await createTempDir("pioneer-bridge-test-");
      const socketPath = path.join(root, "proxy.sock");
      const bridge = await startLinuxProxyBridge(`http://127.0.0.1:${address.port}`, socketPath);
      cleanups.push(() => bridge.close());

      const response = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(socketPath);
        let bytes = "";
        socket.on("connect", () =>
          socket.write("GET / HTTP/1.1\r\nHost: example\r\nConnection: close\r\n\r\n"),
        );
        socket.on("data", (chunk) => (bytes += chunk.toString("utf8")));
        socket.on("end", () => resolve(bytes));
        socket.on("error", reject);
      });
      expect(response).toContain("bridged");
    },
  );

  it.skipIf(process.platform === "win32")(
    "relays a loopback bridge socket only to its one allowed host port (#88)",
    async () => {
      const upstream = net.createServer((socket) => socket.end("loopback-ok"));
      await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
      cleanups.push(() => new Promise((resolve) => upstream.close(() => resolve())));
      const address = upstream.address();
      if (address === null || typeof address === "string") throw new Error("missing port");
      const root = await createTempDir("pioneer-bridge-test-");
      const socketPath = path.join(root, "loopback.sock");
      const bridge = await startLinuxLoopbackBridge(address.port, socketPath);
      cleanups.push(() => bridge.close());

      const response = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(socketPath);
        let bytes = "";
        socket.on("data", (chunk) => (bytes += chunk.toString("utf8")));
        socket.on("end", () => resolve(bytes));
        socket.on("error", reject);
      });
      expect(response).toBe("loopback-ok");
    },
  );

  it.each([0, 65_536, 1.5])("rejects an invalid loopback bridge port: %s", async (port) => {
    await expect(startLinuxLoopbackBridge(port, "/unused.sock")).rejects.toThrow(/loopback port/i);
  });
});
