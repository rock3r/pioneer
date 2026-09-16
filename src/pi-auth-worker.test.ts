import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";

const { createTempDir } = registerManagedTempPaths();
const handles = vi.hoisted(() => ({ result: undefined as unknown }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) =>
      args[1] === "r+" ? handles.result : await fs.open(...args),
  };
});

it("publishes the complete credential result even when a single write would be short", async () => {
  const root = await createTempDir("pi-worker-output-");
  const core = path.join(root, "dist", "core");
  await mkdir(core, { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"type":"module"}');
  const credential = {
    type: "oauth",
    access: "rotated-access",
    refresh: "rotated-refresh",
    expires: 1234,
  };
  await writeFile(path.join(root, "auth.json"), JSON.stringify({ fixture: credential }));
  await writeFile(
    path.join(core, "auth-storage.js"),
    "export class AuthStorage { static inMemory(data){return {read:async provider=>data[provider]};} }",
  );
  await writeFile(
    path.join(core, "http-dispatcher.js"),
    "export function configureHttpDispatcher(){}",
  );
  await writeFile(
    path.join(core, "resource-loader.js"),
    "export class DefaultResourceLoader { async reload(){} getExtensions(){return {extensions:[],errors:[],runtime:{pendingProviderRegistrations:[]}};} }",
  );
  await writeFile(
    path.join(core, "model-runtime.js"),
    'export class ModelRuntime { static async create(){return {getAuth:async()=>"fixture"};} }',
  );
  const output = path.join(root, "result.json");
  const handle = await open(output, "wx+");
  handles.result = handle;
  const originalWrite = handle.write.bind(handle);
  vi.spyOn(handle, "write").mockImplementation(async () => await originalWrite("{", 0, "utf8"));
  const argv = process.argv;
  process.argv = [process.execPath, "worker", root, "fixture", output];
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  try {
    await import("./pi-auth-worker.js");
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({ credential, authenticated: true });
  } finally {
    process.argv = argv;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await handle.close();
  }
});
