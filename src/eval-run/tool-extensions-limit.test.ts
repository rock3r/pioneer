import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerManagedTempPaths } from "../../test/support/temp-dir.js";

// A real traversal overflow needs 500,000 files; the snapshot is mocked to raise it instead.
vi.mock("../pi-extension-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pi-extension-snapshot.js")>()),
  snapshotExtensionResources: vi.fn(async () => {
    throw new Error(
      "[PI_EXTENSION_SNAPSHOT_LIMIT] The selected extension directories hold more than 500000 entries to scan.",
    );
  }),
}));

const { resolveToolExtensionSource, stageToolExtensions } = await import("./tool-extensions.js");
const { createTempDir } = registerManagedTempPaths();

describe("--pi-extension traversal limit", () => {
  it("does not blame other staged extensions for a traversal limit they cannot reduce", async () => {
    const root = await realpath(await createTempDir("pioneer-tool-traversal-"));
    const dir = path.join(root, "adapter");
    await mkdir(dir);
    await writeFile(path.join(dir, "index.ts"), "export default () => {};\n");
    const error = await stageToolExtensions(
      [await resolveToolExtensionSource(dir)],
      path.join(root, "stage"),
      { agentDir: path.join(root, "agent"), sessionDirs: [] },
      undefined,
      { entries: 40, bytes: 1024 ** 3 - 4 },
      [],
      { entries: 30, bytes: 1024 ** 2 },
    ).catch((reason: unknown) => reason);
    expect(String(error)).toContain("more than 500000 entries to scan");
    expect(String(error)).not.toContain("The limit is shared");
  });
});
