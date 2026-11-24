import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { registerManagedTempPaths } from "../../test/support/temp-dir.js";
import { createEgressResolver } from "./egress-policy.js";
import {
  describeEgressPolicy,
  prepareProtectedProviderNetwork,
  prepareProviderNetwork,
} from "./provider-network.js";

const { createTempDir } = registerManagedTempPaths();

it.each(["full", "public", "provider-only"] as const)(
  "keeps the protected inference host on the exact controller route in %s",
  async (network) => {
    const lookup = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);
    const sources = { lookup, interfaces: () => ["192.168.2.4"] };
    const plan = prepareProtectedProviderNetwork(
      {
        network,
        allowHosts: ["*.provider.test", "127.0.0.1"],
        providerHosts: ["inference.provider.test"],
      },
      "INFERENCE.PROVIDER.TEST.",
      "provider/model",
      sources,
    );
    expect(plan.defaultModel).toBe("provider/model");
    expect(plan.policy.providerHosts).toBeUndefined();
    expect(describeEgressPolicy(plan.policy)).toContain(
      "Controller provider host: inference.provider.test.",
    );
    expect(plan.workerPolicy("provider")).toBe(plan.policy);
    plan.bind("PROVIDER/model");
    expect(() => plan.bind("provider/other-model")).toThrow(/model/i);
    expect(() => plan.bind(undefined)).toThrow(/model/i);
    const actor = createEgressResolver(plan.policy, sources);
    await expect(actor("inference.provider.test", 443)).rejects.toThrow();
    await expect(actor("127.0.0.1", 443)).rejects.toThrow();
    await expect(plan.resolveUpstream("other.provider.test", 443)).rejects.toThrow();
    await expect(plan.resolveUpstream("inference.provider.test", 444)).rejects.toThrow();
    expect(lookup).not.toHaveBeenCalled();
    await expect(plan.resolveUpstream("inference.provider.test", 443)).resolves.toEqual({
      address: "8.8.8.8",
      family: 4,
    });
    expect(lookup).toHaveBeenCalledWith("inference.provider.test");
  },
);

it.each(["full", "public", "provider-only"] as const)(
  "checks every protected upstream address for public reachability in %s",
  async (network) => {
    const lookup = vi.fn(async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "192.168.2.99", family: 4 },
    ]);
    const plan = prepareProtectedProviderNetwork(
      { network, allowHosts: ["0.0.0.0/0"] },
      "inference.provider.test",
      "provider/model",
      { lookup, interfaces: () => ["192.168.2.4"] },
    );
    await expect(plan.resolveUpstream("inference.provider.test", 443)).rejects.toThrow();
    expect(lookup).toHaveBeenCalledTimes(1);
  },
);

it("checks controller hostname blocks before DNS and controller address blocks after lookup", async () => {
  const lookup = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);
  const sources = { lookup, interfaces: () => ["192.168.2.4"] };
  const hostname = "inference.provider.test";
  const byName = prepareProtectedProviderNetwork(
    { network: "full", blockHosts: ["*.provider.test"] },
    hostname,
    "provider/model",
    sources,
  );
  await expect(byName.resolveUpstream(hostname, 443)).rejects.toThrow();
  expect(lookup).not.toHaveBeenCalled();
  const byAddress = prepareProtectedProviderNetwork(
    { network: "full", blockHosts: ["8.8.8.0/24"] },
    hostname,
    "provider/model",
    sources,
  );
  await expect(byAddress.resolveUpstream(hostname, 443)).rejects.toThrow();
  expect(lookup).toHaveBeenCalledTimes(1);
});

it("discovers a bare built-in model without implicit network access and binds its resolved model", async () => {
  const dir = await createTempDir("provider-bootstrap-");
  const plan = await prepareProviderNetwork({ network: "provider-only" }, dir, "gpt-5.5");
  expect(plan.policy.providerHosts).toBeUndefined();
  const lookup = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);
  const sources = { lookup, interfaces: () => ["127.0.0.1"] };
  await expect(createEgressResolver(plan.policy, sources)("api.openai.com", 443)).rejects.toThrow();
  expect(lookup).not.toHaveBeenCalled();
  plan.bind("openai/gpt-5.5");
  expect(plan.policy.providerHosts).toEqual(["api.openai.com"]);
  await expect(createEgressResolver(plan.policy, sources)("api.openai.com", 443)).resolves.toEqual({
    address: "8.8.8.8",
    family: 4,
  });
});

