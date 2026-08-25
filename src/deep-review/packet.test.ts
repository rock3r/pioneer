import { describe, expect, it } from "vitest";
import {
  computePacketDigest,
  parsePullRequestPacket,
  validatePacketCompleteness,
} from "./packet.js";

function samplePacketBody() {
  return {
    schemaVersion: "pioneer-pr-review-packet/v1" as const,
    repository: { owner: "acme", name: "repo" },
    pullRequest: {
      number: 1,
      url: "https://github.com/acme/repo/pull/1",
      title: "Fix bug",
      body: "Details",
      baseRef: "main",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
    },
    commits: [{ sha: "b".repeat(40), title: "Fix", body: "" }],
    files: [
      {
        path: "src/main.ts",
        status: "modified" as const,
        contentKind: "text" as const,
        additions: 1,
        deletions: 0,
        patch: "@@ -1,1 +1,2 @@\n line\n+added\n",
      },
    ],
    rules: [],
    previousFindings: [],
  };
}

describe("deep-review packet", () => {
  it("parses a valid packet with matching digest", () => {
    const body = samplePacketBody();
    const packetDigest = computePacketDigest(body);
    const packet = parsePullRequestPacket({ ...body, packetDigest });
    expect(packet.pullRequest.number).toBe(1);
    expect(packet.packetDigest).toBe(packetDigest);
  });

  it("rejects digest mismatch", () => {
    const body = samplePacketBody();
    expect(() => parsePullRequestPacket({ ...body, packetDigest: "dead".repeat(8) })).toThrow(
      /packetDigest mismatch/,
    );
  });

  it("rejects unknown fields", () => {
    const body = samplePacketBody();
    const packetDigest = computePacketDigest(body);
    expect(() => parsePullRequestPacket({ ...body, packetDigest, unknown: true })).toThrow(
      /unknown field/,
    );
  });

  it("rejects path traversal", () => {
    const body = {
      ...samplePacketBody(),
      files: [
        {
          path: "../escape.ts",
          status: "modified" as const,
          contentKind: "text" as const,
          additions: 1,
          deletions: 0,
          patch: "@@ -1,1 +1,2 @@\n line\n+added\n",
        },
      ],
    };
    const packetDigest = computePacketDigest(body);
    expect(() => parsePullRequestPacket({ ...body, packetDigest })).toThrow(
      /valid repository-relative path/,
    );
  });

  it("requires binary patchOmittedReason", () => {
    const body = {
      ...samplePacketBody(),
      files: [
        {
          path: "image.png",
          status: "added" as const,
          contentKind: "binary" as const,
          additions: 0,
          deletions: 0,
          patchOmittedReason: "binary" as const,
        },
      ],
    };
    const packetDigest = computePacketDigest(body);
    const packet = parsePullRequestPacket({ ...body, packetDigest });
    expect(packet.files[0]?.contentKind).toBe("binary");
  });

  it("rejects binary file with patch", () => {
    const body = {
      ...samplePacketBody(),
      files: [
        {
          path: "image.png",
          status: "added" as const,
          contentKind: "binary" as const,
          additions: 0,
          deletions: 0,
          patch: "binary data",
          patchOmittedReason: "binary" as const,
        },
      ],
    };
    const packetDigest = computePacketDigest(body);
    expect(() => parsePullRequestPacket({ ...body, packetDigest })).toThrow(
      /must not include patch/,
    );
  });

  it("rejects invalid sha", () => {
    const body = {
      ...samplePacketBody(),
      pullRequest: { ...samplePacketBody().pullRequest, headSha: "not-a-sha" },
    };
    const packetDigest = computePacketDigest(body);
    expect(() => parsePullRequestPacket({ ...body, packetDigest })).toThrow(/invalid format/);
  });

  it("measures packet size limits in UTF-8 bytes", () => {
    const body = {
      ...samplePacketBody(),
      pullRequest: {
        ...samplePacketBody().pullRequest,
        title: "é".repeat(2_000),
      },
    };
    const packet = parsePullRequestPacket({
      ...body,
      packetDigest: computePacketDigest(body),
    });
    const serialized = JSON.stringify(packet);
    const charLength = serialized.length;
    const byteLength = Buffer.byteLength(serialized, "utf8");
    expect(byteLength).toBeGreaterThan(charLength);
    expect(() => validatePacketCompleteness(packet, charLength)).toThrow(/exceeds size limit/);
    expect(() => validatePacketCompleteness(packet, byteLength)).not.toThrow();
  });
});

describe("computePacketDigest", () => {
  it("is deterministic", () => {
    const body = samplePacketBody();
    expect(computePacketDigest(body)).toBe(computePacketDigest(body));
  });

  it("changes when content changes", () => {
    const body = samplePacketBody();
    const other = {
      ...body,
      pullRequest: { ...body.pullRequest, title: "Different" },
    };
    expect(computePacketDigest(body)).not.toBe(computePacketDigest(other));
  });
});
