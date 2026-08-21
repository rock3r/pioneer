import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const WORKFLOWS = [".github/workflows/ci.yml", ".github/workflows/release.yml"];

describe("Windows AppContainer prototype CI", () => {
  it("is not a CI or release gate", async () => {
    for (const path of WORKFLOWS) {
      const workflow = await readFile(path, "utf8");
      expect(workflow, `${path} must not compile the unused AppContainer prototype`).not.toContain(
        "windows-appcontainer",
      );
      expect(workflow, `${path} must not define a windows-sandbox-prototype job`).not.toContain(
        "windows-sandbox-prototype",
      );
    }
  });
});