it("binds the readiness result using provider settings captured before discovery", async () => {
  const dir = await createTempDir("provider-bind-");
  const modelsFile = path.join(dir, "models.json");
  function models(url: string) {
    return JSON.stringify({
      providers: {
        gateway: { baseUrl: "https://default.test", models: [{ id: "model", baseUrl: url }] },
      },
    });
  }
  await writeFile(modelsFile, models("https://captured.test"));
  await writeFile(
    path.join(dir, "settings.json"),
    JSON.stringify({
      defaultProvider: "gateway",
      defaultModel: "model",
    }),
  );
  const plan = await prepareProviderNetwork({ network: "provider-only" }, dir);
  expect(plan.defaultModel).toBe("gateway/model");
  await writeFile(modelsFile, models("https://modified-during-discovery.test"));
  plan.bind("gateway/model");
  expect(plan.policy.providerHosts).toEqual(["captured.test"]);
});

it("grants the selected OAuth issuer only to the correct worker and on its HTTPS port", async () => {
  const dir = await createTempDir("provider-oauth-");
  const plan = await prepareProviderNetwork(
    { network: "provider-only" },
    dir,
    "openai-codex/model",
  );
  plan.bind("openai-codex/model");
  const lookup = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);
  const sources = { lookup, interfaces: () => ["127.0.0.1"] };
  const actor = createEgressResolver(plan.policy, sources);
  const otherWorker = createEgressResolver(plan.workerPolicy("anthropic"), sources);
  const workerPolicy = plan.workerPolicy("openai-codex");
  const worker = createEgressResolver(workerPolicy, sources);
  const blocked = createEgressResolver(
    { ...workerPolicy, blockHosts: ["auth.openai.com"] },
    sources,
  );
  await expect(actor("auth.openai.com", 443)).rejects.toThrow();
  await expect(otherWorker("auth.openai.com", 443)).rejects.toThrow();
  await expect(worker("auth.openai.com", 444)).rejects.toThrow();
  await expect(blocked("auth.openai.com", 443)).rejects.toThrow();
  expect(lookup).not.toHaveBeenCalled();
  await expect(worker("auth.openai.com", 443)).resolves.toEqual({ address: "8.8.8.8", family: 4 });
});

it("binds a bare configured model to its own provider even when Pi has a different default", async () => {
  const dir = await createTempDir("provider-selection-");
  await writeFile(path.join(dir, "settings.json"), JSON.stringify({ defaultProvider: "openai" }));
  await writeFile(
    path.join(dir, "models.json"),
    JSON.stringify({
      providers: {
        "org/team": { baseUrl: "https://team.test/api", models: [{ id: "custom-model" }] },
      },
    }),
  );
  for (const name of ["custom-model", "org/team/custom-model"]) {
    const plan = await prepareProviderNetwork({ network: "provider-only" }, dir, name);
    expect(plan.policy.providerHosts).toEqual(["team.test"]);
    plan.bind("org/team/custom-model");
    expect(plan.policy.providerHosts).toEqual(["team.test"]);
  }
});
it("selects only the selected provider endpoint from the staged configuration", async () => {
  const dir = await createTempDir("provider-policy-");
  await writeFile(
    path.join(dir, "models.json"),
    JSON.stringify({
      providers: {
        first: { baseUrl: "https://gateway.test/v1" },
        second: { baseUrl: "https://other.test" },
      },
    }),
  );
  const plan = await prepareProviderNetwork({ network: "provider-only" }, dir, "first/model");
  plan.bind("first/model");
  expect(plan.policy.providerHosts).toEqual(["gateway.test"]);
  expect(() => plan.bind("missing/model")).toThrow(/endpoint/i);
});
