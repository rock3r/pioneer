import { describe, expect, it } from "vitest";
import { restrictExtensionTools } from "./pi-extension-policy.js";

describe("extension capability policy", () => {
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
});
