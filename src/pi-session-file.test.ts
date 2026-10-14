import { link, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";
import {
  createPiSessionScanBudget,
  isPiSessionFile,
  PI_SESSION_SCAN_BYTE_LIMIT,
  type PiSessionScanBudget,
} from "./pi-session-file.js";

const { createTempDir } = registerManagedTempPaths();

function budget(limits?: { readonly files: number; readonly bytes: number }): PiSessionScanBudget {
  return createPiSessionScanBudget(
    (detail) => new Error(`[TEST_SNAPSHOT_LIMIT] ${detail}`),
    limits,
  );
}

const header = JSON.stringify({
  type: "session",
  version: 3,
  id: "0199a1b2-0000-7000-8000-000000000000",
  timestamp: "2026-01-01T00:00:00.000Z",
  cwd: "/work/project",
});

describe("isPiSessionFile", () => {
  it("recognizes a Pi session by its header line, as Pi does", async () => {
    const root = await createTempDir("pi-session-file-");
    const cases: [string, string, boolean][] = [
      ["current.jsonl", `${header}\n{"type":"message"}\n`, true],
      ["upper.JSONL", `${header}\n`, true],
      ["bom-and-blank.jsonl", `﻿\n  \r\n${header}\r\n`, true],
      ["malformed-first.jsonl", `not json\n{"type":"session"}\n`, true],
      ["no-trailing-newline.jsonl", header, true],
      ["v1.jsonl", JSON.stringify({ type: "session", id: "x", cwd: "/" }), true],
      ["data.jsonl", '{"type":"record"}\n{"type":"session","id":"later"}\n', false],
      ["array.jsonl", '["session"]\n', false],
      ["falsy-first.jsonl", `null\n0\n${header}\n`, true],
      ["empty.jsonl", "", false],
      ["unparseable.jsonl", "nothing here\n", false],
      ["header.json", `${header}\n`, false],
    ];
    for (const [name, content] of cases) await writeFile(path.join(root, name), content);
    for (const [name, , expected] of cases)
      await expect(isPiSessionFile(path.join(root, name), budget()), name).resolves.toBe(expected);
  });

  it("treats a first line too long to classify as private history", async () => {
    const root = await createTempDir("pi-session-file-long-");
    const file = path.join(root, "long.jsonl");
    await writeFile(file, `"${"x".repeat(PI_SESSION_SCAN_BYTE_LIMIT * 2)}"\n`);
    await expect(isPiSessionFile(file, budget())).resolves.toBe(true);
  });

  it("bounds one file's scan and treats an undecided file as private history", async () => {
    const root = await createTempDir("pi-session-file-skipped-lines-");
    const file = path.join(root, "padded.jsonl");
    await writeFile(
      file,
      `${"not json\n".repeat(PI_SESSION_SCAN_BYTE_LIMIT / 8)}{"type":"record"}\n`,
    );
    await expect(isPiSessionFile(file, budget())).resolves.toBe(true);
  });

  it("checks the content of a hard-linked file whatever its name", async () => {
    const root = await createTempDir("pi-session-file-hard-link-");
    await writeFile(path.join(root, "history.jsonl"), `${header}\n`);
    await link(path.join(root, "history.jsonl"), path.join(root, "notes.txt"));
    await writeFile(path.join(root, "single.txt"), `${header}\n`);
    await expect(isPiSessionFile(path.join(root, "notes.txt"), budget())).resolves.toBe(true);
    await expect(isPiSessionFile(path.join(root, "single.txt"), budget())).resolves.toBe(false);
    // A one-link copy of a hard-linked source is checked when the source's link count is given.
    await expect(
      isPiSessionFile(path.join(root, "single.txt"), budget(), [path.join(root, "single.txt")], 2),
    ).resolves.toBe(true);
  });

  it("does not classify directories", async () => {
    const root = await createTempDir("pi-session-file-directory-");
    await mkdir(path.join(root, "folder.jsonl"));
    await expect(isPiSessionFile(path.join(root, "folder.jsonl"), budget())).resolves.toBe(false);
  });
});

describe("createPiSessionScanBudget", () => {
  it("defaults to the snapshot backstops of 500,000 files and 1 GiB", () => {
    const scans = budget();
    expect(scans).toMatchObject({ maxFiles: 500_000, maxBytes: 1024 ** 3, files: 0, bytes: 0 });
  });

  it("charges each opened file and the bytes read from it, but not a file skipped by name", async () => {
    const root = await createTempDir("pi-session-scan-charge-");
    const record = '{"type":"record"}\n';
    await writeFile(path.join(root, "notes.txt"), record);
    await writeFile(path.join(root, "data.jsonl"), record.repeat(3));
    const scans = budget();
    await expect(isPiSessionFile(path.join(root, "notes.txt"), scans)).resolves.toBe(false);
    expect(scans).toMatchObject({ files: 0, bytes: 0 });
    await expect(isPiSessionFile(path.join(root, "data.jsonl"), scans)).resolves.toBe(false);
    expect(scans).toMatchObject({ files: 1, bytes: record.length * 3 });
  });

  it("refuses a scan past the cumulative byte limit although each file stays under 1 MiB", async () => {
    const root = await createTempDir("pi-session-scan-bytes-");
    const padded = `${"\n".repeat(600 * 1024)}{"type":"record"}\n`;
    await writeFile(path.join(root, "first.jsonl"), padded);
    await writeFile(path.join(root, "second.jsonl"), padded);
    const scans = budget({ files: 10, bytes: 1024 * 1024 });
    await expect(isPiSessionFile(path.join(root, "first.jsonl"), scans)).resolves.toBe(false);
    await expect(isPiSessionFile(path.join(root, "second.jsonl"), scans)).rejects.toThrow(
      /^\[TEST_SNAPSHOT_LIMIT\] session-history scans exceed the 1\.0 MiB read limit \(1\.\d MiB read from 2 files\)\.$/u,
    );
  });

  it("refuses to open a file past the cumulative file limit", async () => {
    const root = await createTempDir("pi-session-scan-files-");
    for (const name of ["a.jsonl", "b.jsonl", "c.jsonl"])
      await writeFile(path.join(root, name), `${header}\n`);
    const scans = budget({ files: 2, bytes: 1024 ** 3 });
    await expect(isPiSessionFile(path.join(root, "a.jsonl"), scans)).resolves.toBe(true);
    await expect(isPiSessionFile(path.join(root, "b.jsonl"), scans)).resolves.toBe(true);
    await expect(isPiSessionFile(path.join(root, "c.jsonl"), scans)).rejects.toThrow(
      /^\[TEST_SNAPSHOT_LIMIT\] session-history scans exceed the 2-file limit \(3 files, 0\.0 MiB read\)\.$/u,
    );
    expect(scans.bytes).toBe((header.length + 1) * 2);
  });

  it("names the default read limit in GiB", async () => {
    const root = await createTempDir("pi-session-scan-gib-");
    await writeFile(path.join(root, "a.jsonl"), `${header}\n`);
    const scans = budget();
    scans.bytes = 1024 ** 3;
    await expect(isPiSessionFile(path.join(root, "a.jsonl"), scans)).rejects.toThrow(
      /exceed the 1 GiB read limit \(1024\.0 MiB read from 1 file\)\./u,
    );
  });
});
