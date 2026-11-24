import { spawnSync } from "node:child_process";
import path from "node:path";

export interface MacosEvalProcess {
  readonly pid: number;
  readonly parentPid: number;
  readonly groupId: number;
  readonly userId: number;
  readonly startedAt: number;
  readonly zombie?: boolean;
}

export interface MacosEvalProcessOperations {
  readonly userId: number;
  readProcesses(pids?: readonly number[]): readonly MacosEvalProcess[] | undefined;
  readWorkingDirectories(pids: readonly number[]): ReadonlyMap<number, string> | undefined;
  signal(pid: number, signal: NodeJS.Signals): void;
}

const PS_FORMAT = "pid=,ppid=,pgid=,uid=,stat=,lstart=";
const PS_ROW =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s*$/;
const MAX_INSPECTED_PIDS = 128;

function readSystemProcessMetadata(
  executable: string,
  args: string[],
  allowEmpty = false,
): string | undefined {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    env: { LC_ALL: "C", TZ: "UTC" },
    shell: false,
    timeout: 250,
    maxBuffer: 1024 * 1024,
  });
  if (result.error !== undefined) return undefined;
  if (result.status === 0) return result.stdout;
  if (allowEmpty && result.status === 1 && result.stderr.length === 0) return result.stdout;
  return undefined;
}

export function parseMacosProcessTable(output: string): readonly MacosEvalProcess[] | undefined {
  const processes = new Map<number, MacosEvalProcess>();
  for (const line of output.trim().split("\n")) {
    if (line.trim().length === 0) continue;
    const match = PS_ROW.exec(line);
    if (match === null) return undefined;
    const [, rawPid, rawParent, rawGroup, rawUser, status, started] = match;
    const pid = Number(rawPid);
    const parentPid = Number(rawParent);
    const groupId = Number(rawGroup);
    const userId = Number(rawUser);
    const startedAt = Date.parse(`${started} UTC`);
    if (
      ![pid, parentPid, groupId, userId, startedAt].every(Number.isSafeInteger) ||
      pid <= 0 ||
      processes.has(pid)
    )
      return undefined;
    processes.set(pid, {
      pid,
      parentPid,
      groupId,
      userId,
      startedAt,
      zombie: status?.startsWith("Z") === true,
    });
  }
  return [...processes.values()];
}

export function parseMacosWorkingDirectories(output: string): ReadonlyMap<number, string> {
  const directories = new Map<number, string>();
  let pid: number | undefined;
  let cwd = false;
  for (const field of output.split("\0")) {
    const record = field.startsWith("\n") ? field.slice(1) : field;
    if (record.startsWith("p")) {
      const candidate = Number(record.slice(1));
      pid = Number.isSafeInteger(candidate) && candidate > 0 ? candidate : undefined;
      cwd = false;
    } else if (record.startsWith("f")) {
      cwd = record === "fcwd";
    } else if (record.startsWith("n") && pid !== undefined && cwd) {
      const name = record.slice(1);
      if (path.isAbsolute(name)) directories.set(pid, name);
    }
  }
  return directories;
}

export const nativeMacosEvalProcessOperations: MacosEvalProcessOperations = {
  userId: process.geteuid?.() ?? -1,
  readProcesses(pids) {
    const args = pids === undefined ? ["-axo", PS_FORMAT] : ["-o", PS_FORMAT, "-p", pids.join(",")];
    const output = readSystemProcessMetadata("/bin/ps", args, pids !== undefined);
    const processes = output === undefined ? undefined : parseMacosProcessTable(output);
    return pids === undefined && processes?.length === 0 ? undefined : processes;
  },
  readWorkingDirectories(pids) {
    const output = readSystemProcessMetadata(
      "/usr/sbin/lsof",
      ["-nP", "-b", "-w", "-a", "-p", pids.join(","), "-d", "cwd", "-F0fn"],
      true,
    );
    return output === undefined ? undefined : parseMacosWorkingDirectories(output);
  },
  signal(pid, signal) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  },
};

function sameProcess(left: MacosEvalProcess | undefined, right: MacosEvalProcess): boolean {
  return (
    left?.pid === right.pid && left.startedAt === right.startedAt && left.userId === right.userId
  );
}

function inRunDirectory(runDir: string, directory: string): boolean {
  const relative = path.relative(runDir, directory);
  return !path.isAbsolute(relative) && relative.split(path.sep)[0] !== "..";
}

export class MacosEvalProcessTracker {
  readonly #operations: MacosEvalProcessOperations;
  readonly #runDir: string;
  readonly #initial = new Map<number, MacosEvalProcess>();
  readonly #observed = new Map<number, MacosEvalProcess>();
  #root: MacosEvalProcess | undefined;

