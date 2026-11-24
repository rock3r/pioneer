import { describe, expect, it } from "vitest";
import { createDoctorReport, PIONEER_OUTER_SANDBOX_REQUIRED_WARNING } from "./doctor-report.js";

const supportedGit = { supported: true, version: "2.45.0" } as const;

describe("doctor report", () => {
  it("preserves prose errors and exposes schema-versioned machine diagnostics", () => {
    const report = createDoctorReport(
      "darwin",
      { ready: false, version: "0.81.1", modelCount: 0, errors: ["[PI_NO_MODELS] Configure Pi."] },
      ["[BUBBLEWRAP_NOT_FOUND] Install Bubblewrap."],
      supportedGit,
    );

    expect(report).toEqual({
      schemaVersion: 1,
      platform: "darwin",
      supported: false,
      pi: { version: "0.81.1", modelCount: 0 },
      git: supportedGit,
      warnings: [],
      errors: ["[PI_NO_MODELS] Configure Pi.", "[BUBBLEWRAP_NOT_FOUND] Install Bubblewrap."],
      diagnostics: [
        { id: "PI_NO_MODELS", severity: "error", message: "Configure Pi." },
        { id: "BUBBLEWRAP_NOT_FOUND", severity: "error", message: "Install Bubblewrap." },
      ],
    });
  });

  it("exposes Pi compatibility warnings as machine warnings", () => {
    const warning = "[PI_VERSION_UNTESTED] Pi is newer than tested.";
    const report = createDoctorReport(
      "darwin",
      {
        ready: true,
        version: "0.83.0",
        modelCount: 1,
        models: [{ provider: "openai", id: "gpt-5.5" }],
        warning,
        errors: [],
      },
      [],
      supportedGit,
    );

    expect(report.supported).toBe(true);
    expect(report.warnings).toEqual([warning]);
    expect(report.diagnostics).toContainEqual({
      id: "PI_VERSION_UNTESTED",
      severity: "warning",
      message: "Pi is newer than tested.",
    });
  });

  it("reports Git readiness without affecting non-Git workflows", () => {
    const warning = "[REVIEW_GIT_VERSION_UNSUPPORTED] Git inspection requires Git 2.45.0 or newer.";
    const report = createDoctorReport(
      "darwin",
      { ready: true, version: "0.84.3", modelCount: 1, errors: [] },
      [],
      { supported: false, version: "2.44.0", warning },
    );
    expect(report.git).toEqual({ supported: false, version: "2.44.0" });
    expect(report.supported).toBe(true);
    expect(report.diagnostics).toContainEqual({
      id: "REVIEW_GIT_VERSION_UNSUPPORTED",
      severity: "warning",
      message: "Git inspection requires Git 2.45.0 or newer.",
    });
  });

  it("limits the outer-sandbox hint to catalog and configuration failures", () => {
    const nativeSandboxFailure = createDoctorReport(
      "linux",
      { ready: true, version: "0.84.3", modelCount: 1, errors: [] },
      ["[BUBBLEWRAP_NOT_FOUND] Install Bubblewrap."],
      supportedGit,
    );
    expect(nativeSandboxFailure.warnings).toEqual([]);

    const configFailure = createDoctorReport(
      "darwin",
      {
        ready: false,
        version: "0.84.3",
        modelCount: 0,
        errors: ["[PI_CONFIG_HIDDEN_BY_SANDBOX] Pi configuration is not visible."],
      },
      [],
      supportedGit,
    );
    expect(configFailure.warnings).toContain(PIONEER_OUTER_SANDBOX_REQUIRED_WARNING);
  });
});
