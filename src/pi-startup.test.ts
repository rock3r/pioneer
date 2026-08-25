import { describe, expect, it } from "vitest";
import { optimizePiStartupCommand } from "./pi-startup.js";

describe("Pi startup optimization", () => {
  it("adds safe fast-start flags to Pi RPC commands", () => {
    expect(optimizePiStartupCommand(["pi", "--mode", "rpc"])).toEqual({
      command: [
        "pi",
        "--offline",
        "--no-session",
        "--no-approve",
        "--no-prompt-templates",
        "--no-themes",
        "--mode",
        "rpc",
      ],
      environment: { PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    });
  });

  it("recognizes absolute and Windows Pi executable paths", () => {
    expect(optimizePiStartupCommand(["C:\\tools\\pi.cmd", "--mode", "rpc"]).command[0]).toBe(
      "C:\\tools\\pi.cmd",
    );
    expect(optimizePiStartupCommand(["/opt/homebrew/bin/pi", "--mode", "rpc"]).environment).toEqual(
      { PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    );
  });

  it("does not duplicate flags or override explicit stateful choices", () => {
    const optimized = optimizePiStartupCommand([
      "pi",
      "--offline",
      "--session",
      "review-session",
      "--approve",
      "--prompt-template",
      "review",
      "--theme",
      "dark",
    ]);

    expect(optimized.command.filter((value) => value === "--offline")).toHaveLength(1);
    expect(optimized.command).not.toContain("--no-session");
    expect(optimized.command).not.toContain("--no-approve");
    expect(optimized.command).not.toContain("--no-prompt-templates");
    expect(optimized.command).not.toContain("--no-themes");
  });

  it("leaves non-Pi commands and environments unchanged", () => {
    const command = ["node", "actor.mjs"] as const;
    expect(optimizePiStartupCommand(command)).toEqual({
      command,
      environment: {},
    });
  });

  it("disables all ambient skills for eval actors", () => {
    expect(
      optimizePiStartupCommand(["pi", "--mode", "rpc"], { disableSkills: true }).command,
    ).toContain("--no-skills");
  });

  it("uses a private native session directory for resumable reviews", () => {
    expect(
      optimizePiStartupCommand(["pi", "--mode", "rpc"], {
        sessionDir: "/private/review-resumes/token/attempts/0001",
      }).command,
    ).toContain("/private/review-resumes/token/attempts/0001");
    expect(
      optimizePiStartupCommand(["pi", "--mode", "rpc"], {
        noSession: true,
      }).command,
    ).toContain("--no-session");
    expect(
      optimizePiStartupCommand(["pi", "--mode", "rpc"], {
        resumeSession: "/private/review-resumes/token/attempts/0002",
      }).command,
    ).toEqual(expect.arrayContaining(["--session", "/private/review-resumes/token/attempts/0002"]));
  });

  it("can disable optional extensions and allow only built-in inspection tools", () => {
    expect(
      optimizePiStartupCommand(["pi", "--mode", "rpc"], {
        disableExtensions: true,
        tools: ["read", "bash", "grep", "find", "ls"],
      }).command,
    ).toEqual([
      "pi",
      "--offline",
      "--no-session",
      "--no-approve",
      "--no-prompt-templates",
      "--no-themes",
      "--no-extensions",
      "--tools",
      "read,bash,grep,find,ls",
      "--mode",
      "rpc",
    ]);
  });

  it("can load explicit extensions while discovery remains disabled", () => {
    expect(
      optimizePiStartupCommand(["pi", "--mode", "rpc"], {
        disableExtensions: true,
        disableSkills: true,
        extensions: ["/trusted/provider/extension.ts", "/trusted/pioneer/inspection.ts"],
        tools: ["get_pr_metadata", "read_source_file"],
      }).command,
    ).toEqual([
      "pi",
      "--offline",
      "--no-session",
      "--no-approve",
      "--no-prompt-templates",
      "--no-themes",
      "--no-extensions",
      "--extension",
      "/trusted/provider/extension.ts",
      "--extension",
      "/trusted/pioneer/inspection.ts",
      "--tools",
      "get_pr_metadata,read_source_file",
      "--no-skills",
      "--mode",
      "rpc",
    ]);
  });

  it("does not inject --no-session when the base command already includes --session-dir", () => {
    expect(
      optimizePiStartupCommand(["pi", "--mode", "rpc", "--session-dir", "/private/session"], {
        disableSkills: true,
      }).command,
    ).not.toContain("--no-session");
  });
});
