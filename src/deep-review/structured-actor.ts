import { extractRawJsonObject, StructuredOutputError } from "./json-output.js";

export interface StructuredActorParseOptions<T> {
  readonly maxOutputBytes?: number;
  readonly parse: (value: unknown) => T;
}

export function parseStructuredActorOutput<T>(
  assistantText: string,
  options: StructuredActorParseOptions<T>,
): T {
  try {
    const raw = extractRawJsonObject(assistantText, options.maxOutputBytes);
    return options.parse(raw);
  } catch (error) {
    if (error instanceof StructuredOutputError) throw error;
    throw new StructuredOutputError(
      "DEEP_REVIEW_OUTPUT_INVALID",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export interface StructuredActorLaunchOptions {
  readonly model: string;
  readonly thinking?: string;
  readonly tools: readonly string[];
  readonly extensionPath: string;
  readonly piHomeDir: string;
  readonly sessionDir: string;
  readonly actorEnvironment: Readonly<Record<string, string>>;
}

export function buildStructuredActorPiCommand(
  piExecutable: string,
  options: StructuredActorLaunchOptions,
): readonly [string, ...string[]] {
  return [
    piExecutable,
    "--mode",
    "rpc",
    "--model",
    options.model,
    ...(options.thinking ? (["--thinking", options.thinking] as const) : []),
    "--offline",
    "--no-approve",
    "--no-extensions",
    "--extension",
    options.extensionPath,
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-builtin-tools",
    "--tools",
    options.tools.join(","),
    "--session-dir",
    options.sessionDir,
  ];
}

export function deepReviewActorEnvironment(
  base: Readonly<Record<string, string>>,
  options: {
    readonly piHomeDir: string;
    readonly homeDir: string;
    readonly tmpDir: string;
    readonly packetPath: string;
    readonly sourceDir: string;
    readonly candidateStorePath?: string;
  },
): Readonly<Record<string, string>> {
  return {
    ...base,
    PI_CODING_AGENT_DIR: options.piHomeDir,
    HOME: options.homeDir,
    TMPDIR: options.tmpDir,
    PIONEER_DEEP_REVIEW_PACKET_PATH: options.packetPath,
    PIONEER_DEEP_REVIEW_SOURCE_DIR: options.sourceDir,
    ...(options.candidateStorePath
      ? { PIONEER_DEEP_REVIEW_CANDIDATE_STORE: options.candidateStorePath }
      : {}),
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
  };
}
