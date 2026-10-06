import { describe, expect, it } from "vitest";
import {
  applyPiVersionToStartup,
  applyPiVersionToStartupCommand,
  applyResolvedPiLaunch,
  optimizePiStartupCommand,
} from "./pi-startup.js";

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
      piActor: true,
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

  it("still injects safety flags when the same tokens appear after --", () => {
    expect(
      optimizePiStartupCommand(["pi", "--", "--no-extensions", "--approve", "--skill", "name"], {
        disableExtensions: true,
        disableSkills: true,
        noSession: true,
      }),
    ).toEqual({
      command: [
        "pi",
        "--offline",
        "--no-session",
        "--no-approve",
        "--no-prompt-templates",
        "--no-themes",
        "--no-extensions",
        "--no-skills",
        "--",
        "--no-extensions",
        "--approve",
        "--skill",
        "name",
      ],
      environment: { PI_OFFLINE: "1", PI_TELEMETRY: "0" },
      piActor: true,
    });
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
      piActor: false,
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

  it("preserves hardened Pi arguments when applying a resolved Node launcher", () => {
    const optimized = optimizePiStartupCommand(["pi", "--mode", "rpc"], {
      disableExtensions: true,
      tools: ["read", "ls"],
    });

    expect(applyResolvedPiLaunch(optimized, ["C:\\node.exe", "C:\\pi\\dist\\cli.js"])).toEqual({
      command: [
        "C:\\node.exe",
        "C:\\pi\\dist\\cli.js",
        "--offline",
        "--no-session",
        "--no-approve",
        "--no-prompt-templates",
        "--no-themes",
        "--no-extensions",
        "--tools",
        "read,ls",
        "--mode",
        "rpc",
      ],
      environment: { PI_OFFLINE: "1", PI_TELEMETRY: "0" },
      piActor: true,
    });
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

  it("injects --no-mcp for Pi 1.0.4+ because --tools no longer drops MCP tools", () => {
    expect(
      optimizePiStartupCommand(["pi", "--mode", "rpc"], {
        disableExtensions: true,
        tools: ["read", "ls"],
        piVersion: "1.0.4",
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
      "read,ls",
      "--no-mcp",
      "--mode",
      "rpc",
    ]);
  });

  it("does not inject --no-mcp below Pi 1.0.4 or when the command already has it", () => {
    expect(
      optimizePiStartupCommand(["pi", "--mode", "rpc"], {
        disableExtensions: true,
        tools: ["read", "ls"],
        piVersion: "1.0.3",
      }).command,
    ).not.toContain("--no-mcp");
    expect(
      optimizePiStartupCommand(["pi", "--mode", "rpc", "--no-mcp"], {
        piVersion: "1.0.4",
      }).command.filter((value) => value === "--no-mcp"),
    ).toHaveLength(1);
  });
});

describe("applyPiVersionToStartup after eval readiness", () => {
  const evalStartup = {
    disableExtensions: true,
    disableSkills: true,
  } as const;

  it("adds --no-mcp after deferred eval readiness discovers Pi 1.0.4", () => {
    const beforeReadiness = optimizePiStartupCommand(["pi", "--print", "OK"], evalStartup);
    expect(beforeReadiness.command).not.toContain("--no-mcp");

    expect(applyPiVersionToStartup(beforeReadiness, "1.0.4").command).toEqual(
      expect.arrayContaining(["--no-mcp"]),
    );
  });

  it("adds --no-mcp after --pi-home eval readiness discovers Pi 1.0.4", () => {
    const beforeReadiness = optimizePiStartupCommand(
      ["pi", "--no-extensions", "--model", "scripted/fake-model"],
      evalStartup,
    );
    expect(beforeReadiness.command).not.toContain("--no-mcp");

    expect(applyPiVersionToStartup(beforeReadiness, "1.0.4").command).toContain("--no-mcp");
  });

  it("keeps --no-mcp when extension staging wraps a 1.0.4 command", () => {
    const optimized = optimizePiStartupCommand(["pi", "--print", "OK"], evalStartup);
    const staged = applyResolvedPiLaunch(optimized, [
      "/usr/bin/node",
      "/tmp/pi-extensions/adapter.js",
    ]);
    expect(staged.command[0]).toBe("/usr/bin/node");
    expect(staged.command).not.toContain("--no-mcp");

    expect(applyPiVersionToStartup(staged, "1.0.4").command).toEqual(
      expect.arrayContaining(["--no-mcp", "--no-extensions", "--no-skills"]),
    );
    expect(applyPiVersionToStartup(staged, "1.0.4").command[0]).toBe("/usr/bin/node");
  });

  it("does not add --no-mcp for Pi 1.0.2 on deferred, --pi-home, and staged paths", () => {
    const deferred = optimizePiStartupCommand(["pi", "--print", "OK"], evalStartup);
    const piHome = optimizePiStartupCommand(
      ["pi", "--no-extensions", "--model", "scripted/fake-model"],
      evalStartup,
    );
    const staged = applyResolvedPiLaunch(
      optimizePiStartupCommand(["pi", "--print", "OK"], evalStartup),
      ["/usr/bin/node", "/tmp/pi-extensions/adapter.js"],
    );

    expect(applyPiVersionToStartup(deferred, "1.0.2").command).not.toContain("--no-mcp");
    expect(applyPiVersionToStartup(piHome, "1.0.2").command).not.toContain("--no-mcp");
    expect(applyPiVersionToStartup(staged, "1.0.2").command).not.toContain("--no-mcp");
  });

  it("fails closed when a tool-restricted actor still has no Pi version at launch", () => {
    const restricted = optimizePiStartupCommand(["pi", "--mode", "rpc"], {
      disableExtensions: true,
      tools: ["read", "ls"],
    });
    expect(() => applyPiVersionToStartup(restricted, undefined)).toThrow(
      /\[PI_NO_MCP_VERSION_UNKNOWN\].*--no-mcp/,
    );
    const evalHardened = optimizePiStartupCommand(["pi", "--print", "OK"], evalStartup);
    expect(() => applyPiVersionToStartup(evalHardened, undefined)).toThrow(
      /\[PI_NO_MCP_VERSION_UNKNOWN\]/,
    );
  });

  it("leaves non-Pi eval actors unchanged when the version is unknown", () => {
    const actor = {
      command: [process.execPath, "-e", "process.exit(0)"] as const,
      environment: {},
      piActor: false,
    };
    expect(applyPiVersionToStartup(actor, undefined)).toEqual(actor);
  });

  it("does not duplicate --no-mcp when the command already has it", () => {
    const command = optimizePiStartupCommand(["pi", "--mode", "rpc"], {
      disableExtensions: true,
      tools: ["read", "ls"],
      piVersion: "1.0.4",
    });
    expect(
      applyPiVersionToStartup(command, "1.0.4").command.filter((value) => value === "--no-mcp"),
    ).toHaveLength(1);
  });

  it("inserts --no-mcp before a `--` delimiter on a staged command", () => {
    const staged = applyResolvedPiLaunch(
      optimizePiStartupCommand(["pi", "--", "--no-extensions"], {
        disableExtensions: true,
        disableSkills: true,
      }),
      ["/usr/bin/node", "/tmp/adapter.js"],
    );
    const applied = applyPiVersionToStartup(staged, "1.0.4").command;
    expect(applied.indexOf("--no-mcp")).toBeLessThan(applied.indexOf("--"));
    expect(applied).toContain("--no-mcp");
  });

  it("adds --no-mcp after a review launcher wrap for Pi 1.0.4 and not for 1.0.2", () => {
    const wrapped = applyResolvedPiLaunch(
      optimizePiStartupCommand(["pi", "--mode", "rpc"], {
        disableExtensions: true,
        tools: ["read", "ls"],
      }),
      ["/usr/bin/node", "/pi/dist/cli.js"],
    );
    expect(wrapped.command).not.toContain("--no-mcp");
    expect(applyPiVersionToStartup(wrapped, "1.0.4").command).toContain("--no-mcp");
    expect(applyPiVersionToStartup(wrapped, "1.0.2").command).not.toContain("--no-mcp");
  });

  it("does not treat custom actor flags as Pi identity", () => {
    for (const extra of [["--tools", "read"], ["-t", "read"], ["--no-extensions"]] as const) {
      const command = [process.execPath, "actor.mjs", ...extra] as [string, ...string[]];
      const actor = optimizePiStartupCommand(command);
      expect(applyPiVersionToStartup(actor, "1.0.4")).toEqual(actor);
      expect(applyPiVersionToStartup(actor, undefined)).toEqual(actor);
      expect(applyPiVersionToStartupCommand(command, "1.0.4", false)).toEqual(command);
      expect(applyPiVersionToStartupCommand(command, undefined, false)).toEqual(command);
    }
  });

  it("applies --no-mcp to wrapped argv only when Pi identity is carried", () => {
    const wrapped = ["/usr/bin/node", "/tmp/adapter.js", "--no-extensions", "--no-skills"] as [
      string,
      ...string[],
    ];
    expect(applyPiVersionToStartupCommand(wrapped, "1.0.4", true)).toEqual(
      expect.arrayContaining(["--no-mcp"]),
    );
    expect(applyPiVersionToStartupCommand(wrapped, "1.0.4", false)).toEqual(wrapped);
    expect(() => applyPiVersionToStartupCommand(wrapped, undefined, false)).not.toThrow();
  });

  it("preserves Pi identity when a launcher wraps the command", () => {
    const staged = applyResolvedPiLaunch(
      optimizePiStartupCommand(["pi", "--print", "OK"], evalStartup),
      ["/usr/bin/node", "/tmp/adapter.js"],
    );
    expect(staged.piActor).toBe(true);
    expect(staged.command[0]).toBe("/usr/bin/node");
    expect(applyPiVersionToStartupCommand(staged.command, "1.0.4", staged.piActor)).toContain(
      "--no-mcp",
    );
    expect(() => applyPiVersionToStartup(staged, undefined)).toThrow(
      /\[PI_NO_MCP_VERSION_UNKNOWN\]/,
    );
  });
});
