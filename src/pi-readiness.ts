import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { diagnosticMessage, sanitizeDiagnostic } from "./diagnostics.js";
import { defaultPiAgentDir } from "./pi-home.js";
import { type PiConfiguredModel, resolvePiModel } from "./pi-model-selection.js";
import { validatePiVersion } from "./pi-version-policy.js";

export const PI_NOT_FOUND_ERROR = diagnosticMessage(
  "PI_NOT_FOUND",
  "Pi is not installed or is not on PATH. Install the Pi coding agent, then verify it with `pi --version`: https://github.com/earendil-works/pi/tree/main/packages/coding-agent",
);

export const PI_NO_MODELS_ERROR = diagnosticMessage(
  "PI_NO_MODELS",
  "Pi is installed but has no available configured models without extensions. Run `pi`, use `/login` to configure a built-in provider, then verify the result with `pi --offline --no-approve --no-extensions --list-models`.",
);

export const PI_MODELS_CONFIG_INVALID_ERROR = diagnosticMessage(
  "PI_MODELS_CONFIG_INVALID",
  "Pi reported that models.json could not be loaded. Run `pi --offline --no-approve --no-extensions --list-models`, fix every reported models.json error, then retry. Pioneer will not use a partial model catalog.",
);

export function piConfigSandboxError(agentDir: string, evidence: string): string {
  return diagnosticMessage(
    "PI_CONFIG_HIDDEN_BY_SANDBOX",
    `Pi reported no configured models, but this terminal appears unable to expose Pi configuration at ${agentDir} (${evidence}). This needs to run in an escalated terminal; it will not work inside an agent sandbox that hides Pi configuration. Approve scoped filesystem access or run from an unsandboxed terminal. Pioneer still sandboxes the Pi review actor. This metadata check did not read configuration contents.`,
  );
}

export interface PiConfigAccess {
  readonly status: "accessible" | "missing" | "denied";
  readonly errorCode?: string;
}

export type PiConfigAccessProbe = (agentDir: string) => Promise<PiConfigAccess>;

export interface PiProbeResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly errorCode?: string;
}

export type PiProbeRunner = (
  args: readonly string[],
  signal?: AbortSignal,
) => Promise<PiProbeResult>;

export interface PiReadiness {
  readonly ready: boolean;
  readonly version?: string;
  readonly modelCount: number;
  readonly resolvedModel?: string;
  readonly models?: readonly PiConfiguredModel[];
  readonly warning?: string;
  readonly errors: readonly string[];
}

export interface PiReadinessOptions {
  readonly configAccessProbe?: PiConfigAccessProbe;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly executable?: string;
  readonly runner?: PiProbeRunner;
  readonly requestedModel?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

const MAX_CAPTURE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const PI_CONFIG_MARKERS = ["auth.json", "models-store.json", "settings.json"] as const;
const OUTER_SANDBOX_INDICATORS = [
  "CODEX_PERMISSION_PROFILE",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "PIONEER_OUTER_SANDBOX",
] as const;

const PI_READINESS_ENVIRONMENT_NAME =
  /^(?:PATH|PATHEXT|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|SYSTEMROOT|WINDIR|COMSPEC|LANG|LC_ALL|TMPDIR|TMP|TEMP|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|OPENSSL_CONF|PI_CODING_AGENT_DIR)$/i;
const PI_MODEL_FIELD = /^[A-Za-z0-9][A-Za-z0-9._:@+/-]*$/;
const AUTHENTICATED_URL = /[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@/i;
const CREDENTIAL_ASSIGNMENT =
  /(?:^|[-._/@+:])(?:[a-z0-9]+[-._/@+:])*(?:credential|key|token|secret|password|passphrase|connection[-._/@+:]?string)(?:[-._/@+:][a-z0-9]+)*[:=]/i;

export function piReadinessEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => PI_READINESS_ENVIRONMENT_NAME.test(name)),
  );
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? "unknown";
}

