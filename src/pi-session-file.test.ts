import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";
import { isPiSessionFile, PI_SESSION_SCAN_LINE_LIMIT } from "./pi-session-file.js";

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
    await writeFile(file, `"${"x".repeat(PI_SESSION_SCAN_LINE_LIMIT)}"\n`);
    await expect(isPiSessionFile(file)).resolves.toBe(true);
  });

  it("does not classify directories", async () => {
    const root = await createTempDir("pi-session-file-directory-");
    await mkdir(path.join(root, "folder.jsonl"));
    await expect(isPiSessionFile(path.join(root, "folder.jsonl"))).resolves.toBe(false);
  });
});
