import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { registerManagedTempPaths } from "../../test/support/temp-dir.js";
import { resolveProviderPolicy } from "./provider-network.js";

const { createTempDir } = registerManagedTempPaths();

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
  for (const name of ["custom-model", "org/team/custom-model"])
    expect(
      (await resolveProviderPolicy({ network: "provider-only" }, dir, name)).providerHosts,
    ).toEqual(["team.test"]);
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
  expect(
    (await resolveProviderPolicy({ network: "provider-only" }, dir, "first/model")).providerHosts,
  ).toEqual(["gateway.test"]);
  await expect(
    resolveProviderPolicy({ network: "provider-only" }, dir, "missing/model"),
  ).rejects.toThrow(/endpoint/i);
});
