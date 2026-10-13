import { missingModule } from "./pi-extension-policy.js";
import { stackPackage } from "./pi-extension-subprocess-guard.js";

const ERROR_HEADER =
  /^(?:Uncaught\s+)?((?:[A-Z][A-Za-z]{0,40})?Error)(?:\s+\[(ERR_[A-Z0-9_]{1,60})\])?:/;
const ERRNO_CODES = new Set([
  "E2BIG",
  "EACCES",
  "EADDRINUSE",
  "EAGAIN",
  "EAI_AGAIN",
  "EBADF",
  "ECONNREFUSED",
  "ECONNRESET",
  "EEXIST",
  "EHOSTUNREACH",
  "EINVAL",
  "EISDIR",
  "ELOOP",
  "EMFILE",
  "ENAMETOOLONG",
  "ENETUNREACH",
  "ENFILE",
  "ENOENT",
  "ENOEXEC",
  "ENOMEM",
  "ENOSPC",
  "ENOTDIR",
  "ENOTFOUND",
  "EPERM",
  "EPIPE",
  "EROFS",
  "ETIMEDOUT",
]);
const SYSCALLS = new Set([
  "access",
  "bind",
  "chmod",
  "connect",
  "getaddrinfo",
  "kill",
  "listen",
  "lstat",
  "mkdir",
  "open",
  "read",
  "readlink",
  "rename",
  "rmdir",
  "scandir",
  "spawn",
  "stat",
  "symlink",
  "unlink",
  "write",
]);
const NODE_ERROR_CODE = /^ERR_[A-Z0-9_]{1,60}$/;
const MAX_DIAGNOSTIC_CODES = 3;

function knownCode(value: string | undefined): string | undefined {
  return value !== undefined && (ERRNO_CODES.has(value) || NODE_ERROR_CODE.test(value))
    ? value
    : undefined;
}

/**
 * Why Pi stopped, built only from allowlisted tokens: the error class, a known Node error
 * code and syscall, the npm package in the stack, a missing module below `node_modules`, and
 * Pioneer diagnostic codes. Stderr is untrusted and can hold credentials that no pattern
 * redaction recognizes, so no free text, path, or message from it is ever returned.
 */
export function stderrSummary(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim());
  let header = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (ERROR_HEADER.test(lines[index] ?? "")) {
      header = index;
      break;
    }
  }
  const fields: string[] = [];
  if (header >= 0) {
    const line = lines[header] ?? "";
    const match = ERROR_HEADER.exec(line);
    const after = lines.slice(header + 1);
    const property = (name: string): string | undefined =>
      after
        .map((entry) => new RegExp(`^${name}: '([A-Za-z0-9_]+)',?$`).exec(entry)?.[1])
        .find((value) => value !== undefined);
    const messageErrno = /\b([a-z]+) (E[A-Z0-9_]{2,20})\b/.exec(line);
    const code =
      knownCode(match?.[2]) ?? knownCode(property("code")) ?? knownCode(messageErrno?.[2]);
    const syscallCandidate = property("syscall") ?? messageErrno?.[1];
    const syscall =
      syscallCandidate !== undefined && SYSCALLS.has(syscallCandidate)
        ? syscallCandidate
        : undefined;
    const frames = after.filter((entry) => entry.startsWith("at ")).join("\n");
    const extensionPackage = stackPackage(frames);
    const module = /Cannot find (?:module|package) '/.test(line) ? missingModule(line) : undefined;
    fields.push(`error=${match?.[1] ?? "Error"}`);
    if (code !== undefined) fields.push(`code=${code}`);
    if (syscall !== undefined) fields.push(`syscall=${syscall}`);
    if (extensionPackage !== undefined) fields.push(`package=${extensionPackage}`);
    if (module !== undefined) fields.push(`module=${module}`);
  }
  const codes = [
    ...new Set(
      [...stderr.matchAll(/\[((?:PI|REVIEW|EVAL)_[A-Z0-9_]{1,60})\]/g)].map((match) => match[1]),
    ),
  ].slice(0, MAX_DIAGNOSTIC_CODES);
  if (codes.length > 0) fields.push(`diagnostics=${codes.join(",")}`);
  return fields.join("; ");
}
