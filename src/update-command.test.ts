import { describe, expect, it } from "vitest";
import { runUpdateCommand } from "./update-command.js";

describe("pioneer update", () => {
  it("prints the requested changelog and delegates the install to npm", async () => {
    const output: string[] = [];
    const prompts: string[] = [];
    const installs: Array<readonly string[]> = [];

    await runUpdateCommand(["--changelog", "--yes"], {
      check: async () => ({ checked: true, latestVersion: "0.2.0", updateAvailable: true }),
      changelog: async () => "# v0.2.0\n\n- New capability",
      confirm: async (question) => {
        prompts.push(question);
        return true;
      },
      install: async (args) => {
        installs.push(args);
      },
      write: (message) => output.push(message),
    });

    expect(prompts).toEqual([]);
    expect(output.join("")).toContain("# v0.2.0");
    expect(installs).toEqual([["install", "--global", "@rock3r/pioneer@0.2.0"]]);
  });

  it("does not prompt or install when the installed version is current", async () => {
    const output: string[] = [];
    await runUpdateCommand([], {
      check: async () => ({ checked: true, latestVersion: "0.1.4", updateAvailable: false }),
      changelog: async () => "unreachable",
      confirm: async () => {
        throw new Error("should not prompt");
      },
      install: async () => {
        throw new Error("should not install");
      },
      write: (message) => output.push(message),
    });
    expect(output.join("")).toContain("already up to date");
  });
});
