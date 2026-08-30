import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));

describe("Pioneer distribution identity", () => {
  it("uses the Pioneer identity across npm and the client-specific plugin formats", async () => {
    const packageManifest = await readJson("package.json");
    const codexManifest = await readJson("plugins/pioneer/.codex-plugin/plugin.json");
    const claudeManifest = await readJson("plugins/pioneer/.claude-plugin/plugin.json");
    const codexMarketplace = await readJson(".agents/plugins/marketplace.json");
    const claudeMarketplace = await readJson(".claude-plugin/marketplace.json");

    expect(packageManifest.name).toBe("@rock3r/pioneer");
    expect(packageManifest.bin).toEqual({ pioneer: "dist/review-cli.js" });
    expect(packageManifest.main).toBe("./dist/index.js");
    expect(packageManifest.types).toBe("./dist/index.d.ts");
    expect(packageManifest.exports).toEqual({
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
      "./package.json": "./package.json",
    });
    expect(packageManifest.files).toContain("plugins/pioneer/");
    expect(codexManifest.name).toBe("pioneer");
    expect(codexManifest.interface.displayName).toBe("Pioneer");
    expect(codexManifest.interface.composerIcon).toBe("./assets/pioneer-mascot.png");
    expect(codexManifest.interface.logo).toBe("./assets/pioneer-mascot.png");
    expect(codexManifest.interface.logoDark).toBe("./assets/pioneer-mascot.png");
    expect(claudeManifest.name).toBe("pioneer");
    expect(claudeManifest.displayName).toBe("Pioneer");
    expect(codexMarketplace.name).toBe("pioneer");
    expect(codexMarketplace.interface.displayName).toBe("Pioneer");
    expect(claudeMarketplace.name).toBe("pioneer");
    expect(codexMarketplace.plugins[0].source.path).toBe("./plugins/pioneer");
    expect(claudeMarketplace.plugins[0].source).toBe("./plugins/pioneer");
    await access("plugins/pioneer/skills/pioneer/SKILL.md");
    await access("plugins/pioneer/assets/pioneer-mascot.png");
    await access("plugins/pioneer/assets/pioneer-banner.jpg");
  });

  it("publishes an Agent Plugins 1.0 portable manifest", async () => {
    const packageManifest = await readJson("package.json");
    const portableManifest = await readJson("plugins/pioneer/plugin.json");
    const pluginReadme = await readFile("plugins/pioneer/README.md", "utf8");

    expect(portableManifest).toEqual({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "pioneer",
      version: packageManifest.version,
      description: "Delegate Pi code reviews with native sandboxing on macOS and Linux.",
      author: {
        name: "Pioneer contributors",
      },
      homepage: "https://github.com/rock3r/pioneer#readme",
      repository: "https://github.com/rock3r/pioneer",
      license: "UEL-1.0",
      keywords: ["code-review", "pi", "sandbox", "models"],
    });

    await access("plugins/pioneer/skills/pioneer/SKILL.md");
    expect(pluginReadme).toContain(
      "https://github.com/rock3r/pioneer/blob/main/user-guide/plugins.md",
    );
  });

  it("requires agent integrations to preserve review terminal evidence", async () => {
    const skill = await readFile("plugins/pioneer/skills/pioneer/SKILL.md", "utf8");

    expect(skill).toContain(
      "description: Delegate a code review from a coding agent to the locally installed Pi coding agent.",
    );
    expect(skill).toContain("license: UEL-1.0");
    expect(skill).not.toContain("from Codex or Claude Code");
    expect(skill).toContain("run `pioneer doctor` before the first review");
    expect(skill).toContain("outside any enclosing agent sandbox");
    expect(skill).toContain("Do not use `--network none`");
    expect(skill).toContain("exit status is zero");
    expect(skill).toContain("stdout contains a non-empty report");
    expect(skill).toContain("Preserve the command's exit status, stdout, and stderr");
    expect(skill).toContain("session ID");
    expect(skill).toContain("does not use `fs.watch`");
    expect(skill).toContain("not a semantic verdict");
    expect(skill).toContain("Windows custom targets inherit their parent directory ACL");
  });

  it("routes CI and release sandbox setup through the unified CLI", async () => {
    for (const workflow of [".github/workflows/ci.yml", ".github/workflows/release.yml"]) {
      const source = await readFile(workflow, "utf8");
      expect(source).toContain("dist/review-cli.js eval install-linux");
      expect(source).not.toContain("dist/eval-run-cli.js");
    }
  });
});
