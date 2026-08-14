import { describe, expect, it } from "vitest";
import { cliErrorMessage } from "./cli-error.js";
import { PiReadinessError } from "./pi-readiness.js";

describe("CLI error formatting", () => {
  it("preserves complete sanitized readiness errors", () => {
    const catalog = Array.from({ length: 40 }, (_, index) => `- provider/model-${index}`).join(
      "\n",
    );

    expect(cliErrorMessage(new PiReadinessError(catalog, true))).toContain("- provider/model-39");
  });

  it("bounds and redacts ordinary readiness errors", () => {
    const message = cliErrorMessage(
      new PiReadinessError(`path /tmp/token=private ${"x".repeat(1_000)}`),
    );

    expect(message).not.toContain("private");
    expect(message.length).toBeLessThanOrEqual(500);
  });

  it("bounds and redacts generic errors", () => {
    const message = cliErrorMessage(new Error(`token=private ${"x".repeat(1_000)}`));

    expect(message).not.toContain("private");
    expect(message.length).toBeLessThanOrEqual(500);
  });
});
