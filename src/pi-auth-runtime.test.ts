import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";
import { readAuthWorkerResult, snapshotOAuthProviders } from "./pi-auth-runtime.js";

const { createTempDir } = registerManagedTempPaths();

it("reads a complete result across short reads and rejects premature EOF", async () => {
  const bytes = Buffer.from('{"credential":"rotated"}');
  const reader = {
    async read(buffer: Buffer, offset: number, length: number, position: number) {
      const count = Math.min(3, length, bytes.length - position);
      bytes.copy(buffer, offset, position, position + count);
      return { bytesRead: count };
    },
  };
  expect(await readAuthWorkerResult(reader, bytes.length)).toEqual(bytes);
  await expect(readAuthWorkerResult(reader, bytes.length + 1)).rejects.toThrow(
    "Incomplete OAuth worker result",
  );
});

it("retains OAuth provider names accepted by the model catalog", async () => {
  const home = await createTempDir("pi-provider-names-");
  await writeFile(
    path.join(home, "auth.json"),
    JSON.stringify({
      "fixture:@+/id": { type: "oauth", access: "fixture", refresh: "fixture", expires: 1 },
    }),
  );
  expect(await snapshotOAuthProviders(home)).toEqual(new Set(["fixture:@+/id"]));
});
