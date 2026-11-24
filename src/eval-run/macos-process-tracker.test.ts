import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type MacosEvalProcess,
  MacosEvalProcessTracker,
  parseMacosProcessTable,
  parseMacosWorkingDirectories,
} from "./macos-process-tracker.js";

const userId = 501;
const runDir = path.resolve("run");
const rootPid = 999_010;
const root = { pid: rootPid, parentPid: process.pid, groupId: rootPid, userId, startedAt: 2 };

function entry(pid: number, parentPid: number, groupId = rootPid): MacosEvalProcess {
  return { pid, parentPid, groupId, userId, startedAt: 3 };
}

function createTracker(initial: MacosEvalProcess[] = [], launch: MacosEvalProcess[] = [root]) {
  let table = launch;
  let inspected: readonly MacosEvalProcess[] | undefined;
  const directories = new Map<number, string>();
  const signal = vi.fn();
  const readWorkingDirectories = vi.fn(() => directories);
  const tracker = new MacosEvalProcessTracker(
    {
      userId,
      readProcesses: (pids) =>
        pids === undefined ? table : (inspected ?? table).filter(({ pid }) => pids.includes(pid)),
      readWorkingDirectories,
      signal,
    },
    runDir,
    initial,
  );
  tracker.start(rootPid);
  return {
    tracker,
    directories,
    readWorkingDirectories,
    signal,
    setTable: (entries: MacosEvalProcess[]) => {
      table = entries;
    },
    setRevalidation: (entries: MacosEvalProcess[]) => {
      inspected = entries;
    },
  };
}

describe("macOS eval process tracking", () => {
  it("keeps a witnessed process through reparenting and a group change", () => {
    const child = entry(999_011, rootPid);
    const fixture = createTracker([], [root, child]);
    fixture.setTable([{ ...child, parentPid: 1, groupId: child.pid }]);

    expect(fixture.tracker.stop("SIGTERM")).toBe(false);
    expect(fixture.signal).toHaveBeenCalledExactlyOnceWith(child.pid, "SIGTERM");

    fixture.setTable([]);
    expect(fixture.tracker.stop("SIGKILL")).toBe(true);
  });

  it("skips a PID replacement between the snapshot and signal", () => {
    const child = entry(999_011, rootPid);
    const fixture = createTracker([], [root, child]);
    const replacement = { ...child, parentPid: 123, groupId: 123, startedAt: 4 };
    fixture.setRevalidation([replacement]);

    expect(fixture.tracker.stop("SIGKILL")).toBe(false);
    expect(fixture.signal).not.toHaveBeenCalled();

    fixture.setTable([replacement]);
    expect(fixture.tracker.stop("SIGKILL")).toBe(true);
  });

  it("recovers a new run-directory orphan using a surviving group member as evidence", () => {
    const child = entry(999_011, rootPid);
    const orphan = entry(999_012, 1);
    const fixture = createTracker([], [root, child]);
    fixture.setTable([{ ...child, parentPid: 1 }, orphan]);
    fixture.directories.set(orphan.pid, path.join(runDir, "subdirectory"));

    expect(fixture.tracker.stop("SIGKILL")).toBe(false);
    expect(fixture.readWorkingDirectories).toHaveBeenCalledExactlyOnceWith([orphan.pid]);
    expect(fixture.signal.mock.calls).toEqual([
      [child.pid, "SIGKILL"],
      [orphan.pid, "SIGKILL"],
    ]);
  });

  it("leaves ambiguous, baseline, different-user, and outside-directory processes untouched", () => {
    const baseline = entry(999_011, 1);
    const orphan = entry(999_012, 1);
    const outside = entry(999_013, 1);
    const differentUser = { ...entry(999_014, 1), userId: 1000 };
    const fixture = createTracker([baseline]);
    fixture.setTable([baseline, orphan, outside, differentUser]);
    fixture.directories.set(baseline.pid, runDir);
    fixture.directories.set(orphan.pid, runDir);
    fixture.directories.set(outside.pid, `${runDir}-other`);
    fixture.directories.set(differentUser.pid, runDir);

    expect(fixture.tracker.stop("SIGKILL")).toBe(false);
    expect(fixture.readWorkingDirectories).toHaveBeenCalledExactlyOnceWith([
      orphan.pid,
      outside.pid,
    ]);
    expect(fixture.signal).not.toHaveBeenCalled();

    fixture.setTable([baseline, outside, differentUser]);
    expect(fixture.tracker.stop("SIGKILL")).toBe(true);
  });

  it("rejects malformed process rows and parses NUL-delimited working directories", () => {
    expect(parseMacosProcessTable("1 0 1 0 R Tue Nov 24 05:15:53 2026\n")).toEqual([
      {
        pid: 1,
        parentPid: 0,
        groupId: 1,
        userId: 0,
        startedAt: Date.UTC(2026, 10, 24, 5, 15, 53),
        zombie: false,
      },
    ]);
    expect(parseMacosProcessTable("1 0 1 0 R malformed")).toBeUndefined();
    expect(
      parseMacosWorkingDirectories(`p7\0\nfcwd\0n${runDir}\0\nftxt\0n${runDir}/txt\0\n`),
    ).toEqual(new Map([[7, runDir]]));
  });
});
