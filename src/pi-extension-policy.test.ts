import { describe, expect, it } from "vitest";
import { restrictExtensionTools } from "./pi-extension-policy.js";

describe("extension capability policy", () => {
  it("never echoes credential-shaped extension filenames", () => {
    expect(() =>
      restrictExtensionTools({
        extensions: [],
        errors: [
          {
            path: "/extensions/sk-abcdefghijklmnopqrstuvwxyz/index.ts",
            error: "EACCES",
          },
        ],
      }),
    ).toThrow("entry 1: sandbox access denied");
    expect(() =>
      restrictExtensionTools({
        extensions: [],
        errors: [
          {
            path: "/extensions/sk-abcdefghijklmnopqrstuvwxyz/index.ts",
            error: "Cannot find module 'left-pad'",
          },
        ],
      }),
    ).toThrow(/entry 1: missing dependency left-pad\./);
  });
  it("names the failing extension and the missing module", () => {
    const failure = (): unknown =>
      restrictExtensionTools({
        extensions: [],
        errors: [
          {
            path: "/tmp/pioneer-eval-control-x/pi-extensions/extensions/tree/%2F/Users/u/.pi/agent/extensions/compose-pi/opencode_zen_free_provider.ts",
            error:
              "Failed to load extension: Cannot find module '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/compat.js/api/openai-completions'\nRequire stack:\n- /tmp/x.ts",
          },
          {
            path: "/staged/tools/pi-mcp-adapter/index.ts",
            error: "Cannot find package 'zod' imported from /staged/tools/pi-mcp-adapter/index.ts",
          },
        ],
      });
    expect(failure).toThrow(
      "entry 1 (compose-pi/opencode_zen_free_provider.ts): missing dependency @earendil-works/pi-ai/dist/compat.js/api/openai-completions, entry 2 (pi-mcp-adapter/index.ts): missing dependency zod.",
    );
  });
  it("omits credential-shaped or unusual names from load failures", () => {
    for (const module of [
      "sk-abcdefghijklmnopqrstuvwxyz0123",
      "pkg/Zk3q9XvB7mT2pL8wR4nY6cD1fH5jK0sA",
      "https://user:hunter2@example.com/pkg",
      "has space",
    ]) {
      let message = "";
      try {
        restrictExtensionTools({
          extensions: [],
          errors: [{ path: `/staged/${module}/index.ts`, error: `Cannot find module '${module}'` }],
        });
      } catch (error) {
        message = String(error);
      }
      expect(message).toMatch(/entry 1( \(pkg\/index\.ts\))?: missing dependency\./);
      expect(message).not.toContain(module);
      expect(message).not.toContain("hunter2");
    }
  });
  it("preserves provider hooks while removing write tools and builtin overrides", () => {
    const handlers = new Map([["session_start", [() => {}]]]);
    const extension = {
      tools: new Map([
        ["write", {}],
        ["read", {}],
        ["subagent", {}],
      ]),
      handlers,
    };
    const result = { extensions: [extension], errors: [] };
    expect(restrictExtensionTools(result)).toBe(result);
    expect(extension.tools.size).toBe(0);
    expect(extension.handlers).toBe(handlers);
  });
  it("rejects a partially loaded extension set without returning raw diagnostics", () => {
    expect(() =>
      restrictExtensionTools({ extensions: [], errors: [{ error: "token=secret" }] }),
    ).toThrow("[PI_EXTENSION_LOAD_FAILED]");
    try {
      restrictExtensionTools({ extensions: [], errors: [{ error: "token=secret" }] });
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
  });
  it("keeps tools only for trusted extension files and package directories (#89)", () => {
    const tools = (): Map<string, unknown> => new Map([["mcp", {}]]);
    const inspection = { path: "/staged/inspection/index.ts", tools: tools() };
    const packaged = { path: "/staged/tool/pi-mcp-adapter/dist/index.js", tools: tools() };
    const sibling = { path: "/staged/tool/pi-mcp-adapter-evil/index.js", tools: tools() };
    const user = { path: "/staged/user/provider.ts", tools: tools() };
    restrictExtensionTools({ extensions: [inspection, packaged, sibling, user], errors: [] }, [
      "/staged/inspection/index.ts",
      "/staged/tool/pi-mcp-adapter",
    ]);
    expect(inspection.tools.size).toBe(1);
    expect(packaged.tools.size).toBe(1);
    expect(sibling.tools.size).toBe(0);
    expect(user.tools.size).toBe(0);
  });
  it("still accepts one trusted inspection path", () => {
    const trusted = { path: "/staged/inspection/index.ts", tools: new Map([["read", {}]]) };
    const other = { path: "/staged/inspection/index.ts.bak", tools: new Map([["read", {}]]) };
    restrictExtensionTools(
      { extensions: [trusted, other], errors: [] },
      "/staged/inspection/index.ts",
    );
    expect(trusted.tools.size).toBe(1);
    expect(other.tools.size).toBe(0);
  });
});
