import { chmod, unlink } from "node:fs/promises";
import net from "node:net";

export interface LinuxProxyBridge {
  readonly socketPath: string;
  close(): Promise<void>;
}

export async function startLinuxProxyBridge(
  proxyUrl: string,
  socketPath: string,
): Promise<LinuxProxyBridge> {
  const target = new URL(proxyUrl);
  const port = Number(target.port);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || !Number.isInteger(port)) {
    throw new Error("Linux sandbox bridge target must be a loopback HTTP proxy");
  }
  await unlink(socketPath).catch(() => undefined);
  const connections = new Set<net.Socket>();
  const server = net.createServer((downstream) => {
    const upstream = net.connect({ host: "127.0.0.1", port });
    connections.add(downstream);
    connections.add(upstream);
    const discard = (): void => {
      connections.delete(downstream);
      connections.delete(upstream);
    };
    downstream.on("close", discard);
    upstream.on("close", discard);
    downstream.on("error", () => upstream.destroy());
    upstream.on("error", () => downstream.destroy());
    downstream.pipe(upstream);
    upstream.pipe(downstream);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o600);
  return {
    socketPath,
    close: async () => {
      for (const connection of connections) connection.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      await unlink(socketPath).catch(() => undefined);
    },
  };
}
