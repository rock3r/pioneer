import { access, readFile } from "node:fs/promises";

const readJson = async (filename) => JSON.parse(await readFile(filename, "utf8"));
const packageManifest = await readJson("package.json");
const codexManifest = await readJson("plugins/pioneer/.codex-plugin/plugin.json");
const claudeManifest = await readJson("plugins/pioneer/.claude-plugin/plugin.json");
const expectedTag = `v${packageManifest.version}`;
const actualTag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
const expectedPluginName = "pioneer";
const codexSkillsPath = "plugins/pioneer/skills";
const claudeSkillsPath = "plugins/pioneer/skills";

if (packageManifest.private === true) throw new Error("npm package must not be private");
if (packageManifest.publishConfig?.access !== "public")
  throw new Error("npm package must publish publicly");
if (actualTag !== expectedTag)
  throw new Error(`release tag ${actualTag ?? "<missing>"} must equal ${expectedTag}`);
if (
  codexManifest.version !== packageManifest.version ||
  claudeManifest.version !== packageManifest.version
) {
  throw new Error("npm, Codex, and Claude plugin versions must match");
}
if (codexManifest.name !== expectedPluginName || claudeManifest.name !== expectedPluginName) {
  throw new Error(`Codex and Claude plugin names must be ${expectedPluginName}`);
}
if (codexManifest.skills !== "./skills/" || claudeManifest.skills !== "./skills/") {
  throw new Error("Codex and Claude plugin manifests must expose ./skills/");
}
await Promise.all([access(codexSkillsPath), access(claudeSkillsPath)]);

const [rootLicense, pluginLicense] = await Promise.all([
  readFile("LICENSE", "utf8"),
  readFile("plugins/pioneer/LICENSE", "utf8"),
]);
if (rootLicense !== pluginLicense) {
  throw new Error("root and plugin UEL license texts must match exactly");
}

process.stdout.write(`release metadata verified: ${expectedTag}\n`);