export async function probePiConfigAccess(agentDir: string): Promise<PiConfigAccess> {
  try {
    await access(agentDir, constants.R_OK | constants.X_OK);
  } catch (error) {
    const code = errorCode(error);
    return code === "ENOENT" ? { status: "missing" } : { status: "denied", errorCode: code };
  }

  for (const marker of PI_CONFIG_MARKERS) {
    try {
      await access(path.join(agentDir, marker), constants.R_OK);
      return { status: "accessible" };
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOENT") return { status: "denied", errorCode: code };
    }
  }
  return { status: "accessible" };
}

function outerSandboxIndicator(environment: Readonly<NodeJS.ProcessEnv>): string | undefined {
  const explicit = OUTER_SANDBOX_INDICATORS.find((name) => Boolean(environment[name]));
  if (explicit !== undefined) return explicit;
  return Object.keys(environment).find(
    (name) => /(?:^|_)(?:AGENT_)?SANDBOX(?:_|$)/i.test(name) && Boolean(environment[name]),
  );
}

function summarizeFailure(result: PiProbeResult): string {
  const output = result.stderr || result.stdout;
  return diagnosticMessage(
    "PI_PROBE_FAILED",
    `Pi could not start successfully (exit ${result.exitCode ?? "unknown"}; output: ${output.trim() ? "present" : "none"})`,
  );
}

function configuredModels(output: string): readonly PiConfiguredModel[] | undefined {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.some((line) => line.startsWith("No models available."))) return [];

  const headerIndex = lines.findIndex((line) => /^provider\s+model\s+/i.test(line));
  if (headerIndex < 0) return undefined;
  const models: PiConfiguredModel[] = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const columns = line.split(/\s+/);
    const provider = columns[0];
    const id = columns[1];
    if (
      !provider ||
      !id ||
      !PI_MODEL_FIELD.test(provider) ||
      !PI_MODEL_FIELD.test(id) ||
      AUTHENTICATED_URL.test(provider) ||
      AUTHENTICATED_URL.test(id) ||
      CREDENTIAL_ASSIGNMENT.test(provider) ||
      CREDENTIAL_ASSIGNMENT.test(id)
    ) {
      return undefined;
    }
    models.push({ provider, id });
  }
  return models;
}

function lacksNoApproveOption(result: PiProbeResult): boolean {
  return /unknown option[^\n]*--no-approve/i.test(`${result.stderr}\n${result.stdout}`);
}

function hasInvalidModelsConfig(result: PiProbeResult): boolean {
  return /(?:errors?\s+loading|failed\s+to\s+load)\s+models\.json/i.test(
    `${result.stderr}\n${result.stdout}`,
  );
}

function createRunner(
  executable: string,
  timeoutMs: number,
  environment: Readonly<NodeJS.ProcessEnv>,
): PiProbeRunner {
  return async (args, signal) =>
    await new Promise((resolve) => {
      const child = spawn(executable, args, {
        env: {
          ...piReadinessEnvironment(environment),
          NO_COLOR: "1",
          PI_TELEMETRY: "0",
        },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const onAbort = (): void => {
        child.kill("SIGKILL");
        finish({
          exitCode: null,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: "Pi readiness probe was interrupted",
          errorCode: "ABORT_ERR",
        });
      };

      const finish = (result: PiProbeResult): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const append = (chunks: Buffer[], chunk: Buffer, currentBytes: number): number => {
        const remaining = MAX_CAPTURE_BYTES - currentBytes;
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        return currentBytes + chunk.length;
      };

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes = append(stdout, chunk, stdoutBytes);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes = append(stderr, chunk, stderrBytes);
      });
      child.once("error", (error: NodeJS.ErrnoException) => {
        finish({
          exitCode: null,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          ...(error.code === undefined ? {} : { errorCode: error.code }),
        });
      });
      child.once("exit", (exitCode) => {
        finish({
          exitCode,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });

      if (signal?.aborted === true) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });

      timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({
          exitCode: null,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: `Pi readiness probe timed out after ${timeoutMs}ms`,
        });
      }, timeoutMs);
    });
}

