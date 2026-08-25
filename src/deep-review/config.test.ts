import { describe, expect, it } from "vitest";
import {
  computeMinimumSupport,
  computeStrictMajorityThreshold,
  parseDeepReviewConfig,
  validateCouncilIndependence,
} from "./config.js";

const baseMember = (id: string, model: string, group: string) => ({
  id,
  model,
  independenceGroup: group,
});

describe("deep-review config", () => {
  it("parses a valid config with defaults", () => {
    const config = parseDeepReviewConfig({
      schemaVersion: "pioneer-deep-review-config/v1",
      council: [
        baseMember("worker-a", "provider/a", "group-a"),
        baseMember("worker-b", "provider/b", "group-b"),
      ],
      president: baseMember("president", "provider/p", "group-p"),
    });
    expect(config.council).toHaveLength(2);
    expect(computeMinimumSupport(config)).toBe(2);
  });

  it("rejects unknown fields", () => {
    expect(() =>
      parseDeepReviewConfig({
        schemaVersion: "pioneer-deep-review-config/v1",
        council: [
          baseMember("worker-a", "provider/a", "group-a"),
          baseMember("worker-b", "provider/b", "group-b"),
        ],
        president: baseMember("president", "provider/p", "group-p"),
        extra: true,
      }),
    ).toThrow(/unknown field/);
  });

  it("rejects one-member council", () => {
    expect(() =>
      parseDeepReviewConfig({
        schemaVersion: "pioneer-deep-review-config/v1",
        council: [baseMember("worker-a", "provider/a", "group-a")],
        president: baseMember("president", "provider/p", "group-p"),
      }),
    ).toThrow(/at least two independence groups/);
  });

  it("rejects duplicate models", () => {
    expect(() =>
      parseDeepReviewConfig({
        schemaVersion: "pioneer-deep-review-config/v1",
        council: [
          baseMember("worker-a", "provider/same", "group-a"),
          baseMember("worker-b", "provider/same", "group-b"),
        ],
        president: baseMember("president", "provider/p", "group-p"),
      }),
    ).toThrow(/duplicate council model/);
  });

  it("rejects duplicate independence groups", () => {
    expect(() =>
      parseDeepReviewConfig({
        schemaVersion: "pioneer-deep-review-config/v1",
        council: [
          baseMember("worker-a", "provider/a", "same-group"),
          baseMember("worker-b", "provider/b", "same-group"),
        ],
        president: baseMember("president", "provider/p", "group-p"),
      }),
    ).toThrow(/duplicate independence group/);
  });

  it("rejects impossible minimumSupport", () => {
    expect(() =>
      parseDeepReviewConfig({
        schemaVersion: "pioneer-deep-review-config/v1",
        council: [
          baseMember("worker-a", "provider/a", "group-a"),
          baseMember("worker-b", "provider/b", "group-b"),
        ],
        president: baseMember("president", "provider/p", "group-p"),
        consensus: { minimumSupport: 3 },
      }),
    ).toThrow(/exceeds configured group count/);
  });

  it("rejects minimumSupport below strict majority floor", () => {
    expect(() =>
      parseDeepReviewConfig({
        schemaVersion: "pioneer-deep-review-config/v1",
        council: [
          baseMember("worker-a", "provider/a", "group-a"),
          baseMember("worker-b", "provider/b", "group-b"),
          baseMember("worker-c", "provider/c", "group-c"),
        ],
        president: baseMember("president", "provider/p", "group-p"),
        consensus: { minimumSupport: 1 },
      }),
    ).toThrow(/below strict majority floor/);
  });

  it("computes strict majority thresholds", () => {
    expect(computeStrictMajorityThreshold(2)).toBe(2);
    expect(computeStrictMajorityThreshold(3)).toBe(2);
    expect(computeStrictMajorityThreshold(4)).toBe(3);
    expect(computeStrictMajorityThreshold(5)).toBe(3);
  });
});

describe("validateCouncilIndependence", () => {
  it("accepts president sharing model lineage without counting as council vote", () => {
    const config = parseDeepReviewConfig({
      schemaVersion: "pioneer-deep-review-config/v1",
      council: [
        baseMember("worker-a", "provider/a", "group-a"),
        baseMember("worker-b", "provider/b", "group-b"),
      ],
      president: baseMember("president", "provider/a", "group-a"),
    });
    expect(() => validateCouncilIndependence(config)).not.toThrow();
  });

  it("rejects duplicate council models after normalizing case and thinking suffix", () => {
    expect(() =>
      parseDeepReviewConfig({
        schemaVersion: "pioneer-deep-review-config/v1",
        council: [
          baseMember("worker-a", "Provider/A:high", "group-a"),
          baseMember("worker-b", "provider/a", "group-b"),
        ],
        president: baseMember("president", "provider/p", "group-p"),
      }),
    ).toThrow(/duplicate council model/);
  });
});
