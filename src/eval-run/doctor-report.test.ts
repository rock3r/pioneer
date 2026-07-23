import { describe, expect, it } from "vitest";
import { createDoctorReport } from "./doctor-report.js";

describe("doctor report", () => {
  it("preserves prose errors and exposes schema-versioned machine diagnostics", () => {
    const report = createDoctorReport(
      "darwin",
      { ready: false, version: "0.81.1", modelCount: 0, errors: ["[PI_NO_MODELS] Configure Pi."] },
      ["[BUBBLEWRAP_NOT_FOUND] Install Bubblewrap."],
    );

    expect(report).toEqual({
      schemaVersion: 1,
      platform: "darwin",
      supported: false,
      pi: { version: "0.81.1", modelCount: 0 },
      warnings: [],
      errors: ["[PI_NO_MODELS] Configure Pi.", "[BUBBLEWRAP_NOT_FOUND] Install Bubblewrap."],
      diagnostics: [
        { id: "PI_NO_MODELS", severity: "error", message: "Configure Pi." },
        { id: "BUBBLEWRAP_NOT_FOUND", severity: "error", message: "Install Bubblewrap." },
      ],
    });
  });
});
