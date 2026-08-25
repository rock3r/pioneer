import { describe, expect, it } from "vitest";
import { extractRawJsonObject, StructuredOutputError } from "./json-output.js";

describe("extractRawJsonObject", () => {
  it("accepts a bare JSON object", () => {
    expect(extractRawJsonObject('{"schemaVersion":"demo","value":1}')).toEqual({
      schemaVersion: "demo",
      value: 1,
    });
  });

  it("accepts fenced JSON", () => {
    expect(extractRawJsonObject('```json\n{"schemaVersion":"demo"}\n```')).toEqual({
      schemaVersion: "demo",
    });
  });

  it("rejects prose-only output", () => {
    expect(() => extractRawJsonObject("Here is the review result")).toThrow(StructuredOutputError);
  });

  it("rejects arrays and oversized output", () => {
    expect(() => extractRawJsonObject("[1,2,3]")).toThrow(/must be a JSON object/);
    expect(() => extractRawJsonObject(`{"x":"${"a".repeat(300_000)}"}`)).toThrow(/byte limit/);
  });
});
