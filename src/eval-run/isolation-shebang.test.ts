import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const observation = vi.hoisted(() => ({ readLengths: [] as number[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const originalRead = handle.read.bind(handle);
      return new Proxy(handle, {
        get(target, property) {
          if (property === "read") {
            return (...readArgs: unknown[]) => {
              const buffer = readArgs[0];
              const length =
                buffer instanceof Uint8Array ? buffer.byteLength : Number(readArgs[2] ?? 0);
              observation.readLengths.push(length);
              return Reflect.apply(originalRead, target, readArgs);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

import { MAX_SHEBANG_READ_BYTES, resolveEvalExecutable } from "./isolation.js";

describe("bounded eval shebang inspection", () => {
  it("reads only a bounded prefix of a large executable", async () => {
    observation.readLengths.length = 0;
    const temp = await mkdtemp(path.join(tmpdir(), "pioneer-eval-shebang-prefix-"));
    const runDir = path.join(temp, "run");
    const binDir = path.join(temp, "bin");
    await mkdir(runDir);
    await mkdir(binDir);
    const interpreter = path.join(binDir, "node");
    const actor = path.join(binDir, "actor");
    await writeFile(interpreter, "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(actor, `#!/usr/bin/env node\n${"x".repeat(8 * 1024 * 1024)}`, { mode: 0o755 });

    await expect(resolveEvalExecutable("actor", runDir, binDir)).resolves.toMatchObject({
      command: [interpreter, actor],
    });
    expect(observation.readLengths).toEqual([MAX_SHEBANG_READ_BYTES, MAX_SHEBANG_READ_BYTES]);
  });

  it("rejects a shebang whose first line exceeds the bounded prefix", async () => {
    observation.readLengths.length = 0;
    const temp = await mkdtemp(path.join(tmpdir(), "pioneer-eval-shebang-prefix-"));
    const runDir = path.join(temp, "run");
    const binDir = path.join(temp, "bin");
    await mkdir(runDir);
    await mkdir(binDir);
    const final = path.join(binDir, "final");
    const actor = path.join(binDir, "actor");
    await writeFile(final, "#!/bin/sh\n", { mode: 0o755 });
    const prefix = "#!/usr/bin/env final";
    const truncatedPrefix = prefix + " ".repeat(MAX_SHEBANG_READ_BYTES - Buffer.byteLength(prefix));
    await writeFile(actor, `${truncatedPrefix}not-whitespace\n`, { mode: 0o755 });

    await expect(resolveEvalExecutable("actor", runDir, binDir)).rejects.toThrow(
      "[EVAL_SHEBANG_RESOLUTION_FAILED]",
    );
  });

  it("keeps a non-shebang binary with no newline valid", async () => {
    observation.readLengths.length = 0;
    const temp = await mkdtemp(path.join(tmpdir(), "pioneer-eval-shebang-binary-"));
    const runDir = path.join(temp, "run");
    const binDir = path.join(temp, "bin");
    await mkdir(runDir);
    await mkdir(binDir);
    const actor = path.join(binDir, "actor");
    await writeFile(actor, Buffer.concat([Buffer.from("\x7fELF"), Buffer.alloc(8 * 1024 * 1024)]), {
      mode: 0o755,
    });

    await expect(resolveEvalExecutable("actor", runDir, binDir)).resolves.toMatchObject({
      commandPath: await realpath(actor),
      readPaths: [...new Set([actor, await realpath(actor)])],
    });
  });
});
