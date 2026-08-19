import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const PREREQ_SCRIPT = ".github/scripts/install-linux-sandbox-prereqs.sh";
const PREREQ_STEP = "Install Linux sandbox prerequisites";
const WORKFLOWS = [".github/workflows/ci.yml", ".github/workflows/release.yml"];

/** Slice one workflow step, from its `- name:` line to the next step at the same indent. */
const readStep = (workflow: string, name: string): string => {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  expect(start, `${name} step is missing`).toBeGreaterThanOrEqual(0);

  const indent = (lines[start] ?? "").indexOf("-");
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end] ?? "";
    if (line.indexOf("-") === indent && line.trim().startsWith("- ")) break;
    end += 1;
  }
  return lines.slice(start, end).join("\n");
};

/** Executable script commands, with blanks and comments removed and continuations joined. */
const readCommands = (script: string): string[] =>
  script
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

describe("Linux sandbox prerequisite installation", () => {
  it("bounds the apt step in every workflow that installs the prerequisites", async () => {
    for (const path of WORKFLOWS) {
      const workflow = await readFile(path, "utf8");
      const step = readStep(workflow, PREREQ_STEP);

      // Without an explicit bound the step inherits the 360-minute job default, which is
      // how a stalled Ubuntu mirror burned half an hour twice on 2026-08-19.
      expect(step, `${path} must bound the prerequisite step`).toMatch(/timeout-minutes: \d+/);
      expect(step, `${path} must call the shared installer`).toContain(PREREQ_SCRIPT);
      expect(workflow, `${path} must not invoke apt-get directly`).not.toContain("apt-get");
    }
  });

  it("retries every bounded apt invocation in the shared installer", async () => {
    const script = await readFile(PREREQ_SCRIPT, "utf8");
    const commands = readCommands(script);

    const invocations = commands.filter((line) => line.includes("apt-get"));
    expect(invocations.length).toBeGreaterThan(0);
    for (const invocation of invocations) {
      expect(invocation, "every apt-get invocation needs a hard wall-clock bound").toContain(
        "timeout",
      );
    }

    const program = commands.join("\n");
    expect(program).toContain("Acquire::Retries");
    expect(program).toContain("DPkg::Lock::Timeout");
    expect(commands.some((line) => line.includes("attempt"))).toBe(true);

    // A retry that re-reads the same mirror list just rolls the same dice. Every observed
    // stall was azure.archive.ubuntu.com while archive.ubuntu.com stayed reachable, so a
    // failed attempt has to narrow the mirror list before trying again.
    expect(program, "a retry must drop the mirror that just stalled").toContain("apt-mirrors.txt");
    expect(program).toContain("archive.ubuntu.com");

    // `apparmor_parser` ships in `apparmor`; nothing in Pioneer uses the aa-* tooling.
    expect(program, "apparmor-utils is unused and only widens the download window").not.toContain(
      "apparmor-utils",
    );
    expect(program).toContain("bubblewrap");
  });

  it("ships the shared installer as an executable file", async () => {
    const details = await stat(PREREQ_SCRIPT);
    expect(details.isFile()).toBe(true);
    expect(details.mode & 0o111, `${PREREQ_SCRIPT} must be executable`).toBeGreaterThan(0);
  });
});
