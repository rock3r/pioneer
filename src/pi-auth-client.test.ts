import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";
import { installAuthBrokerClient } from "./pi-auth-client.js";

const { createTempDir } = registerManagedTempPaths();
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("preserves non-OAuth modify callbacks in the private store", async () => {
  const root = await createTempDir("pi-modern-auth-");
  const core = path.join(root, "dist", "core");
  await mkdir(core, { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"type":"module"}');
  await writeFile(
    path.join(core, "auth-storage.js"),
    'export class AuthStorage { async modify(provider,update){return await update({type:"api_key",key:"fixture"});} }',
  );
  vi.stubEnv("PIONEER_AUTH_BROKER_URL", "http://fixture.invalid");
  vi.stubEnv("PIONEER_AUTH_BROKER_TOKEN", "fixture-token");
  vi.stubEnv("PIONEER_AUTH_BROKER_PROVIDERS", '["oauth"]');
  const fetcher = vi.fn(async () => new Response("{}", { status: 400 }));
  vi.stubGlobal("fetch", fetcher);
  await installAuthBrokerClient(root);
  const { AuthStorage } = (await import(
    pathToFileURL(path.join(core, "auth-storage.js")).href
  )) as {
    AuthStorage: new () => {
      modify(provider: string, update: () => Promise<unknown>): Promise<unknown>;
    };
  };
  expect(
    await new AuthStorage().modify("api", async () => ({ type: "api_key", key: "changed" })),
  ).toEqual({ type: "api_key", key: "changed" });
  expect(fetcher).not.toHaveBeenCalled();
});

it("uses the legacy broker result without calling the actor's original refresh again", async () => {
  const root = await createTempDir("pi-legacy-auth-");
  const core = path.join(root, "dist", "core");
  await mkdir(core, { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"type":"module"}');
  await writeFile(
    path.join(core, "auth-storage.js"),
    `
export class AuthStorage {
  calls=0;
  set(provider,credential){this.credential=credential;}
  getOAuthProviders(){return [{id:'fixture',getApiKey:c=>c.access}];}
  async refreshOAuthTokenWithLock(){this.calls++;return {apiKey:'second-refresh'};}
}
`,
  );
  vi.stubEnv("PIONEER_AUTH_BROKER_URL", "http://fixture.invalid");
  vi.stubEnv("PIONEER_AUTH_BROKER_TOKEN", "fixture-token");
  // A short-lived result may expire between broker delivery and the caller's next step.
  const credential = {
    type: "oauth",
    access: "broker-access",
    refresh: "broker-refresh",
    expires: 1,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(credential))),
  );
  await installAuthBrokerClient(root);
  const { AuthStorage } = (await import(
    pathToFileURL(path.join(core, "auth-storage.js")).href
  )) as {
    AuthStorage: new () => {
      calls: number;
      refreshOAuthTokenWithLock(provider: string): Promise<unknown>;
    };
  };
  const store = new AuthStorage();
  expect(await store.refreshOAuthTokenWithLock("fixture")).toEqual({
    apiKey: "broker-access",
    newCredentials: credential,
  });
  expect(store.calls).toBe(0);
});
