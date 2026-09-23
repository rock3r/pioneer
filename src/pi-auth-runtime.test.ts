import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";
import { prepareAuthBroker } from "./pi-auth-runtime.js";
import type { PreparedReviewRuntime } from "./pi-extension-discovery.js";

const { createTempDir } = registerManagedTempPaths();

describe("prepareAuthBroker", () => {
  it.skipIf(process.platform === "win32")(
    "rejects OAuth credentials when the Pi package cannot broker refresh rotation",
    async () => {
      const root = await createTempDir("pioneer-auth-broker-missing-");
      const agentDir = path.join(root, "agent");
      const packageRoot = path.join(root, "package");
      await mkdir(agentDir);
      await mkdir(packageRoot);
      await writeFile(
        path.join(agentDir, "auth.json"),
        `${JSON.stringify({
          openai: { type: "oauth", access: "a", refresh: "r", expires: 1 },
        })}\n`,
      );
      const runtime: PreparedReviewRuntime = {
        scratch: root,
        extensionRoot: root,
        home: {
          root,
          agentDir,
          homeDir: root,
          tmpDir: root,
          sourceDir: root,
          environment: {},
        },
        extensions: {
          command: ["pi"],
          paths: [],
          sourcePaths: [],
          digest: "0".repeat(64),
          entries: 0,
          bytes: 0,
          runtimeRoot: packageRoot,
        },
        network: "public",
      };
      await expect(prepareAuthBroker(runtime)).rejects.toThrow("PI_OAUTH_REFRESH_FAILED");
    },
  );
});