  constructor(
    operations: MacosEvalProcessOperations,
    runDir: string,
    initial: readonly MacosEvalProcess[],
  ) {
    this.#operations = operations;
    this.#runDir = runDir;
    for (const entry of initial) this.#initial.set(entry.pid, entry);
  }

  start(pid: number): void {
    const root = this.#operations.readProcesses([pid])?.find((entry) => entry.pid === pid);
    if (root?.parentPid !== process.pid || root.groupId !== pid || !this.#isNewOwnedCandidate(root))
      return;
    this.#root = root;
    this.#observed.set(pid, root);
    this.observe();
  }

  #isNewOwnedCandidate(entry: MacosEvalProcess): boolean {
    return (
      entry.pid > 1 &&
      entry.pid !== process.pid &&
      entry.userId === this.#operations.userId &&
      !sameProcess(this.#initial.get(entry.pid), entry)
    );
  }

  #observe(entries: readonly MacosEvalProcess[]): MacosEvalProcess[] {
    const byParent = new Map<number, MacosEvalProcess[]>();
    const current: MacosEvalProcess[] = [];
    const visited = new Set<number>();
    const root = this.#root;
    const liveRoot =
      root !== undefined && entries.some((entry) => sameProcess(root, entry) && !entry.zombie);
    for (const entry of entries) {
      if (!this.#isNewOwnedCandidate(entry)) continue;
      // A live detached leader anchors its original group within its private session.
      if (
        sameProcess(this.#observed.get(entry.pid), entry) ||
        (liveRoot && entry.groupId === root.pid && entry.startedAt >= root.startedAt)
      ) {
        this.#observed.set(entry.pid, entry);
        current.push(entry);
        visited.add(entry.pid);
      }
      const children = byParent.get(entry.parentPid);
      if (children === undefined) byParent.set(entry.parentPid, [entry]);
      else children.push(entry);
    }
    for (const owner of current) {
      for (const child of byParent.get(owner.pid) ?? []) {
        if (visited.has(child.pid) || child.startedAt < owner.startedAt) continue;
        visited.add(child.pid);
        this.#observed.set(child.pid, child);
        current.push(child);
      }
    }
    return current;
  }

  observe(): void {
    const entries = this.#operations.readProcesses();
    if (entries !== undefined) this.#observe(entries);
  }

  /** Signal only current instances with corroborated ownership. Report false until all are gone. */
  stop(signal: NodeJS.Signals): boolean {
    const root = this.#root;
    if (root === undefined) return false;
    const entries = this.#operations.readProcesses();
    if (entries === undefined) return false;
    const owned = this.#observe(entries);
    const anchoredGroup = owned.some((entry) => entry.groupId === root.pid && !entry.zombie);
    const live = owned.filter((entry) => entry.pid !== root.pid && !entry.zombie);
    const orphans = entries.filter(
      (entry) =>
        entry.parentPid === 1 &&
        entry.startedAt >= root.startedAt &&
        !entry.zombie &&
        this.#isNewOwnedCandidate(entry) &&
        !sameProcess(this.#observed.get(entry.pid), entry),
    );
    let uncertain = orphans.length > MAX_INSPECTED_PIDS;
    const inspected = orphans.slice(0, MAX_INSPECTED_PIDS);
    if (inspected.length > 0) {
      const directories = this.#operations.readWorkingDirectories(inspected.map(({ pid }) => pid));
      if (directories === undefined) uncertain = true;
      for (const orphan of inspected) {
        const directory = directories?.get(orphan.pid);
        if (directory === undefined || !inRunDirectory(this.#runDir, directory)) continue;
        if (anchoredGroup && orphan.groupId === root.pid) live.push(orphan);
        else uncertain = true;
      }
    }
    if (live.length === 0) return !uncertain;

    const targets = live.slice(0, MAX_INSPECTED_PIDS);
    const verified = this.#operations.readProcesses(targets.map(({ pid }) => pid));
    if (verified === undefined) return false;
    const verifiedByPid = new Map(verified.map((entry) => [entry.pid, entry]));
    for (const target of targets) {
      const current = verifiedByPid.get(target.pid);
      if (
        current === undefined ||
        current.zombie ||
        !sameProcess(target, current) ||
        current.groupId !== target.groupId
      )
        continue;
      // Remember the instance so later scans can recognize it after changes to its parent or cwd.
      this.#observed.set(current.pid, current);
      try {
        this.#operations.signal(current.pid, signal);
      } catch {
        // The next scan will either prove exit or report that cleanup remains incomplete.
      }
    }
    return false;
  }
}
