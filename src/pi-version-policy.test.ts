import { describe, expect, it } from "vitest";
import {
  PI_MINIMUM_VERSION,
  PI_TESTED_MAXIMUM_VERSION,
  validatePiVersion,
} from "./pi-version-policy.js";

describe("Pi version policy", () => {
  it("accepts the supported endpoints", () => {
    expect(validatePiVersion(PI_MINIMUM_VERSION)).toEqual({ version: PI_MINIMUM_VERSION });
    expect(validatePiVersion(PI_TESTED_MAXIMUM_VERSION)).toEqual({
      version: PI_TESTED_MAXIMUM_VERSION,
    });
  });

  it("rejects Pi versions below the minimum", () => {
    expect(validatePiVersion("0.80.5")).toEqual({
      version: "0.80.5",
      error:
        "[PI_VERSION_TOO_OLD] Pi 0.80.5 is unsupported. Pioneer requires Pi 0.80.6 or newer. Update Pi and retry.",
    });
  });

  it("warns without failing for versions newer than the tested maximum", () => {
    expect(validatePiVersion("0.82.2")).toEqual({
      version: "0.82.2",
      warning:
        "[PI_VERSION_UNTESTED] Pi 0.82.2 is newer than the newest version tested with this Pioneer release (0.82.1). Continuing because the CLI contract may still be compatible.",
    });
  });

  it("rejects version output that is not semantic", () => {
    expect(validatePiVersion("development")).toEqual({
      version: "development",
      error:
        "[PI_VERSION_UNRECOGNIZED] Pi returned an unrecognized version: development. Install a released Pi version between 0.80.6 and 0.82.1, or newer with a compatibility warning.",
    });
  });
});
