import { open, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { restrictExtensionTools } from "./pi-extension-policy.js";

// Runs in a separate native sandbox with no source, session, prompt, or actor scratch.
// Only operator-configured extension initialization and provider authentication run here.
const [root, provider, output, ...extensions] = process.argv.slice(2);
if (root === undefined || provider === undefined || output === undefined)
  throw new Error("Invalid auth worker request");
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (agentDir === undefined) throw new Error("Missing private auth worker home");
const load = async (name: string): Promise<Record<string, unknown>> =>
  await import(pathToFileURL(path.join(root, "dist/core", `${name}.js`)).href);
type Registration = { name: string; config: unknown };
type NativeRegistration = { provider: unknown };
type Registry = {
  registerProvider(name: string, config: unknown): void;
  registerNativeProvider?(provider: unknown): void;
  getAuth?(provider: string): Promise<unknown>;
};
type AuthStore = {
  read?(provider: string): Promise<unknown>;
  get?(provider: string): unknown;
  getApiKey?(provider: string): Promise<unknown>;
};
// Capture credentials and the official store before extension initialization. File
// mutations by extension initialization are not authentication API results.
const { AuthStorage } = (await load("auth-storage")) as {
  AuthStorage: { inMemory(data: unknown): AuthStore };
};
const auth = AuthStorage.inMemory(
  JSON.parse(await readFile(path.join(agentDir, "auth.json"), "utf8")),
);
const readCredential = auth.read?.bind(auth) ?? auth.get?.bind(auth);
if (readCredential === undefined) throw new Error("Unsupported credential store");
const outputHandle = await open(output, "r+");
let authenticated = false;
try {
  const { configureHttpDispatcher } = (await load("http-dispatcher")) as {
    configureHttpDispatcher(): void;
  };
  configureHttpDispatcher();
  const { DefaultResourceLoader } = (await load("resource-loader")) as {
    DefaultResourceLoader: new (
      options: unknown,
    ) => {
      reload(): Promise<void>;
      getExtensions(): Parameters<typeof restrictExtensionTools>[0] & {
        runtime: {
          pendingProviderRegistrations: Registration[];
          pendingNativeProviderRegistrations?: NativeRegistration[];
        };
      };
    };
  };
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir,
    noExtensions: true,
    additionalExtensionPaths: extensions,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const result = loader.getExtensions();
  restrictExtensionTools(result);
  const modelsPath = path.join(agentDir, "models.json");
  let registry: Registry;
  let getAuth: () => Promise<unknown>;
  // Pi 0.81 moved authentication from ModelRegistry to ModelRuntime.
  const runtime = (await load("model-runtime").catch(() => undefined)) as
    | {
        ModelRuntime: { create(options: unknown): Promise<Registry> };
      }
    | undefined;
  if (runtime !== undefined) {
    registry = await runtime.ModelRuntime.create({ credentials: auth, modelsPath });
    getAuth = async () => await registry.getAuth?.(provider);
  } else {
    const { ModelRegistry } = (await load("model-registry")) as {
      ModelRegistry: { create(auth: unknown, models: string): Registry };
    };
    registry = ModelRegistry.create(auth, modelsPath);
    getAuth = async () => await auth.getApiKey?.(provider);
  }
  for (const entry of result.runtime.pendingProviderRegistrations)
    registry.registerProvider(entry.name, entry.config);
  for (const entry of result.runtime.pendingNativeProviderRegistrations ?? []) {
    if (registry.registerNativeProvider === undefined)
      throw new Error("Unsupported native provider");
    registry.registerNativeProvider(entry.provider);
  }
  if (!(await getAuth())) throw new Error("Provider authentication unavailable");
  authenticated = true;
} catch {
  // Never forward provider errors, which may contain credentials.
  process.stderr.write("[PI_OAUTH_REFRESH_FAILED] Provider authentication failed.\n");
} finally {
  const result = JSON.stringify({ credential: await readCredential(provider), authenticated });
  await outputHandle.write(result, 0, "utf8");
  await outputHandle.truncate(Buffer.byteLength(result));
  await outputHandle.sync();
  await outputHandle.close();
}
