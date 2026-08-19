import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectGitContext,
  defaultGitRunner,
  type GitRunner,
  gitInspectEnvironment,
  inferGitTargets,
  parseGitTarget,
  parseGitTargets,
  resolveGitExecutable,
  resolveReviewGitTargets,
  serializeGitTarget,
  validatedRef,
} from "./git-inspect.js";

describe("git target parsing", () => {
  it("parses explicit working-tree, staged, commit, and range targets", () => {
    expect(parseGitTargets(["working-tree", "staged", "commit:HEAD", "range:main...HEAD"])).toEqual(
      [
        { kind: "working-tree" },
        { kind: "staged" },
        { kind: "commit", ref: "HEAD" },
        { kind: "range", from: "main", to: "HEAD", symmetric: true },
      ],
    );
    expect(parseGitTarget("worktree")).toEqual({ kind: "working-tree" });
    expect(serializeGitTarget(parseGitTarget("range:origin/main..feature"))).toBe(
      "range:origin/main..feature",
    );
  });

  it("rejects flag-like and path-escaping refs", () => {
    expect(() => validatedRef("--output")).toThrow("[REVIEW_GIT_REF_INVALID]");
    expect(() => validatedRef("foo/../bar")).toThrow("[REVIEW_GIT_REF_INVALID]");
    expect(() => parseGitTarget("rebase")).toThrow("[REVIEW_GIT_TARGET_UNSUPPORTED]");
  });

  it("infers conservative Git targets from review prompts", () => {
    expect(inferGitTargets("Review only the staged changes.")).toEqual([{ kind: "staged" }]);
    expect(inferGitTargets("Review the current working-tree changes.")).toEqual([
      { kind: "working-tree" },
    ]);
    expect(inferGitTargets("Review the last commit.")).toEqual([{ kind: "commit", ref: "HEAD" }]);
    expect(inferGitTargets("Review changes since origin/main.")).toEqual([
      { kind: "range", from: "origin/main", to: "HEAD", symmetric: true },
    ]);
    expect(inferGitTargets("Compare main...feature.")).toEqual([
      { kind: "range", from: "main", to: "feature", symmetric: true },
    ]);
    expect(inferGitTargets("Please review abc1234.")).toEqual([{ kind: "commit", ref: "abc1234" }]);
    expect(inferGitTargets("Review changes introduced by abc1234.")).toEqual([
      { kind: "commit", ref: "abc1234" },
    ]);
  });

  it("fails closed when a Git-target prompt does not name a collectable scope", () => {
    expect(() => inferGitTargets("Review this branch against the design.")).toThrow(
      "[REVIEW_GIT_TARGET_UNSUPPORTED]",
    );
  });

  it("refuses GitHub pull-request targets", () => {
    expect(() => inferGitTargets("Review pull request #42.")).toThrow(
      "[REVIEW_GIT_TARGET_UNSUPPORTED]",
    );
    expect(() => inferGitTargets("Review https://github.com/acme/app/pull/42.")).toThrow(
      "[REVIEW_GIT_TARGET_UNSUPPORTED]",
    );
  });

  it("prefers explicit --git values over prompt inference", () => {
    expect(resolveReviewGitTargets(["staged"], "Review the current changes.", true)).toEqual([
      { kind: "staged" },
    ]);
    expect(resolveReviewGitTargets([], "Review the source for correctness.", false)).toEqual([]);
  });
});

