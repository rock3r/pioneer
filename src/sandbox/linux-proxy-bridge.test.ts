import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startLinuxProxyBridge } from "./linux-proxy-bridge.js";

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
      const root = await mkdtemp(path.join(tmpdir(), "pioneer-bridge-test-"));
      cleanups.push(() => rm(root, { recursive: true, force: true }));
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
});
