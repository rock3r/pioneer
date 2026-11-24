import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";
import { prepareControllerProviderAuth } from "./controller-provider-auth.js";
import { startProviderAuthGateway } from "./provider-auth-gateway.js";

const { createTempDir } = registerManagedTempPaths();
vi.mock("./provider-auth-gateway.js", () => ({ startProviderAuthGateway: vi.fn() }));
const gateway = {
  baseUrl: "http://127.0.0.1:42000/private",
  port: 42000,
  placeholder: "controller-placeholder",
  close: vi.fn(async () => {}),
};

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

async function sourceHome(
  auth: Record<string, unknown>,
  provider: Record<string, unknown> = {},
): Promise<string> {
  const root = await createTempDir("pioneer-mock-auth-");
  await writeFile(path.join(root, "auth.json"), JSON.stringify(auth));
  await writeFile(
    path.join(root, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: "https://model.invalid/v1",
          api: "openai-completions",
          models: [{ id: "example" }],
          ...provider,
        },
        secondary: { apiKey: "secondary-model-secret" },
      },
    }),
  );
  return root;
}

it("compiles an isolated provider configuration from the selected Pi environment key", async () => {
  vi.stubEnv("PIONEER_TEST_MOCK_API_KEY", "mock-api-key-value");
  vi.mocked(startProviderAuthGateway).mockResolvedValue(gateway);
  const home = await sourceHome(
    { secondary: { key: "secondary-auth-secret" } },
    { apiKey: `prefix-\${PIONEER_TEST_MOCK_API_KEY}` },
  );
  const result = await prepareControllerProviderAuth(home, "fixture/example");
  const route = vi.mocked(startProviderAuthGateway).mock.calls[0]?.[0];
  expect(await route?.credential()).toBe("prefix-mock-api-key-value");
  expect(result.files.auth).toContain(gateway.placeholder);
  expect(result.files.models).toContain(gateway.baseUrl);
  expect(JSON.stringify(result.files)).not.toMatch(/mock-api-key-value|secondary|model\.invalid/);
  expect(result.upstreamHostname).toBe("model.invalid");
});

it("applies the operator host block to the gateway's real upstream", async () => {
  vi.mocked(startProviderAuthGateway).mockResolvedValue(gateway);
  const home = await sourceHome({}, { apiKey: "only-a-fixture" });
  const result = await prepareControllerProviderAuth(home, "fixture/example", {
    network: "provider-only",
    blockHosts: ["model.invalid"],
  });
  const resolve = vi.mocked(startProviderAuthGateway).mock.calls[0]?.[1];
  if (!resolve) throw new Error("Missing gateway policy resolver");
  await expect(resolve("model.invalid", 443)).rejects.toThrow("Network destination is not allowed");
  expect(result.providerNetwork.policy.controllerProviderHost).toBe("model.invalid");
});

it("keeps OAuth refresh tokens and secondary credentials outside every actor file", async () => {
  vi.mocked(startProviderAuthGateway).mockResolvedValue(gateway);
  const auth = {
    fixture: {
      type: "oauth",
      access: "mock-valid-access",
      refresh: "mock-refresh",
      expires: Date.now() + 60_000,
    },
    secondary: { type: "api_key", key: "mock-secondary" },
  };
  const home = await sourceHome(auth);
  const result = await prepareControllerProviderAuth(home, "fixture/example");
  const route = vi.mocked(startProviderAuthGateway).mock.calls[0]?.[0];
  expect(await route?.credential()).toBe("mock-valid-access");
  expect(route?.upstreamHeader).toBe("authorization");
  expect(JSON.stringify(result.files)).not.toMatch(/mock-valid-access|mock-refresh|mock-secondary/);
  expect(JSON.parse(await readFile(path.join(home, "auth.json"), "utf8"))).toEqual(auth);
});

it("rejects expired OAuth and selected model headers before starting a gateway", async () => {
  const expired = await sourceHome({
    fixture: { type: "oauth", access: "mock-expired-access", expires: 1 },
  });
  await expect(prepareControllerProviderAuth(expired, "fixture/example")).rejects.toThrow(
    "Renew the provider OAuth login",
  );
  const overridden = await sourceHome(
    {},
    { modelOverrides: { example: { headers: { Authorization: "mock-conflicting-key" } } } },
  );
  await expect(prepareControllerProviderAuth(overridden, "fixture/example")).rejects.toThrow(
    "Custom configured headers",
  );
  expect(startProviderAuthGateway).not.toHaveBeenCalled();
});