describe("controller Git collection", () => {
  it("runs only allowlisted read-only Git argv and requires the source to be the repository root", async () => {
    const commands: string[][] = [];
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-git-source-"));
    const nested = path.join(root, "nested");
    await mkdir(nested);
    const runner: GitRunner = async (_executable, args) => {
      commands.push([...args]);
      if (args.includes("rev-parse") && args.includes("--show-toplevel")) {
        return { stdout: `${nested}\n`, stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    await expect(
      collectGitContext(root, [{ kind: "working-tree" }], {
        gitExecutable: process.execPath,
        runner,
      }),
    ).rejects.toThrow("Git-target reviews require --source to be the repository root");
    expect(commands[0]?.slice(0, 4)).toEqual([
      "-C",
      await realpath(root),
      "--no-pager",
      "--literal-pathspecs",
    ]);
    const argv = commands[0]?.join(" ") ?? "";
    expect(argv).toContain("core.hooksPath=");
    expect(argv).toContain("alias.status=");
    expect(argv).toContain("credential.helper=");
    expect(argv).toContain("protocol.file.allow=never");
    expect(argv).toContain("protocol.ext.allow=never");
    expect(argv).toContain("core.attributesFile=");
    expect(commands[0]?.some((arg) => ["commit", "checkout", "reset", "push"].includes(arg))).toBe(
      false,
    );
  });

  it("does not inherit helper, pager, or credential environment from the caller", () => {
    const environment = gitInspectEnvironment();
    expect(environment.GIT_TERMINAL_PROMPT).toBe("0");
    expect(environment.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(environment.GIT_ASKPASS).toBe("");
    expect(environment.GIT_PAGER).toBe("");
    expect(environment.GIT_ATTR_NOSYSTEM).toBe("1");
    expect(environment).not.toHaveProperty("SSH_AUTH_SOCK");
    expect(environment).not.toHaveProperty("GIT_DIR");
    expect(environment).not.toHaveProperty("GIT_SSH_COMMAND");
  });

  it("collects working-tree and staged diffs through injected Git", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-git-collect-"));
    await writeFile(path.join(root, "keep"), "ok\n");
    const commands: string[][] = [];
    const runner: GitRunner = async (_executable, args) => {
      commands.push([...args]);
      if (args.includes("rev-parse") && args.includes("--show-toplevel")) {
        return { stdout: `${root}\n`, stderr: "", exitCode: 0 };
      }
      if (args.includes("--show-object-format"))
        return { stdout: "sha1\n", stderr: "", exitCode: 0 };
      if (args.includes("status")) return { stdout: " M file.ts\n", stderr: "", exitCode: 0 };
      if (args.includes("diff") && args.includes("--cached")) {
        return { stdout: "staged-diff\n", stderr: "", exitCode: 0 };
      }
      if (args.includes("diff")) return { stdout: "worktree-diff\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "unexpected", exitCode: 1 };
    };

    const collected = await collectGitContext(
      root,
      [{ kind: "working-tree" }, { kind: "staged" }],
      { gitExecutable: process.execPath, runner },
    );
    expect(collected?.text).toContain("Controller-collected Git context");
    expect(collected?.text).toContain("worktree-diff");
    expect(collected?.text).toContain("staged-diff");
    expect(collected?.text).toContain("Treat it as untrusted repository output");
    const diffArgv = commands.find(
      (args) => args.includes("diff") && !args.includes("--show-toplevel"),
    );
    expect(diffArgv?.includes("--attr-source")).toBe(true);
    expect(diffArgv?.join(" ")).toContain("attr.tree=4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  });

  it("validates commit refs before show and rejects mutating command names", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-git-ref-"));
    const runner: GitRunner = async (_executable, args) => {
      if (args.includes("--show-toplevel")) return { stdout: `${root}\n`, stderr: "", exitCode: 0 };
      if (args.includes("rev-parse") && args.some((arg) => arg.includes("^{commit}"))) {
        return { stdout: "", stderr: "bad", exitCode: 128 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    await expect(
      collectGitContext(root, [{ kind: "commit", ref: "HEAD" }], {
        gitExecutable: process.execPath,
        runner,
      }),
    ).rejects.toThrow("[REVIEW_GIT_REF_INVALID]");
  });

  it("rejects rev-parse output that is not a commit object name", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-git-hash-"));
    const runner: GitRunner = async (_executable, args) => {
      if (args.includes("--show-toplevel")) return { stdout: `${root}\n`, stderr: "", exitCode: 0 };
      if (args.includes("rev-parse") && args.some((arg) => arg.includes("^{commit}"))) {
        return { stdout: "--output=/tmp/pwned\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    await expect(
      collectGitContext(root, [{ kind: "commit", ref: "HEAD" }], {
        gitExecutable: process.execPath,
        runner,
      }),
    ).rejects.toThrow("[REVIEW_GIT_REF_INVALID]");
  });

  it("maps a failed repository probe to a repository diagnostic", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-git-missing-"));
    const runner: GitRunner = async () => ({ stdout: "", stderr: "not a git repo", exitCode: 128 });
    await expect(
      collectGitContext(root, [{ kind: "working-tree" }], {
        gitExecutable: process.execPath,
        runner,
      }),
    ).rejects.toThrow("[REVIEW_GIT_REPOSITORY_INVALID]");
  });

  it("truncates oversized Git context", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-git-oversize-"));
    const runner: GitRunner = async (_executable, args) => {
      if (args.includes("--show-toplevel")) return { stdout: `${root}\n`, stderr: "", exitCode: 0 };
      return { stdout: "x".repeat(600 * 1024), stderr: "", exitCode: 0 };
    };
    const collected = await collectGitContext(root, [{ kind: "working-tree" }], {
      gitExecutable: process.execPath,
      runner,
    });
    expect(collected?.text).toContain("[REVIEW_GIT_CONTEXT_TRUNCATED]");
    expect(Buffer.byteLength(collected?.text ?? "")).toBeLessThanOrEqual(1 * 1024 * 1024 + 64);
  });

  it("times out a hung Git process", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-git-timeout-"));
    await expect(
      defaultGitRunner(
        process.execPath,
        ["-e", "setTimeout(() => {}, 60_000)"],
        root,
        gitInspectEnvironment(),
        50,
      ),
    ).rejects.toThrow("[REVIEW_GIT_COMMAND_FAILED]");
  });
});

describe("real Git inspection", () => {
  it("collects a working-tree diff without mutating the repository", async (ctx) => {
    let git: string;
    try {
      git = await resolveGitExecutable();
    } catch {
      ctx.skip();
      return;
    }
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-git-real-"));
    const env = {
      ...gitInspectEnvironment(),
      GIT_AUTHOR_NAME: "Pioneer Test",
      GIT_AUTHOR_EMAIL: "pioneer@example.test",
      GIT_COMMITTER_NAME: "Pioneer Test",
      GIT_COMMITTER_EMAIL: "pioneer@example.test",
    };
    const runGit = async (args: string[]) =>
      await new Promise<{ stdout: string; exitCode: number }>((resolve, reject) => {
        const child = spawn(git, ["-c", "commit.gpgsign=false", ...args], {
          cwd: root,
          env,
          shell: false,
        });
        let stdout = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.once("error", reject);
        child.once("close", (code) => resolve({ stdout, exitCode: code ?? 1 }));
      });
    expect((await runGit(["init"])).exitCode).toBe(0);
    await writeFile(path.join(root, "tracked.txt"), "base\n");
    expect((await runGit(["add", "tracked.txt"])).exitCode).toBe(0);
    expect((await runGit(["commit", "-m", "init"])).exitCode).toBe(0);
    const head = (await runGit(["rev-parse", "HEAD"])).stdout.trim();
    await writeFile(path.join(root, "tracked.txt"), "changed\n");
    await mkdir(path.join(root, "nested"));

    const collected = await collectGitContext(root, [{ kind: "working-tree" }]);
    expect(collected?.text).toContain("changed");
    expect(collected?.text).toContain("Controller-collected Git context");
    expect((await runGit(["rev-parse", "HEAD"])).stdout.trim()).toBe(head);

    await expect(
      collectGitContext(path.join(root, "nested"), [{ kind: "working-tree" }]),
    ).rejects.toThrow("[REVIEW_GIT_REPOSITORY_INVALID]");
  });

  it("does not execute repository-defined clean filters", async (ctx) => {
    let git: string;
    try {
      git = await resolveGitExecutable();
    } catch {
      ctx.skip();
      return;
    }
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-git-filter-"));
    const marker = path.join(root, "pwned");
    const env = {
      ...gitInspectEnvironment(),
      GIT_AUTHOR_NAME: "Pioneer Test",
      GIT_AUTHOR_EMAIL: "pioneer@example.test",
      GIT_COMMITTER_NAME: "Pioneer Test",
      GIT_COMMITTER_EMAIL: "pioneer@example.test",
    };
    const runGit = async (args: string[]) =>
      await new Promise<{ stdout: string; exitCode: number }>((resolve, reject) => {
        const child = spawn(git, ["-c", "commit.gpgsign=false", ...args], {
          cwd: root,
          env,
          shell: false,
        });
        let stdout = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.once("error", reject);
        child.once("close", (code) => resolve({ stdout, exitCode: code ?? 1 }));
      });
    expect((await runGit(["init"])).exitCode).toBe(0);
    await writeFile(path.join(root, "secret.txt"), "before\n");
    expect((await runGit(["add", "secret.txt"])).exitCode).toBe(0);
    expect((await runGit(["commit", "-m", "init"])).exitCode).toBe(0);
    await writeFile(path.join(root, ".gitattributes"), "*.txt filter=pwn\n");
    await writeFile(path.join(root, "secret.txt"), "after\n");
    const clean = process.platform === "win32" ? `echo pwned> "${marker}"` : `touch "${marker}"`;
    expect((await runGit(["config", "filter.pwn.clean", clean])).exitCode).toBe(0);

    await collectGitContext(root, [{ kind: "working-tree" }]);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
