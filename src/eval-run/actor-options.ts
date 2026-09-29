import { diagnosticMessage } from "../diagnostics.js";

/** Bubblewrap's in-namespace supervisor listens here to relay the authenticated proxy. */
export const LINUX_PROXY_RELAY_PORT = 3128;

const LOOPBACK_TARGET = /^(127\.0\.0\.1|localhost):([1-9][0-9]{0,4})$/;

function invalidLoopbackTarget(value: string, reason: string): Error {
  return new Error(
    diagnosticMessage(
      "EVAL_LOOPBACK_TARGET_INVALID",
      `--allow-loopback ${JSON.stringify(value)} ${reason}`,
    ),
  );
}

/**
 * Parses repeated `--allow-loopback HOST:PORT` values into exact ports. Only IPv4 loopback
 * (`127.0.0.1`, or `localhost` as its alias) is accepted, and each value names one port.
 */
export function parseLoopbackTargets(
  values: readonly string[],
  platform: NodeJS.Platform = process.platform,
): number[] {
  const ports: number[] = [];
  for (const value of values) {
    const match = LOOPBACK_TARGET.exec(value);
    const port = Number(match?.[2]);
    if (match === null || !Number.isSafeInteger(port) || port > 65_535) {
      throw invalidLoopbackTarget(
        value,
        "must be 127.0.0.1:PORT or localhost:PORT with one port from 1 to 65535",
      );
    }
    if (platform === "linux" && port === LINUX_PROXY_RELAY_PORT) {
      throw invalidLoopbackTarget(
        value,
        `uses port ${LINUX_PROXY_RELAY_PORT}, which the Linux sandbox reserves for its proxy relay`,
      );
    }
    if (!ports.includes(port)) ports.push(port);
  }
  return ports;
}

export function formatLoopbackTarget(port: number): string {
  return `127.0.0.1:${port}`;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ACTOR_ENV_ENTRIES = 64;
const MAX_ACTOR_ENV_VALUE_BYTES = 32 * 1024;
// Well below common execve limits once Pioneer's own variables and argv are added.
const MAX_ACTOR_ENV_TOTAL_BYTES = 256 * 1024;
// Pioneer owns these: the sanitized platform runtime, the isolated home and scratch, proxy
// mediation, and Node preloading, which could bypass Pi's tool-stripping adapter.
const RESERVED_ACTOR_ENV_NAMES = new Set(
  [
    "PATH",
    "PATHEXT",
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "SSL_CERT_FILE",
    "OPENSSL_CONF",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "NODE_OPTIONS",
  ].map((name) => name.toUpperCase()),
);
const RESERVED_ACTOR_ENV_PREFIXES = ["PI_", "PIONEER_"] as const;

function invalidActorEnvironment(message: string): Error {
  return new Error(diagnosticMessage("EVAL_ACTOR_ENV_INVALID", message));
}

/**
 * Parses repeated `--env NAME=VALUE` values. Values are passed only to the sandboxed actor
 * and are never echoed in diagnostics or work logs.
 */
export function parseActorEnvironment(values: readonly string[]): Record<string, string> {
  if (values.length > MAX_ACTOR_ENV_ENTRIES) {
    throw invalidActorEnvironment(`--env accepts at most ${MAX_ACTOR_ENV_ENTRIES} variables`);
  }
  const environment: Record<string, string> = {};
  let totalBytes = 0;
  for (const entry of values) {
    const separator = entry.indexOf("=");
    const name = separator < 0 ? "" : entry.slice(0, separator);
    const value = separator < 0 ? "" : entry.slice(separator + 1);
    if (!ENV_NAME.test(name)) {
      throw invalidActorEnvironment(
        "--env values must be NAME=VALUE with a name of letters, digits and underscores that does not start with a digit",
      );
    }
    const folded = name.toUpperCase();
    if (
      RESERVED_ACTOR_ENV_NAMES.has(folded) ||
      RESERVED_ACTOR_ENV_PREFIXES.some((prefix) => folded.startsWith(prefix))
    ) {
      throw invalidActorEnvironment(
        `--env ${name} would override a variable Pioneer controls for the sandboxed actor`,
      );
    }
    if (value.includes("\0") || Buffer.byteLength(value) > MAX_ACTOR_ENV_VALUE_BYTES) {
      throw invalidActorEnvironment(
        `--env ${name} must not contain NUL or exceed ${MAX_ACTOR_ENV_VALUE_BYTES} bytes`,
      );
    }
    if (Object.hasOwn(environment, name)) {
      throw invalidActorEnvironment(`--env ${name} is given more than once`);
    }
    // NAME=VALUE plus the terminating NUL, as the entry occupies the process environment.
    totalBytes += Buffer.byteLength(entry) + 1;
    if (totalBytes > MAX_ACTOR_ENV_TOTAL_BYTES) {
      throw invalidActorEnvironment(
        `--env variables must not exceed ${MAX_ACTOR_ENV_TOTAL_BYTES} bytes in total`,
      );
    }
    environment[name] = value;
  }
  return environment;
}
