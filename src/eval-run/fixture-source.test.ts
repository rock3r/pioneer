import {
  access,
  appendFile,
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerManagedTempPaths } from "../../test/support/temp-dir.js";
import {
  EVAL_FIXTURE_MAX_BYTES,
  type EvalFixtureReader,
  openEvalFixture,
  scanEvalFixture,
} from "./fixture-source.js";

const { createTempDir } = registerManagedTempPaths();

async function createSource(
  contents: string,
): Promise<{ root: string; source: string; out: string }> {
  const root = await createTempDir("pioneer-fixture-source-");
  const source = path.join(root, "panel.kt");
  await writeFile(source, contents);
  const out = path.join(root, "out");
  await mkdir(out);
  return { root, source, out };
}

describe("openEvalFixture", () => {
  it("documents a 64 MiB ceiling", () => {
    expect(EVAL_FIXTURE_MAX_BYTES).toBe(64 * 1024 * 1024);
  });

  it("rejects a fixture over the ceiling from fstat before reading it", async () => {
    const { root } = await createSource("");
    const huge = path.join(root, "huge.bin");
    await writeFile(huge, "");
    // Sparse: the size check must fire from fstat, so no 64 MiB is ever read.
    await truncate(huge, EVAL_FIXTURE_MAX_BYTES + 1);

    await expect(openEvalFixture(huge, "evals/files/huge.bin")).rejects.toThrow(
      /\[EVAL_FIXTURE_TOO_LARGE\].*64 MiB.*evals\/files\/huge\.bin/,
    );
  });

  it("reopens a validated fixture only while its identity is unchanged", async () => {
    const { source, out } = await createSource("class Panel\n");
    const validated = await openEvalFixture(source, "evals/files/panel.kt");
    const identity = validated.identity;
    await validated.close();

    const same = await openEvalFixture(source, "evals/files/panel.kt", undefined, identity);
    try {
      await same.stageTo(path.join(out, "panel.kt"));
    } finally {
      await same.close();
    }
    expect(await readFile(path.join(out, "panel.kt"), "utf8")).toBe("class Panel\n");

    await appendFile(source, "// changed\n");
    await expect(
      openEvalFixture(source, "evals/files/panel.kt", undefined, identity),
    ).rejects.toThrow(/\[EVAL_FIXTURE_CHANGED\].*evals\/files\/panel\.kt/);
  });

  it("rejects a leaking content marker when it opens the fixture", async () => {
    const { source } = await createSource("// todo: the off-by-one\n");

    await expect(openEvalFixture(source, "evals/files/panel.kt")).rejects.toThrow(
      /\[EVAL_FIXTURE_LEAK\].*TODO:.*evals\/files\/panel\.kt/,
    );
  });

  // Windows refuses to rename over a file that is open, so this swap cannot happen there.
  it.skipIf(process.platform === "win32")(
    "stages the bytes it scanned even after the path is replaced",
    async () => {
      const { root, source, out } = await createSource("class Panel\n");
      const opened = await openEvalFixture(source, "evals/files/panel.kt");
      try {
        const replacement = path.join(root, "replacement.kt");
        await writeFile(replacement, "// BUG: swapped in after the scan\n");
        await rename(replacement, source);

        const destination = path.join(out, "panel.kt");
        await opened.stageTo(destination);
        expect(await readFile(destination, "utf8")).toBe("class Panel\n");
      } finally {
        await opened.close();
      }
    },
  );

  it("rescans while staging and removes a copy whose file gained a marker", async () => {
    const { source, out } = await createSource("class Panel\n");
    const opened = await openEvalFixture(source, "evals/files/panel.kt");
    try {
      await appendFile(source, "// FIXME appended after the scan\n");

      const destination = path.join(out, "panel.kt");
      await expect(opened.stageTo(destination)).rejects.toThrow(/\[EVAL_FIXTURE_LEAK\].*FIXME/);
      await expect(access(destination)).rejects.toThrow();
    } finally {
      await opened.close();
    }
  });

  it("removes a copy when the file changed while it was staged", async () => {
    const { source, out } = await createSource("class Panel\n");
    const opened = await openEvalFixture(source, "evals/files/panel.kt");
    try {
      await appendFile(source, "val clean = true\n");

      const destination = path.join(out, "panel.kt");
      await expect(opened.stageTo(destination)).rejects.toThrow(
        /\[EVAL_FIXTURE_CHANGED\].*evals\/files\/panel\.kt/,
      );
      await expect(access(destination)).rejects.toThrow();
    } finally {
      await opened.close();
    }
  });

  it("stages the same opened file into several destinations", async () => {
    const { source, out } = await createSource("class Panel\n");
    const opened = await openEvalFixture(source, "evals/files/panel.kt");
    try {
      await opened.stageTo(path.join(out, "a.kt"));
      await opened.stageTo(path.join(out, "b.kt"));
      expect(await readFile(path.join(out, "a.kt"), "utf8")).toBe("class Panel\n");
      expect(await readFile(path.join(out, "b.kt"), "utf8")).toBe("class Panel\n");
    } finally {
      await opened.close();
    }
  });

  it("keeps an existing destination, like a non-forcing copy", async () => {
    const { source, out } = await createSource("class Panel\n");
    const destination = path.join(out, "panel.kt");
    await writeFile(destination, "first staged copy\n");
    const opened = await openEvalFixture(source, "evals/files/panel.kt");
    try {
      await opened.stageTo(destination);
      expect(await readFile(destination, "utf8")).toBe("first staged copy\n");
    } finally {
      await opened.close();
    }
  });

  it.skipIf(process.platform === "win32")("keeps the source permission bits", async () => {
    const { source, out } = await createSource("#!/bin/sh\necho ok\n");
    await chmod(source, 0o750);
    const opened = await openEvalFixture(source, "evals/files/run.sh");
    try {
      const destination = path.join(out, "run.sh");
      await opened.stageTo(destination);
      expect((await stat(destination)).mode & 0o777).toBe(0o750);
    } finally {
      await opened.close();
    }
  });
});

describe("scanEvalFixture", () => {
  it("rechecks the ceiling while streaming a file that grows after fstat", async () => {
    let served = 0;
    const endless: EvalFixtureReader = {
      read(buffer, offset, length) {
        const bytesRead = Math.min(length, 16);
        buffer.fill(0x61, offset, offset + bytesRead);
        served += bytesRead;
        return Promise.resolve({ bytesRead });
      },
    };

    await expect(scanEvalFixture(endless, "evals/files/grow.txt", 100)).rejects.toThrow(
      /\[EVAL_FIXTURE_TOO_LARGE\].*evals\/files\/grow\.txt/,
    );
    expect(served).toBeLessThanOrEqual(100 + 16);
  });

  it("passes every scanned chunk to the writer", async () => {
    const content = Buffer.from("class Panel\n".repeat(20_000));
    const reader: EvalFixtureReader = {
      read(buffer, offset, length, position) {
        const bytesRead = content.copy(buffer, offset, position, position + length);
        return Promise.resolve({ bytesRead });
      },
    };
    const written: Buffer[] = [];

    await scanEvalFixture(reader, "evals/files/panel.kt", EVAL_FIXTURE_MAX_BYTES, (chunk) => {
      written.push(Buffer.from(chunk));
      return Promise.resolve();
    });
    expect(Buffer.concat(written).equals(content)).toBe(true);
  });
});
