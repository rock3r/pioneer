import { describe, expect, it } from "vitest";
import {
  buildMarkerPayload,
  decodeMarkerPayload,
  encodeMarkerPayload,
  extractMarkerFromBody,
  formatMarkerComment,
  MARKER_SCHEMA_VERSION,
} from "./marker.js";

describe("github deep-review marker", () => {
  const samplePayload = buildMarkerPayload({
    repositoryOwner: "acme",
    repositoryName: "repo",
    pullRequestNumber: 12,
    findingId: `pdr_${"c".repeat(24)}`,
    headSha: "b".repeat(40),
    path: "src/main.ts",
    side: "RIGHT",
    line: 4,
    endLine: 6,
    category: "security",
  });

  it("round-trips canonical base64url marker payloads", () => {
    const encoded = encodeMarkerPayload(samplePayload);
    const decoded = decodeMarkerPayload(encoded);
    expect(decoded).toEqual(samplePayload);
  });

  it("rejects non-canonical encodings", () => {
    const nonCanonical = Buffer.from(
      JSON.stringify({ ...samplePayload, schemaVersion: MARKER_SCHEMA_VERSION }),
      "utf8",
    ).toString("base64url");
    expect(decodeMarkerPayload(nonCanonical)).toBeUndefined();
  });

  it("extracts marker from comment body and preserves visible prose", () => {
    const marker = formatMarkerComment(samplePayload);
    const body = `### Finding title\n\nDetails here.\n\n${marker}`;
    const extracted = extractMarkerFromBody(body);
    expect(extracted.marker).toEqual(samplePayload);
    expect(extracted.visibleBody).toBe("### Finding title\n\nDetails here.");
  });

  it("ignores forged markers with invalid payload", () => {
    const forged = `${MARKER_SCHEMA_VERSION}<!-- pioneer-deep-review:not-valid -->`;
    const extracted = extractMarkerFromBody(`Hello\n\n${forged}`);
    expect(extracted.marker).toBeUndefined();
  });

  it("rejects markers with unknown fields", () => {
    const record = { ...samplePayload, extra: true };
    const encoded = Buffer.from(JSON.stringify(record), "utf8").toString("base64url");
    expect(decodeMarkerPayload(encoded)).toBeUndefined();
  });
});
