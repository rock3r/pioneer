import path from "node:path";

export interface ParsedReviewCliArgs {
  readonly sourceDir: string | undefined;
  readonly prompt: string | undefined;
  readonly model: string | undefined;
  readonly thinkingText: string | undefined;
  readonly piHomeSource: string | undefined;
  readonly piHomeIncludes: readonly string[];
  readonly allowReadPaths: readonly string[];
  readonly allowWritePaths: readonly string[];
  readonly reportPath: string | undefined;
  readonly workLogPath: string | undefined;
  readonly networkText: string;
  readonly timeoutText: string | undefined;
  readonly allowUnsandboxedWindows: boolean;
  readonly remaining: readonly string[];
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  args.splice(index, 2);
  return value;
}

function takeRepeated(args: string[], name: string, resolve: boolean): string[] {
  const values: string[] = [];
  for (;;) {
    const value = takeOption(args, name);
    if (value === undefined) return values;
    values.push(resolve ? path.resolve(value) : value);
  }
}

export function parseReviewCliArgs(rawArgs: readonly string[]): ParsedReviewCliArgs {
  const args = [...rawArgs];
  const unsafeIndex = args.indexOf("--allow-unsandboxed-windows");
  const allowUnsandboxedWindows = unsafeIndex >= 0;
  if (unsafeIndex >= 0) args.splice(unsafeIndex, 1);
  return {
    sourceDir: takeOption(args, "--source"),
    prompt: takeOption(args, "--prompt"),
    model: takeOption(args, "--model"),
    thinkingText: takeOption(args, "--thinking"),
    piHomeSource: takeOption(args, "--pi-home"),
    piHomeIncludes: takeRepeated(args, "--pi-home-include", false),
    allowReadPaths: takeRepeated(args, "--allow-read", true),
    allowWritePaths: takeRepeated(args, "--allow-write", true),
    reportPath: takeOption(args, "--report"),
    workLogPath: takeOption(args, "--work-log"),
    networkText: takeOption(args, "--network") ?? "full",
    timeoutText: takeOption(args, "--timeout-ms"),
    allowUnsandboxedWindows,
    remaining: args,
  };
}
