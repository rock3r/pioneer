import path from "node:path";
import { fileURLToPath } from "node:url";

export interface SandboxPolicy {
  readonly readOnlyPaths: readonly string[];
  readonly writablePaths: readonly string[];
  readonly network: "proxy" | "none";
  readonly proxyUrl?: string;
  readonly allowProcessFork?: boolean;
  /** Exact host loopback ports the actor may reach directly, bypassing the proxy. */
  readonly loopbackPorts?: readonly number[];
}

export interface LinuxLoopbackRelay {
  readonly port: number;
  readonly socketPath: string;
}

/** Keep in sync with LINUX_PROXY_RELAY_PORT; the supervisor listens there in the namespace. */
const LINUX_PROXY_RELAY_PORT = 3128;

export interface SandboxLaunch {
  readonly argv: readonly [string, ...string[]];
  readonly environment: Readonly<Record<string, string>>;
  readonly profile?: string;
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

function parsedProxy(policy: SandboxPolicy): URL | undefined {
  if (policy.network === "none") return undefined;
  if (policy.proxyUrl === undefined) throw new Error("Sandbox proxy policy is missing its URL");
  const parsed = new URL(policy.proxyUrl);
  const port = Number(parsed.port);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.username.length === 0 ||
    parsed.password.length === 0 ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error("Sandbox proxy must be an authenticated loopback HTTP URL");
  }
  return parsed;
}

function loopbackPorts(policy: SandboxPolicy): readonly number[] {
  const ports = policy.loopbackPorts ?? [];
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`Sandbox loopback port is invalid: ${port}`);
    }
  }
  return ports;
}

function proxyEnvironment(
  proxyUrl: string | undefined,
  directLoopback = false,
): Readonly<Record<string, string>> {
  if (proxyUrl === undefined) {
    return {
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      ALL_PROXY: "",
      http_proxy: "",
      https_proxy: "",
      all_proxy: "",
      NO_PROXY: "",
      no_proxy: "",
    };
  }
  // The proxy refuses loopback, so proxy-aware clients must reach allowed ports directly;
  // the sandbox, not this hint, confines them to those ports.
  const noProxy = directLoopback ? "127.0.0.1,localhost" : "";
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    ALL_PROXY: "",
    all_proxy: "",
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}

export function buildMacosSandboxArgv(
  policy: SandboxPolicy,
  command: readonly [string, ...string[]],
): SandboxLaunch & { readonly profile: string } {
  const port = parsedProxy(policy)?.port;
  const directPorts = loopbackPorts(policy);
  const readable = [...new Set([...policy.readOnlyPaths, ...policy.writablePaths])];
  const readableAncestors = ancestorDirectories(readable);
  const profile = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    ...(policy.allowProcessFork === false ? [] : ["(allow process-fork)"]),
    "(allow process-info* (target same-sandbox))",
    "(allow signal (target same-sandbox))",
    "(allow mach-priv-task-port (target same-sandbox))",
    "(allow ipc-posix-shm)",
    "(allow ipc-posix-sem)",
    "(allow sysctl-read)",
    '(allow file-read* (literal "/"))',
    ...readableAncestors.map((entry) => `(allow file-read-metadata (literal ${quoted(entry)}))`),
    ...readable.map((entry) => `(allow file-read* (subpath ${quoted(entry)}))`),
    ...policy.writablePaths.map((entry) => `(allow file-write* (subpath ${quoted(entry)}))`),
    // libuv's posix_spawn opens /dev/null for every ignored stdio slot, and Git and shell
    // redirections open it read-write. It is a sink, so allowing it exposes nothing.
    '(allow file-read* file-write* (literal "/dev/null"))',
    '(allow file-ioctl (literal "/dev/null"))',
    '(allow file-ioctl (literal "/dev/zero"))',
    '(allow file-ioctl (literal "/dev/random"))',
    '(allow file-ioctl (literal "/dev/urandom"))',
    '(allow mach-lookup (global-name "com.apple.logd"))',
    '(allow mach-lookup (global-name "com.apple.system.logger"))',
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))',
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.membership"))',
    '(allow mach-lookup (global-name "com.apple.SecurityServer"))',
    ...(port === undefined ? [] : [`(allow network-outbound (remote ip "localhost:${port}"))`]),
    ...directPorts.map((entry) => `(allow network-outbound (remote ip "localhost:${entry}"))`),
  ].join("\n");
  return {
    argv: ["/usr/bin/sandbox-exec", "-p", profile, ...command],
    environment: proxyEnvironment(policy.proxyUrl, directPorts.length > 0),
    profile,
  };
}

