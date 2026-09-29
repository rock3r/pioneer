import { spawn } from "node:child_process";
import net from "node:net";

const [socketPath, ...rest] = process.argv.slice(2);
// The controller places `--loopback PORT:SOCKET` pairs before the canonical absolute
// actor executable, so the first non-flag entry is always the command.
const loopbackRelays: { port: number; socketPath: string }[] = [];
while (rest[0] === "--loopback") {
  const [, spec = ""] = rest.splice(0, 2);
  const separator = spec.indexOf(":");
  const port = Number(spec.slice(0, separator));
  const relaySocket = spec.slice(separator + 1);
  if (separator < 1 || !Number.isInteger(port) || port < 1 || port > 65_535 || !relaySocket) {
    process.stderr.write("Linux network supervisor received an invalid loopback relay\n");
    process.exit(2);
  }
  loopbackRelays.push({ port, socketPath: relaySocket });
}
const [executable, ...args] = rest;
if (!socketPath || !executable) {
  process.stderr.write("Linux network supervisor requires a proxy socket and command\n");
  process.exit(2);
}

const connections = new Set<net.Socket>();
function relayTo(upstreamSocketPath: string): net.Server {
  return net.createServer((downstream) => {
    const upstream = net.connect(upstreamSocketPath);
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
}

async function listen(server: net.Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

const servers = [relayTo(socketPath), ...loopbackRelays.map((relay) => relayTo(relay.socketPath))];
try {
  await listen(servers[0] as net.Server, 3128);
  for (const [index, relay] of loopbackRelays.entries()) {
    await listen(servers[index + 1] as net.Server, relay.port);
  }
} catch (error) {
  process.stderr.write(
    `Linux network supervisor failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(125);
}

const closeServers = async (): Promise<void> => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
};
const child = spawn(executable, args, { env: process.env, shell: false, stdio: "inherit" });
const forward = (signal: NodeJS.Signals): void => {
  if (!child.killed) child.kill(signal);
};
process.once("SIGINT", () => forward("SIGINT"));
process.once("SIGTERM", () => forward("SIGTERM"));
child.once("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 127;
  void closeServers();
});
child.once("exit", (code, signal) => {
  for (const connection of connections) connection.destroy();
  void closeServers().then(() => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
});
