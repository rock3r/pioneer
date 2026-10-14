import { link, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";
import { isPiSessionFile, PI_SESSION_SCAN_BYTE_LIMIT } from "./pi-session-file.js";

const { createTempDir } = registerManagedTempPaths();

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
      await expect(isPiSessionFile(path.join(root, name)), name).resolves.toBe(expected);
  });

  it("treats a first line too long to classify as private history", async () => {
    const root = await createTempDir("pi-session-file-long-");
    const file = path.join(root, "long.jsonl");
    await writeFile(file, `"${"x".repeat(PI_SESSION_SCAN_BYTE_LIMIT * 2)}"\n`);
    await expect(isPiSessionFile(file)).resolves.toBe(true);
  });

  it("bounds the total scan and treats an undecided file as private history", async () => {
    const root = await createTempDir("pi-session-file-skipped-lines-");
    const file = path.join(root, "padded.jsonl");
    await writeFile(
      file,
      `${"not json\n".repeat(PI_SESSION_SCAN_BYTE_LIMIT / 8)}{"type":"record"}\n`,
    );
    await expect(isPiSessionFile(file)).resolves.toBe(true);
  });

  it("checks the content of a hard-linked file whatever its name", async () => {
    const root = await createTempDir("pi-session-file-hard-link-");
    await writeFile(path.join(root, "history.jsonl"), `${header}\n`);
    await link(path.join(root, "history.jsonl"), path.join(root, "notes.txt"));
    await writeFile(path.join(root, "single.txt"), `${header}\n`);
    await expect(isPiSessionFile(path.join(root, "notes.txt"))).resolves.toBe(true);
    await expect(isPiSessionFile(path.join(root, "single.txt"))).resolves.toBe(false);
    // A one-link copy of a hard-linked source is checked when the source's link count is given.
    await expect(
      isPiSessionFile(path.join(root, "single.txt"), [path.join(root, "single.txt")], 2),
    ).resolves.toBe(true);
  });

  it("does not classify directories", async () => {
    const root = await createTempDir("pi-session-file-directory-");
    await mkdir(path.join(root, "folder.jsonl"));
    await expect(isPiSessionFile(path.join(root, "folder.jsonl"))).resolves.toBe(false);
  });
});