function ancestorDirectories(entries: readonly string[]): string[] {
  const result = new Set<string>();
  for (const entry of entries) {
    let current = path.dirname(entry);
    while (current !== path.parse(current).root) {
      result.add(current);
      current = path.dirname(current);
    }
  }
  return [...result].sort((left, right) => left.length - right.length);
}

export function buildLinuxSandboxArgv(
  policy: SandboxPolicy,
  command: readonly [string, ...string[]],
  bwrapPath: string,
  proxySocketPath?: string,
  runtimeExecutable?: string,
  loopbackRelays: readonly LinuxLoopbackRelay[] = [],
): SandboxLaunch {
  const proxy = parsedProxy(policy);
  if (policy.network === "proxy" && proxySocketPath === undefined) {
    throw new Error("Linux proxy sandbox is missing its Unix bridge socket");
  }
  const relays = loopbackPorts(policy).map((port) => {
    if (port === LINUX_PROXY_RELAY_PORT) {
      throw new Error(`Linux sandbox reserves loopback port ${LINUX_PROXY_RELAY_PORT}`);
    }
    const relay = loopbackRelays.find((entry) => entry.port === port);
    if (relay === undefined || proxySocketPath === undefined) {
      throw new Error(`Linux loopback port ${port} is missing its relay socket`);
    }
    return relay;
  });
  const supervisorPath = fileURLToPath(new URL("./linux-network-supervisor.js", import.meta.url));
  const paths = [
    ...policy.readOnlyPaths,
    ...policy.writablePaths,
    ...(proxySocketPath === undefined ? [] : [proxySocketPath]),
    ...(proxySocketPath === undefined ? [] : [supervisorPath]),
    ...(runtimeExecutable === undefined ? [] : [runtimeExecutable]),
    ...relays.map((relay) => relay.socketPath),
  ];
  const libTarget = policy.readOnlyPaths.includes("/usr/lib") ? "usr/lib" : undefined;
  const lib64Target = policy.readOnlyPaths.includes("/usr/lib64") ? "usr/lib64" : libTarget;
  const runtimeLinkerAliases = [
    ...(libTarget !== undefined && !policy.readOnlyPaths.includes("/lib")
      ? ["--symlink", libTarget, "/lib"]
      : []),
    ...(lib64Target !== undefined && !policy.readOnlyPaths.includes("/lib64")
      ? ["--symlink", lib64Target, "/lib64"]
      : []),
    // A usrmerged /bin grant canonicalizes to /usr/bin; restore the alias so /bin/sh resolves.
    ...(policy.readOnlyPaths.includes("/usr/bin") && !policy.readOnlyPaths.includes("/bin")
      ? ["--symlink", "usr/bin", "/bin"]
      : []),
  ];
  const args: string[] = [
    // captureEvalProcess starts Bubblewrap detached, giving it the dedicated
    // session/process group used for containment and termination.
    "--die-with-parent",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-net",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    "--cap-drop",
    "ALL",
    "--tmpfs",
    "/",
    ...runtimeLinkerAliases,
    ...ancestorDirectories(paths).flatMap((entry) => ["--dir", entry]),
    ...policy.readOnlyPaths.flatMap((entry) => ["--ro-bind", entry, entry]),
    ...policy.writablePaths.flatMap((entry) => ["--bind", entry, entry]),
    ...(proxySocketPath === undefined ? [] : ["--ro-bind", proxySocketPath, proxySocketPath]),
    ...(proxySocketPath === undefined ? [] : ["--ro-bind", supervisorPath, supervisorPath]),
    ...relays.flatMap((relay) => ["--ro-bind", relay.socketPath, relay.socketPath]),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
  ];
  if (proxy !== undefined) proxy.port = "3128";
  const environment = proxyEnvironment(proxy?.toString(), relays.length > 0);
  if (proxySocketPath === undefined) {
    args.push("--", ...command);
  } else {
    args.push(
      "--",
      runtimeExecutable === undefined ? process.execPath : runtimeExecutable,
      supervisorPath,
      proxySocketPath,
      ...relays.flatMap((relay) => ["--loopback", `${relay.port}:${relay.socketPath}`]),
      ...command,
    );
  }
  return { argv: [bwrapPath, ...args], environment };
}
