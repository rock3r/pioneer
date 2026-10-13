import { reportableName } from "./pi-extension-policy.js";

interface RejectionTarget {
  on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
  listenerCount(event: "unhandledRejection"): number;
}

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const MAX_WARNINGS = 8;

/**
 * The exact warning text the adapter writes. Controllers accept only this format from the
 * untrusted stderr stream; the package name uses the same safe character set as the guard.
 */
export const SUBPROCESS_DENIED_WARNING =
  /^\[PI_EXTENSION_SUBPROCESS_DENIED\] (?:An extension|Extension [A-Za-z0-9@._~/+-]{1,160}) tried to start a subprocess, which the sandbox denies\. Pioneer kept Pi running; extension features that need subprocesses are unavailable\.$/;

function subprocessDenialWarning(name: string | undefined): string {
  return `[PI_EXTENSION_SUBPROCESS_DENIED] ${name === undefined ? "An extension" : `Extension ${name}`} tried to start a subprocess, which the sandbox denies. Pioneer kept Pi running; extension features that need subprocesses are unavailable.`;
}

/** Distinct validated warnings from complete stderr text, at most eight. */
export function subprocessDenialWarnings(stderr: string): string[] {
  const warnings = new Set<string>();
  for (const line of stderr.split("\n")) {
    const warning = line.trim();
    if (SUBPROCESS_DENIED_WARNING.test(warning)) warnings.add(warning);
    if (warnings.size >= MAX_WARNINGS) break;
  }
  return [...warnings];
}

/** Seatbelt refuses process creation with EPERM; Node then throws from `spawn` itself. */
export function isSandboxSubprocessDenial(reason: unknown): reason is Error {
  if (typeof reason !== "object" || reason === null) return false;
  const { code, syscall } = reason as { code?: unknown; syscall?: unknown };
  return code === "EPERM" && typeof syscall === "string" && syscall.startsWith("spawn");
}

/** The first npm package in the stack other than Pi itself, for example `pi-subagents`. */
function stackPackage(stack: unknown): string | undefined {
  if (typeof stack !== "string") return undefined;
  for (const match of stack
    .replaceAll("\\", "/")
    .matchAll(/\/node_modules\/((?:@[^/\s]+\/)?[^/\s:)]+)\//g)) {
    const name = match[1];
    if (name !== undefined && name !== PI_PACKAGE) return reportableName(name);
  }
  return undefined;
}

/**
 * Keeps one extension's failed background subprocess from stopping Pi. An extension that
 * starts a child without handling a synchronous spawn failure leaves an unhandled rejection,
 * and Node's default for that is to exit. The sandbox denial is the expected outcome, so it
 * becomes a warning. Every other rejection keeps Node's default crash, unless Pi or an
 * extension installed its own handler.
 */
export function containSandboxSubprocessDenials(
  target: RejectionTarget,
  write: (text: string) => void,
): void {
  const reported = new Set<string>();
  target.on("unhandledRejection", (reason) => {
    if (isSandboxSubprocessDenial(reason)) {
      const name = stackPackage(reason.stack);
      const message = `${subprocessDenialWarning(name)}\n`;
      if (!reported.has(message)) {
        reported.add(message);
        write(message);
      }
      return;
    }
    if (target.listenerCount("unhandledRejection") > 1) return;
    throw reason;
  });
}
