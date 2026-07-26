import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: false, ...options });
  if (result.error) throw result.error;
  return result;
}

const policy = JSON.parse(await readFile("pi-compatibility.json", "utf8"));
const expectedVersion = process.argv[2];
if (![policy.minimum, policy.testedMaximum].includes(expectedVersion)) {
  throw new Error(
    `Expected one compatibility endpoint (${policy.minimum} or ${policy.testedMaximum}), got ${expectedVersion ?? "<missing>"}`,
  );
}

const root = await mkdtemp(path.join(os.tmpdir(), "pioneer-pi-compat-"));
try {
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => name !== "CODEX_PERMISSION_PROFILE" && !name.toUpperCase().includes("SANDBOX"),
    ),
  );
  const environment = {
    ...inheritedEnvironment,
    PI_CODING_AGENT_DIR: path.join(root, "agent"),
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    NO_COLOR: "1",
  };
  const version = run("pi", ["--version"], { env: environment });
  if (version.status !== 0 || version.stdout.trim() !== expectedVersion) {
    throw new Error(`Pi version contract failed: ${version.stderr || version.stdout}`);
  }
  const help = run("pi", ["--help"], { env: environment });
  if (help.status !== 0) throw new Error(`Pi help contract failed: ${help.stderr}`);
  for (const option of policy.requiredCliOptions) {
    if (!help.stdout.includes(option)) throw new Error(`Pi ${expectedVersion} lacks ${option}`);
  }
  const thinkingLine = help.stdout
    .split(/\r?\n/)
    .find((line) => line.includes("--thinking <level>"));
  for (const level of policy.requiredThinkingLevels) {
    if (!thinkingLine?.includes(level)) {
      throw new Error(`Pi ${expectedVersion} lacks thinking level ${level}`);
    }
  }
  const models = run("pi", ["--offline", "--no-approve", "--no-extensions", "--list-models"], {
    env: environment,
  });
  if (models.status !== 0 || /unknown option/i.test(`${models.stdout}\n${models.stderr}`)) {
    throw new Error(`Pi model-list contract failed: ${models.stderr || models.stdout}`);
  }
  const pioneer = run(process.execPath, ["dist/review-cli.js", "models"], {
    env: environment,
  });
  if (
    pioneer.status !== 1 ||
    !pioneer.stderr.includes("[PI_NO_MODELS]") ||
    pioneer.stderr.includes("[PI_PROBE_FAILED]")
  ) {
    throw new Error(`Pioneer/Pi readiness contract failed: ${pioneer.stderr || pioneer.stdout}`);
  }
  process.stdout.write(`Pi compatibility smoke passed: ${expectedVersion}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