export async function checkPiReadiness(options: PiReadinessOptions = {}): Promise<PiReadiness> {
  const runner =
    options.runner ??
    createRunner(
      options.executable ?? "pi",
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      options.environment ?? process.env,
    );
  const runProbe = async (args: readonly string[]): Promise<PiProbeResult> =>
    options.signal === undefined ? await runner(args) : await runner(args, options.signal);
  const versionResult = await runProbe(["--version"]);
  if (versionResult.errorCode === "ENOENT") {
    return { ready: false, modelCount: 0, errors: [PI_NOT_FOUND_ERROR] };
  }
  if (versionResult.exitCode !== 0) {
    return {
      ready: false,
      modelCount: 0,
      errors: [summarizeFailure(versionResult)],
    };
  }

  const probedVersion = versionResult.stdout.trim().split(/\r?\n/, 1)[0] || "unknown";
  const versionValidation = validatePiVersion(probedVersion);
  if (versionValidation.error !== undefined) {
    return {
      ready: false,
      version: sanitizeDiagnostic(probedVersion),
      modelCount: 0,
      errors: [sanitizeDiagnostic(versionValidation.error)],
    };
  }
  const version = sanitizeDiagnostic(probedVersion);
  const versionWarning =
    versionValidation.warning === undefined
      ? {}
      : { warning: sanitizeDiagnostic(versionValidation.warning) };
  const modelsResult = await runProbe([
    "--offline",
    "--no-approve",
    "--no-extensions",
    "--list-models",
  ]);
  if (hasInvalidModelsConfig(modelsResult)) {
    return {
      ready: false,
      version,
      modelCount: 0,
      models: [],
      ...versionWarning,
      errors: [PI_MODELS_CONFIG_INVALID_ERROR],
    };
  }
  if (lacksNoApproveOption(modelsResult)) {
    return {
      ready: false,
      version,
      modelCount: 0,
      ...versionWarning,
      errors: [
        diagnosticMessage(
          "PI_CLI_INCOMPATIBLE",
          `Pi ${version} does not provide the required --no-approve project-trust control. Reinstall an official supported Pi release and verify that \`pi --help\` lists --no-approve.`,
        ),
      ],
    };
  }
  if (modelsResult.exitCode !== 0) {
    return {
      ready: false,
      version,
      modelCount: 0,
      ...versionWarning,
      errors: [summarizeFailure(modelsResult)],
    };
  }

  const probedModels = configuredModels(modelsResult.stdout);
  const models = probedModels;
  if (models?.length === 0) {
    const agentDir = defaultPiAgentDir(options.environment ?? process.env);
    const configAccess = await (options.configAccessProbe ?? probePiConfigAccess)(agentDir);
    const sandboxIndicator = outerSandboxIndicator(options.environment ?? process.env);
    return {
      ready: false,
      version,
      modelCount: 0,
      ...versionWarning,
      errors: [
        configAccess.status === "denied" || sandboxIndicator !== undefined
          ? piConfigSandboxError(
              agentDir,
              configAccess.status === "denied"
                ? `metadata access ${configAccess.errorCode ?? "unknown"}`
                : `outer agent sandbox indicator ${sandboxIndicator}; access metadata was inconclusive`,
            )
          : PI_NO_MODELS_ERROR,
      ],
    };
  }
  if (models === undefined) {
    return {
      ready: false,
      version,
      modelCount: 0,
      ...versionWarning,
      errors: [
        diagnosticMessage(
          "PI_MODEL_LIST_UNRECOGNIZED",
          "Pi returned an unrecognized model listing. Run `pi --offline --no-approve --no-extensions --list-models` and resolve any startup warnings before retrying.",
        ),
      ],
    };
  }

  const modelCount = models.length;
  if (options.requestedModel !== undefined) {
    const resolution = resolvePiModel(options.requestedModel, probedModels ?? []);
    if (!resolution.ok) {
      return {
        ready: false,
        version,
        modelCount,
        models,
        ...versionWarning,
        errors: [sanitizeDiagnostic(resolution.error)],
      };
    }
    return {
      ready: true,
      version,
      modelCount,
      resolvedModel: resolution.qualifiedName,
      models,
      ...versionWarning,
      errors: [],
    };
  }

  return { ready: true, version, modelCount, models, ...versionWarning, errors: [] };
}

export async function assertPiReady(options: PiReadinessOptions = {}): Promise<PiReadiness> {
  const readiness = await checkPiReadiness(options);
  if (!readiness.ready) throw new Error(readiness.errors.join("; "));
  return readiness;
}
