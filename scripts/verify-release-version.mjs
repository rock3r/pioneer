import { access, readFile } from "node:fs/promises";

const readJson = async (filename) => JSON.parse(await readFile(filename, "utf8"));
const packageManifest = await readJson("package.json");
const portableManifest = await readJson("plugins/pioneer/plugin.json");
const codexManifest = await readJson("plugins/pioneer/.codex-plugin/plugin.json");
const claudeManifest = await readJson("plugins/pioneer/.claude-plugin/plugin.json");
const piCompatibility = await readJson("pi-compatibility.json");
const expectedTag = `v${packageManifest.version}`;
const actualTag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
const expectedPluginName = "pioneer";
const codexSkillsPath = "plugins/pioneer/skills";
const claudeSkillsPath = "plugins/pioneer/skills";
const semanticVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

if (
  piCompatibility.package !== "@earendil-works/pi-coding-agent" ||
  !semanticVersion.test(piCompatibility.minimum) ||
  !semanticVersion.test(piCompatibility.testedMaximum) ||
  !Array.isArray(piCompatibility.requiredCliOptions) ||
  !Array.isArray(piCompatibility.requiredThinkingLevels)
) {
  throw new Error("Pi compatibility policy is invalid");
}
if (!packageManifest.files?.includes("pi-compatibility.json")) {
  throw new Error("published package must include pi-compatibility.json");
}
const [ciWorkflow, releaseWorkflow] = await Promise.all([
  readFile(".github/workflows/ci.yml", "utf8"),
  readFile(".github/workflows/release.yml", "utf8"),
]);
for (const endpoint of [piCompatibility.minimum, piCompatibility.testedMaximum]) {
  if (!ciWorkflow.includes(endpoint) || !releaseWorkflow.includes(endpoint)) {
    throw new Error(`Pi compatibility endpoint ${endpoint} must be tested in CI and releases`);
  }
}
if (!releaseWorkflow.includes("npm run pi:compat:latest")) {
  throw new Error("release workflow must verify the current upstream Pi version");
}

if (packageManifest.private === true) throw new Error("npm package must not be private");
if (packageManifest.publishConfig?.access !== "public")
  throw new Error("npm package must publish publicly");
if (actualTag !== expectedTag)
  throw new Error(`release tag ${actualTag ?? "<missing>"} must equal ${expectedTag}`);
if (
  portableManifest.version !== packageManifest.version ||
  codexManifest.version !== packageManifest.version ||
  claudeManifest.version !== packageManifest.version
) {
  throw new Error("npm and all plugin manifest versions must match");
}
if (
  portableManifest.name !== expectedPluginName ||
  codexManifest.name !== expectedPluginName ||
  claudeManifest.name !== expectedPluginName
) {
  throw new Error(`all plugin manifest names must be ${expectedPluginName}`);
}
if (portableManifest.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json") {
  throw new Error("portable plugin must target Agent Plugins 1.0.0");
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
