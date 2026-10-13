import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  containSandboxSubprocessDenials,
  extensionPackageNames,
  isSandboxSubprocessDenial,
  subprocessDenialWarnings,
} from "./pi-extension-subprocess-guard.js";

function spawnDenial(stack: string): Error {
  return Object.assign(new Error("spawn EPERM"), {
    code: "EPERM",
    errno: -1,
    syscall: "spawn",
    stack: `Error: spawn EPERM\n${stack}`,
  });
}

const SUBAGENTS_STACK = [
  "    at ChildProcess.spawn (node:internal/child_process:486:11)",
  "    at /private/tmp/pir-abc/extensions/tree/%2F/Users/someone/.pi/agent/npm/node_modules/pi-subagents/src/watchdog/diff-tool.js:32:37",
  "    at registeredHandler (file:///opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js:215:52)",
].join("\n");

describe("sandbox subprocess denial guard", () => {
  it("recognizes only a denied spawn", () => {
    expect(isSandboxSubprocessDenial(spawnDenial(SUBAGENTS_STACK))).toBe(true);
    expect(
      isSandboxSubprocessDenial(Object.assign(new Error("x"), { code: "EPERM", syscall: "open" })),
    ).toBe(false);
    expect(
      isSandboxSubprocessDenial(
        Object.assign(new Error("x"), { code: "ENOENT", syscall: "spawn git" }),
      ),
    ).toBe(false);
    expect(isSandboxSubprocessDenial("spawn EPERM")).toBe(false);
    expect(isSandboxSubprocessDenial(undefined)).toBe(false);
  });

  it("keeps Pi running and names the extension package once", () => {
    const target = new EventEmitter();
    const warnings: string[] = [];
    containSandboxSubprocessDenials(target, (text) => warnings.push(text));
    target.emit("unhandledRejection", spawnDenial(SUBAGENTS_STACK), Promise.resolve());
    target.emit("unhandledRejection", spawnDenial(SUBAGENTS_STACK), Promise.resolve());
    expect(warnings).toEqual([
      "[PI_EXTENSION_SUBPROCESS_DENIED] Extension pi-subagents tried to start a subprocess, which the sandbox denies. Pioneer kept Pi running; extension features that need subprocesses are unavailable.\n",
    ]);
  });

  it("does not name the Pi package itself or an unsafe package name", () => {
    const target = new EventEmitter();
    const warnings: string[] = [];
    containSandboxSubprocessDenials(target, (text) => warnings.push(text));
    target.emit(
      "unhandledRejection",
      spawnDenial(
        "    at x (/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/a.js:1:1)",
      ),
      Promise.resolve(),
    );
    target.emit(
      "unhandledRejection",
      spawnDenial("    at x (/a/node_modules/sk-abcdefghijklmnopqrstuvwxyz0123/a.js:1:1)"),
      Promise.resolve(),
    );
    expect(warnings).toEqual([
      "[PI_EXTENSION_SUBPROCESS_DENIED] An extension tried to start a subprocess, which the sandbox denies. Pioneer kept Pi running; extension features that need subprocesses are unavailable.\n",
    ]);
  });

  it("keeps Node's default crash for every other unhandled rejection", () => {
    const target = new EventEmitter();
    containSandboxSubprocessDenials(target, () => undefined);
    const failure = new Error("provider failed");
    expect(() => target.emit("unhandledRejection", failure, Promise.resolve())).toThrow(failure);
  });

  it("defers other rejections to a handler that Pi or an extension installed", () => {
    const target = new EventEmitter();
    containSandboxSubprocessDenials(target, () => undefined);
    const seen: unknown[] = [];
    target.on("unhandledRejection", (reason) => seen.push(reason));
    const failure = new Error("handled elsewhere");
    expect(() => target.emit("unhandledRejection", failure, Promise.resolve())).not.toThrow();
    expect(seen).toEqual([failure]);
  });

  it("accepts only the exact warning format and only staged package names", () => {
    const named =
      "[PI_EXTENSION_SUBPROCESS_DENIED] Extension pi-subagents tried to start a subprocess, which the sandbox denies. Pioneer kept Pi running; extension features that need subprocesses are unavailable.";
    const forgedName = named.replace("pi-subagents", "hunter2");
    const generic = named.replace("Extension pi-subagents", "An extension");
    expect(
      subprocessDenialWarnings(
        `noise\n${named}\r\n${named}\n${forgedName}\n[PI_EXTENSION_SUBPROCESS_DENIED] token=secret forged\n`,
        new Set(["pi-subagents"]),
      ),
    ).toEqual([named, generic]);
  });

  it("collects npm package names from staged extension paths", () => {
    expect([
      ...extensionPackageNames([
        "/tmp/pir-x/extensions/tree/%2F/Users/a/.pi/agent/npm/node_modules/pi-subagents/src/index.js",
        "C:\\Users\\a\\npm\\node_modules\\@scope\\ext\\index.js",
        "/Users/a/.pi/agent/extensions/local/index.ts",
      ]),
    ]).toEqual(["pi-subagents", "@scope/ext"]);
  });
});
