import { spawn } from "node:child_process";
import net from "node:net";

const [socketPath, executable, ...args] = process.argv.slice(2);
if (!socketPath || !executable) {
  process.stderr.write("Linux network supervisor requires a proxy socket and command\n");
  process.exit(2);
}

const connections = new Set<net.Socket>();
const server = net.createServer((downstream) => {
  const upstream = net.connect(socketPath);
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

server.once("error", (error) => {
  process.stderr.write(`Linux network supervisor failed: ${error.message}\n`);
  process.exit(125);
});
server.listen(3128, "127.0.0.1", () => {
  const child = spawn(executable, args, { env: process.env, shell: false, stdio: "inherit" });
  const forward = (signal: NodeJS.Signals): void => {
    if (!child.killed) child.kill(signal);
  };
  process.once("SIGINT", () => forward("SIGINT"));
  process.once("SIGTERM", () => forward("SIGTERM"));
  child.once("error", (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 127;
    server.close();
  });
  child.once("exit", (code, signal) => {
    for (const connection of connections) connection.destroy();
    server.close(() => {
      if (signal) process.kill(process.pid, signal);
      else process.exit(code ?? 1);
    });
  });
});
