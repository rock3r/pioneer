export interface OptimizedPiStartup {
  readonly command: readonly [string, ...string[]];
  readonly environment: Readonly<Record<string, string>>;
}

export interface PiStartupOptions {
  readonly disableExtensions?: boolean;
  readonly disableSkills?: boolean;
  readonly tools?: readonly string[];
}

const PI_STARTUP_ENVIRONMENT = {
  PI_OFFLINE: "1",
  PI_TELEMETRY: "0",
} as const;

function executableName(executable: string): string {
  return executable.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
}

export function isPiExecutable(executable: string): boolean {
  return ["pi", "pi.exe", "pi.cmd", "pi.bat"].includes(executableName(executable));
}

function hasAny(args: readonly string[], flags: readonly string[]): boolean {
  return flags.some((flag) => args.includes(flag));
}

function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const prefix = `${name}=`;
  return args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

export function requestedPiModel(command: readonly [string, ...string[]]): string | undefined {
  if (!isPiExecutable(command[0])) return undefined;
  const args = command.slice(1);
  const model = optionValue(args, "--model");
  if (!model) return undefined;
  const provider = optionValue(args, "--provider");
  return provider && !model.includes("/") ? `${provider}/${model}` : model;
}

export function optimizePiStartupCommand(
  command: readonly [string, ...string[]],
  options: PiStartupOptions = {},
): OptimizedPiStartup {
  if (!isPiExecutable(command[0])) return { command, environment: {} };

  const args = command.slice(1);
  const additions: string[] = [];
  if (!hasAny(args, ["--offline"])) additions.push("--offline");
  if (
    !hasAny(args, [
      "--no-session",
      "--session",
      "--session-id",
      "--continue",
      "-c",
      "--resume",
      "-r",
      "--fork",
    ])
  ) {
    additions.push("--no-session");
  }
  if (!hasAny(args, ["--no-approve", "-na", "--approve", "-a"])) additions.push("--no-approve");
  if (!hasAny(args, ["--no-prompt-templates", "-np", "--prompt-template"])) {
    additions.push("--no-prompt-templates");
  }
  if (!hasAny(args, ["--no-themes", "--theme"])) additions.push("--no-themes");
  if (options.disableExtensions && !hasAny(args, ["--no-extensions", "-ne"])) {
    additions.push("--no-extensions");
  }
  if (
    options.tools !== undefined &&
    !hasAny(args, ["--tools", "-t", "--no-tools", "-nt", "--no-builtin-tools", "-nbt"])
  ) {
    additions.push("--tools", options.tools.join(","));
  }
  if (options.disableSkills && !hasAny(args, ["--no-skills", "--skill"])) {
    additions.push("--no-skills");
  }

  return {
    command: [command[0], ...additions, ...args],
    environment: PI_STARTUP_ENVIRONMENT,
  };
}
