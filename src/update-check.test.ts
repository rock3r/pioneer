import { describe, expect, it } from "vitest";
import {
  checkForUpdate,
  fetchLatestVersionFromNpm,
  type UpdateCheckState,
  type UpdateStateStore,
} from "./update-check.js";

function store(
  initial: UpdateCheckState | undefined,
): UpdateStateStore & { writes: UpdateCheckState[] } {
  let value = initial;
  const writes: UpdateCheckState[] = [];
  return {
    writes,
    async read() {
      return value;
    },
    async write(next) {
      value = next;
      writes.push(next);
    },
  };
}

describe("package update checks", () => {
  it("uses a successful cached result for 24 hours without contacting npm", async () => {
    const cache = store({ schemaVersion: 1, checkedAt: 1_000, latestVersion: "0.2.0" });
    const lookup = async () => {
      throw new Error("npm should not be contacted");
    };

    await expect(
      checkForUpdate({ currentVersion: "0.1.4", now: 1_000 + 86_399_999, store: cache, lookup }),
    ).resolves.toEqual({ checked: false, latestVersion: "0.2.0", updateAvailable: true });
  });

  it("refreshes the npm version after the 24-hour cooldown and persists it", async () => {
    const cache = store({ schemaVersion: 1, checkedAt: 1_000, latestVersion: "0.2.0" });

    await expect(
      checkForUpdate({
        currentVersion: "0.1.4",
        now: 1_000 + 86_400_000,
        store: cache,
        lookup: async () => "0.3.0",
      }),
    ).resolves.toEqual({ checked: true, latestVersion: "0.3.0", updateAvailable: true });
    expect(cache.writes).toEqual([
      { schemaVersion: 1, checkedAt: 86_401_000, latestVersion: "0.3.0" },
    ]);
  });

  it("forces a fresh npm query for a manual check", async () => {
    const cache = store({ schemaVersion: 1, checkedAt: 1_000, latestVersion: "0.2.0" });
    let calls = 0;

    const result = await checkForUpdate({
      currentVersion: "0.1.4",
      now: 1_001,
      force: true,
      store: cache,
      lookup: async () => {
        calls += 1;
        return "0.4.0";
      },
    });

    expect(calls).toBe(1);
    expect(result.latestVersion).toBe("0.4.0");
  });

  it("records a failed check time so normal startup does not retry on every invocation", async () => {
    const cache = store(undefined);

    await expect(
      checkForUpdate({
        currentVersion: "0.1.4",
        now: 12_345,
        store: cache,
        lookup: async () => {
          throw new Error("registry unavailable");
        },
      }),
    ).rejects.toThrow("registry unavailable");
    expect(cache.writes).toEqual([{ schemaVersion: 1, checkedAt: 12_345 }]);
  });

  it("uses fixed npm argv and rejects malformed registry output", async () => {
    const invocations: Array<readonly [string, readonly string[]]> = [];
    await expect(
      fetchLatestVersionFromNpm(async (command, args) => {
        invocations.push([command, args]);
        return '"0.2.0"\n';
      }),
    ).resolves.toBe("0.2.0");
    expect(invocations).toEqual([
      [
        "npm",
        [
          "view",
          "@rock3r/pioneer",
          "version",
          "--json",
          "--fetch-retries=0",
          "--fetch-timeout=5000",
        ],
      ],
    ]);
    await expect(fetchLatestVersionFromNpm(async () => '"not-a-version"')).rejects.toThrow(
      "valid semantic version",
    );
  });
});
