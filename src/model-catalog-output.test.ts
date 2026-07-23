import { describe, expect, it } from "vitest";
import { formatModelCatalog, modelCatalogJson } from "./model-catalog-output.js";

const models = [
  { provider: "xai", id: "grok-4.5" },
  { provider: "openrouter", id: "x-ai/grok-4.5" },
] as const;

describe("model catalog output", () => {
  it("prints sorted qualified model names for humans", () => {
    expect(formatModelCatalog(models)).toBe("openrouter/x-ai/grok-4.5\nxai/grok-4.5\n");
  });

  it("prints a schema-versioned catalog for machines", () => {
    expect(modelCatalogJson("0.81.1", models)).toEqual({
      schemaVersion: 1,
      piVersion: "0.81.1",
      models: [
        {
          provider: "openrouter",
          id: "x-ai/grok-4.5",
          qualifiedName: "openrouter/x-ai/grok-4.5",
        },
        {
          provider: "xai",
          id: "grok-4.5",
          qualifiedName: "xai/grok-4.5",
        },
      ],
    });
  });
});
