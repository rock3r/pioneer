import { describe, expect, it } from "vitest";
import { stderrSummary } from "./stderr-summary.js";

describe("stderr summary", () => {
  it("names the error, Node code, syscall and extension package of a crash", () => {
    const stderr = [
      'Warning: No models match pattern "meta/example"',
      "node:internal/child_process:486",
      "    throw new ErrnoException(err, 'spawn');",
      "",
      "Error: spawn EPERM",
      "    at ChildProcess.spawn (node:internal/child_process:486:11)",
      "    at /private/tmp/pir-abc/extensions/tree/%2F/Users/Alice Smith/.pi/agent/npm/node_modules/pi-subagents/src/watchdog/diff-tool.js:32:37",
      "    at registeredHandler (file:///opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js:215:52)",
      "{",
      "  errno: -1,",
      "  code: 'EPERM',",
      "  syscall: 'spawn'",
      "}",
    ].join("\n");
    expect(stderrSummary(stderr)).toBe(
      "error=Error; code=EPERM; syscall=spawn; package=pi-subagents",
    );
  });

  it("names a missing module below node_modules and Pioneer diagnostic codes", () => {
    expect(
      stderrSummary(
        "[PI_EXTENSION_LOAD_FAILED] private text\nError [ERR_MODULE_NOT_FOUND]: Cannot find module '/a/node_modules/left-pad/index.js' imported from /b/c.js",
      ),
    ).toBe(
      "error=Error; code=ERR_MODULE_NOT_FOUND; module=left-pad/index.js; diagnostics=PI_EXTENSION_LOAD_FAILED",
    );
  });

  it("never returns free text, paths, or credential-shaped names", () => {
    const summary = stderrSummary(
      [
        "Error: provider failed with hunter2 at /Volumes/Work Disk/private project/extension.js",
        "TokenError: sk-abcdefghijklmnopqrstuvwxyz0123456789",
        "    at x (/a/node_modules/sk-abcdefghijklmnopqrstuvwxyz0123/a.js:1:1)",
        "  code: 'hunter2'",
        "  syscall: 'private_call'",
      ].join("\n"),
    );
    expect(summary).toBe("error=TokenError");
  });

  it("returns nothing when stderr has no recognizable error", () => {
    expect(stderrSummary("just some private words\nmore words")).toBe("");
  });
});
