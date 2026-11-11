import { spawn } from "node:child_process";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerManagedTempPaths } from "../../test/support/temp-dir.js";
import { MAX_GIT_SYMLINK_HOPS, validateGitSymlinkRoots } from "./git-dir-guard.js";
import {
  collectGitContext,
  defaultGitRunner,
  type GitRunner,
  gitInspectEnvironment,
  resolveGitExecutable,
} from "./git-inspect.js";

const { createTempDir } = registerManagedTempPaths();

const CANARY = "CANARY-FOREIGN-SECRET";
const ESCAPE = "[REVIEW_GIT_SYMLINK_ESCAPE]";

type RunGit = (cwd: string, args: string[]) => Promise<string>;

async function gitOrSkip(ctx: { skip: () => void }): Promise<RunGit | undefined> {
  // Windows symbolic links need elevation, and Windows reviews are unsandboxed opt-in.
  if (process.platform === "win32") {
    ctx.skip();
    return undefined;
  }
  let git: string;
  try {
    git = await resolveGitExecutable();
  } catch {
    ctx.skip();
    return undefined;
  }
  const env = {
    ...gitInspectEnvironment(),
    GIT_AUTHOR_NAME: "Pioneer Test",
    GIT_AUTHOR_EMAIL: "pioneer@example.test",
    GIT_COMMITTER_NAME: "Pioneer Test",
    GIT_COMMITTER_EMAIL: "pioneer@example.test",
  };
  return async (cwd, args) =>
    await new Promise<string>((resolve, reject) => {
      const child = spawn(
        git,
        ["-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always", ...args],
        { cwd, env, shell: false },
      );
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`git ${args.join(" ")} failed: ${stderr}`));
      });
    });
}

async function tempDir(prefix: string): Promise<string> {
  return await realpath(await createTempDir(prefix));
}

/** A repository with one commit whose file holds `content`. */
async function commitRepo(run: RunGit, prefix: string, content: string): Promise<string> {
  const root = await tempDir(prefix);
  await run(root, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(root, "file.txt"), `${content}\n`);
  await run(root, ["add", "file.txt"]);
  await run(root, ["commit", "-q", "-m", "commit"]);
  return root;
}

/** Move `inside` to a fresh directory outside the repository and link it back. */
async function moveOutAndLink(inside: string): Promise<string> {
  const outside = path.join(await tempDir("pioneer-gsl-outside-"), path.basename(inside));
  await rename(inside, outside);
  await symlink(outside, inside);
  return outside;
}

async function collectionFailure(
  source: string,
  target: Parameters<typeof collectGitContext>[1][number] = { kind: "commit", ref: "HEAD" },
  options: Parameters<typeof collectGitContext>[2] = {},
): Promise<Error> {
  let text: string | undefined;
  try {
    text = (await collectGitContext(source, [target], options))?.text;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  expect.fail(`collection unexpectedly succeeded: ${text?.slice(0, 200)}`);
}

describe("Git directory symbolic links", () => {
  it("rejects a pack directory linked to a foreign repository (canary repro)", async (ctx) => {
    const run = await gitOrSkip(ctx);
    if (run === undefined) return;
    const foreign = await commitRepo(run, "pioneer-gsl-foreign-", CANARY);
    await run(foreign, ["gc", "-q"]);
    const foreignHead = await run(foreign, ["rev-parse", "HEAD"]);
    const source = await commitRepo(run, "pioneer-gsl-source-", "base");
    const sourcePack = path.join(source, ".git", "objects", "pack");
    await rm(sourcePack, { recursive: true, force: true });
    await symlink(path.join(foreign, ".git", "objects", "pack"), sourcePack);
    await writeFile(path.join(source, ".git", "refs", "heads", "evil"), `${foreignHead}\n`);

    let collected: string | undefined;
    let failure: unknown;
    try {
      collected = (await collectGitContext(source, [{ kind: "commit", ref: "evil" }]))?.text;
    } catch (error) {
      failure = error;
    }
    expect(collected ?? "").not.toContain(CANARY);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain(ESCAPE);
    expect(message).toContain(sourcePack);
    expect(message).toContain(path.join(foreign, ".git", "objects", "pack"));
    expect(message).toContain("--allow-git-symlink-root");
    expect(message).not.toContain(CANARY);
  });

  describe("rejects links that leave the repository", () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly gc?: boolean;
      readonly arrange: (run: RunGit, source: string) => Promise<string>;
    }> = [
      {
        name: "objects",
        arrange: async (_run, source) => {
          const link = path.join(source, ".git", "objects");
          await moveOutAndLink(link);
          return link;
        },
      },
      {
        name: "objects/pack",
        gc: true,
        arrange: async (_run, source) => {
          const link = path.join(source, ".git", "objects", "pack");
          await moveOutAndLink(link);
          return link;
        },
      },
      {
        name: "a single pack file",
        gc: true,
        arrange: async (_run, source) => {
          const pack = path.join(source, ".git", "objects", "pack");
          const name = (await readdir(pack)).find((entry) => entry.endsWith(".pack"));
          expect(name).toBeDefined();
          const link = path.join(pack, name ?? "");
          await moveOutAndLink(link);
          return link;
        },
      },
      {
        name: "a loose-object fan-out directory",
        arrange: async (_run, source) => {
          const objects = path.join(source, ".git", "objects");
          const name = (await readdir(objects)).find((entry) => /^[0-9a-f]{2}$/.test(entry));
          expect(name).toBeDefined();
          const link = path.join(objects, name ?? "");
          await moveOutAndLink(link);
          return link;
        },
      },
      {
        name: "refs/heads",
        arrange: async (_run, source) => {
          const link = path.join(source, ".git", "refs", "heads");
          await moveOutAndLink(link);
          return link;
        },
      },
      {
        name: "a ref file",
        arrange: async (_run, source) => {
          const link = path.join(source, ".git", "refs", "heads", "main");
          await moveOutAndLink(link);
          return link;
        },
      },
      {
        name: "packed-refs",
        gc: true,
        arrange: async (_run, source) => {
          const link = path.join(source, ".git", "packed-refs");
          await moveOutAndLink(link);
          return link;
        },
      },
      {
        name: "HEAD through a ref that leaves the repository",
        arrange: async (run, source) => {
          // Git accepts a legacy symbolic-link HEAD only when it names refs/...;
          // the second hop leaves the repository.
          const head = await run(source, ["rev-parse", "HEAD"]);
          const outside = path.join(await tempDir("pioneer-gsl-outside-"), "ref");
          await writeFile(outside, `${head}\n`);
          await symlink(outside, path.join(source, ".git", "refs", "heads", "hop"));
          const link = path.join(source, ".git", "HEAD");
          await rm(link);
          await symlink("refs/heads/hop", link);
          return path.join(source, ".git", "refs", "heads", "hop");
        },
      },
      {
        name: "commondir",
        arrange: async (_run, source) => {
          // The outside file names this repository's own .git, so only the link leaves.
          const outside = path.join(await tempDir("pioneer-gsl-outside-"), "commondir");
          await writeFile(outside, `${path.join(source, ".git")}\n`);
          const link = path.join(source, ".git", "commondir");
          await symlink(outside, link);
          return link;
        },
      },
      {
        name: "worktrees/x",
        arrange: async (run, source) => {
          const worktree = path.join(await tempDir("pioneer-gsl-wt-"), "x");
          await run(source, ["worktree", "add", "-q", worktree, "-b", "feature"]);
          const link = path.join(source, ".git", "worktrees", "x");
          await moveOutAndLink(link);
          return link;
        },
      },
      {
        name: "info/",
        arrange: async (_run, source) => {
          const link = path.join(source, ".git", "info");
          await moveOutAndLink(link);
          return link;
        },
      },
      {
        name: "modules/x",
        arrange: async (_run, source) => {
          const outside = path.join(await tempDir("pioneer-gsl-outside-"), "x");
          await mkdir(outside);
          await writeFile(path.join(outside, "HEAD"), "ref: refs/heads/main\n");
          await mkdir(path.join(source, ".git", "modules"));
          const link = path.join(source, ".git", "modules", "x");
          await symlink(outside, link);
          return link;
        },
      },
      {
        name: "a dangling link",
        arrange: async (_run, source) => {
          const link = path.join(source, ".git", "refs", "heads", "ghost");
          await symlink(path.join(os.tmpdir(), "pioneer-gsl-missing", "ghost"), link);
          return link;
        },
      },
    ];

    for (const entry of cases) {
      it(entry.name, async (ctx) => {
        const run = await gitOrSkip(ctx);
        if (run === undefined) return;
        const source = await commitRepo(run, "pioneer-gsl-loc-", "base");
        if (entry.gc === true) await run(source, ["gc", "-q"]);
        const offending = await entry.arrange(run, source);
        const failure = await collectionFailure(source);
        expect(failure.message).toContain(ESCAPE);
        expect(failure.message).toContain(offending);
      });
    }

    it("HEAD linked directly outside", async (ctx) => {
      const run = await gitOrSkip(ctx);
      if (run === undefined) return;
      const source = await commitRepo(run, "pioneer-gsl-head-", "base");
      await moveOutAndLink(path.join(source, ".git", "HEAD"));
      // Git refuses to discover this repository before Pioneer walks it.
      const failure = await collectionFailure(source);
      expect(failure.message).toMatch(/\[REVIEW_GIT_(?:SYMLINK_ESCAPE|REPOSITORY_INVALID)\]/u);
    });
  });

  it("allows an in-repository link chain and records it", async (ctx) => {
    const run = await gitOrSkip(ctx);
    if (run === undefined) return;
    const source = await commitRepo(run, "pioneer-gsl-chain-", "chained-content");
    await run(source, ["gc", "-q"]);
    const store = path.join(source, ".store");
    await mkdir(store);
    const pack = path.join(source, ".git", "objects", "pack");
    await rename(pack, path.join(store, "pack"));
    await symlink("pack", path.join(store, "hop"));
    await symlink("../../.store/hop", pack);

    const collected = await collectGitContext(source, [{ kind: "commit", ref: "HEAD" }]);
    expect(collected?.text).toContain("chained-content");
    expect(collected?.gitDirectoryAudit.approvedRoots).toEqual([]);
    expect(collected?.gitDirectoryAudit.allowedLinks).toContainEqual({
      link: pack,
      target: path.join(store, "pack"),
      hops: 2,
      zone: "repository",
    });
  });

  it("rejects an in-repository link whose chain leaves and returns", async (ctx) => {
    const run = await gitOrSkip(ctx);
    if (run === undefined) return;
    const source = await commitRepo(run, "pioneer-gsl-bounce-", "base");
    await run(source, ["gc", "-q"]);
    const store = path.join(source, ".store");
    await mkdir(store);
    const pack = path.join(source, ".git", "objects", "pack");
    await rename(pack, path.join(store, "pack"));
    const outside = path.join(await tempDir("pioneer-gsl-outside-"), "bounce");
    await symlink(path.join(store, "pack"), outside);
    await symlink(path.join(store, "hop"), pack);
    await symlink(outside, path.join(store, "hop"));

    const failure = await collectionFailure(source);
    expect(failure.message).toContain(ESCAPE);
    expect(failure.message).toContain(`hop ${path.join(store, "hop")} -> ${outside}`);
  });

  it("rejects symbolic-link loops and over-long chains", async (ctx) => {
    const run = await gitOrSkip(ctx);
    if (run === undefined) return;
    const looped = await commitRepo(run, "pioneer-gsl-loop-", "base");
    await symlink("loop-b", path.join(looped, ".git", "loop-a"));
    await symlink("loop-a", path.join(looped, ".git", "loop-b"));
    expect((await collectionFailure(looped)).message).toContain("loops through");

    const deep = await commitRepo(run, "pioneer-gsl-deep-", "base");
    const chain = path.join(deep, ".chain");
    await mkdir(chain);
    await writeFile(path.join(chain, "end"), "x\n");
    for (let index = 0; index <= MAX_GIT_SYMLINK_HOPS; index += 1) {
      await symlink(index === 0 ? "end" : `l${index - 1}`, path.join(chain, `l${index}`));
    }
    await symlink(`../.chain/l${MAX_GIT_SYMLINK_HOPS}`, path.join(deep, ".git", "deep"));
    expect((await collectionFailure(deep)).message).toContain(
      `more than ${MAX_GIT_SYMLINK_HOPS} hops`,
    );
  });

  it("allows a symbolic-link hooks directory outside the repository", async (ctx) => {
    const run = await gitOrSkip(ctx);
    if (run === undefined) return;
    const source = await commitRepo(run, "pioneer-gsl-hooks-", "hooked");
    await moveOutAndLink(path.join(source, ".git", "hooks"));
    const collected = await collectGitContext(source, [{ kind: "commit", ref: "HEAD" }]);
    expect(collected?.text).toContain("hooked");
  });

  describe("Android repo layout", () => {
    async function repoLayout(run: RunGit): Promise<{ top: string; project: string }> {
      const top = await tempDir("pioneer-gsl-aosp-");
      const project = path.join(top, "X");
      await mkdir(project);
      await run(project, ["init", "-q", "-b", "main"]);
      await writeFile(path.join(project, "file.txt"), "android-project\n");
      await run(project, ["add", "file.txt"]);
      await run(project, ["commit", "-q", "-m", "commit"]);
      const gitDir = path.join(top, ".repo", "projects", "X.git");
      const objectStore = path.join(top, ".repo", "project-objects", "X.git");
      await mkdir(path.dirname(gitDir), { recursive: true });
      await mkdir(objectStore, { recursive: true });
      await rename(path.join(project, ".git"), gitDir);
      await rename(path.join(gitDir, "objects"), path.join(objectStore, "objects"));
      await symlink("../../project-objects/X.git/objects", path.join(gitDir, "objects"));
      await writeFile(path.join(project, ".git"), "gitdir: ../.repo/projects/X.git\n");
      return { top, project };
    }

    it("fails without an opt-in", async (ctx) => {
      const run = await gitOrSkip(ctx);
      if (run === undefined) return;
      const { top, project } = await repoLayout(run);
      const failure = await collectionFailure(project);
      expect(failure.message).toContain(ESCAPE);
      expect(failure.message).toContain(path.join(top, ".repo", "projects", "X.git", "objects"));
      expect(failure.message).toContain("--allow-android-repo-root");
    });

    it("passes with the .repo opt-in and records the approved root", async (ctx) => {
      const run = await gitOrSkip(ctx);
      if (run === undefined) return;
      const { top, project } = await repoLayout(run);
      const approvedSymlinkRoots = await validateGitSymlinkRoots([
        { kind: "android-repo", path: path.join(top, ".repo") },
      ]);
      const collected = await collectGitContext(project, [{ kind: "commit", ref: "HEAD" }], {
        approvedSymlinkRoots,
      });
      expect(collected?.text).toContain("android-project");
      expect(collected?.gitDirectoryAudit.approvedRoots).toEqual([
        { kind: "android-repo", path: path.join(top, ".repo") },
      ]);
      expect(collected?.gitDirectoryAudit.allowedLinks).toContainEqual({
        link: path.join(top, ".repo", "projects", "X.git", "objects"),
        target: path.join(top, ".repo", "project-objects", "X.git", "objects"),
        hops: 1,
        zone: path.join(top, ".repo"),
      });
    });

    it("passes with a generic symlink-root opt-in", async (ctx) => {
      const run = await gitOrSkip(ctx);
      if (run === undefined) return;
      const { top, project } = await repoLayout(run);
      const approvedSymlinkRoots = await validateGitSymlinkRoots([
        { kind: "symlink-root", path: path.join(top, ".repo", "project-objects") },
      ]);
      const collected = await collectGitContext(project, [{ kind: "commit", ref: "HEAD" }], {
        approvedSymlinkRoots,
      });
      expect(collected?.text).toContain("android-project");
    });

    it("refuses an android-repo opt-in that is not a .repo directory", async () => {
      const other = await tempDir("pioneer-gsl-notrepo-");
      await expect(
        validateGitSymlinkRoots([{ kind: "android-repo", path: other }]),
      ).rejects.toThrow("[REVIEW_GIT_SYMLINK_ROOT_INVALID]");
    });
  });

  it("refuses approved roots that are or contain the home directory or filesystem root", async () => {
    for (const candidate of [
      os.homedir(),
      path.dirname(os.homedir()),
      path.parse(os.homedir()).root,
    ]) {
      await expect(
        validateGitSymlinkRoots([{ kind: "symlink-root", path: candidate }]),
      ).rejects.toThrow("[REVIEW_GIT_SYMLINK_ROOT_INVALID]");
    }
    await expect(validateGitSymlinkRoots([{ kind: "android-repo", path: "/" }])).rejects.toThrow(
      "[REVIEW_GIT_SYMLINK_ROOT_INVALID]",
    );
  });

  it("refuses a symbolic-link approved root", async () => {
    const real = await tempDir("pioneer-gsl-real-");
    const linked = path.join(await tempDir("pioneer-gsl-alias-"), "alias");
    await symlink(real, linked);
    await expect(validateGitSymlinkRoots([{ kind: "symlink-root", path: linked }])).rejects.toThrow(
      "[REVIEW_GIT_SYMLINK_ROOT_INVALID]",
    );
  });

  it("still collects from a linked worktree", async (ctx) => {
    const run = await gitOrSkip(ctx);
    if (run === undefined) return;
    const main = await commitRepo(run, "pioneer-gsl-main-", "base");
    const worktree = path.join(await tempDir("pioneer-gsl-wt-"), "feature");
    await run(main, ["worktree", "add", "-q", worktree, "-b", "feature"]);
    await writeFile(path.join(worktree, "file.txt"), "worktree-change\n");
    await run(worktree, ["commit", "-q", "-am", "feature"]);

    const collected = await collectGitContext(worktree, [{ kind: "commit", ref: "HEAD" }]);
    expect(collected?.text).toContain("worktree-change");
    const fromMain = await collectGitContext(main, [{ kind: "commit", ref: "feature" }]);
    expect(fromMain?.text).toContain("worktree-change");
  });

  it("validates a linked worktree's common directory", async (ctx) => {
    const run = await gitOrSkip(ctx);
    if (run === undefined) return;
    const main = await commitRepo(run, "pioneer-gsl-main-", "base");
    const worktree = path.join(await tempDir("pioneer-gsl-wt-"), "feature");
    await run(main, ["worktree", "add", "-q", worktree, "-b", "feature"]);
    await run(main, ["gc", "-q"]);
    const pack = path.join(main, ".git", "objects", "pack");
    await moveOutAndLink(pack);
    const failure = await collectionFailure(worktree);
    expect(failure.message).toContain(ESCAPE);
    expect(failure.message).toContain(pack);
  });

  it("still collects from a submodule gitfile", async (ctx) => {
    const run = await gitOrSkip(ctx);
    if (run === undefined) return;
    const upstream = await commitRepo(run, "pioneer-gsl-subup-", "submodule-content");
    const superproject = await commitRepo(run, "pioneer-gsl-super-", "super");
    await run(superproject, ["submodule", "add", "-q", upstream, "sub"]);
    const submodule = path.join(superproject, "sub");
    expect(await readFile(path.join(submodule, ".git"), "utf8")).toContain("gitdir:");
    const collected = await collectGitContext(submodule, [{ kind: "commit", ref: "HEAD" }]);
    expect(collected?.text).toContain("submodule-content");
  });

  describe("check-to-use races", () => {
    it("pins Git to the validated directories", async (ctx) => {
      const run = await gitOrSkip(ctx);
      if (run === undefined) return;
      const source = await commitRepo(run, "pioneer-gsl-pin-", "base");
      const environments: NodeJS.ProcessEnv[] = [];
      const runner: GitRunner = async (executable, args, cwd, env) => {
        if (args.includes("show")) environments.push(env);
        return await defaultGitRunner(executable, args, cwd, env);
      };
      await collectGitContext(source, [{ kind: "commit", ref: "HEAD" }], {
        gitExecutable: await resolveGitExecutable(),
        runner,
      });
      expect(environments).toHaveLength(1);
      expect(environments[0]).toMatchObject({
        GIT_DIR: path.join(source, ".git"),
        GIT_COMMON_DIR: path.join(source, ".git"),
        GIT_OBJECT_DIRECTORY: path.join(source, ".git", "objects"),
        GIT_WORK_TREE: source,
      });
    });

    it("discards context when a link appears while Git runs", async (ctx) => {
      const run = await gitOrSkip(ctx);
      if (run === undefined) return;
      const source = await commitRepo(run, "pioneer-gsl-race-", "base");
      const outside = await tempDir("pioneer-gsl-outside-");
      const runner: GitRunner = async (executable, args, cwd, env) => {
        const result = await defaultGitRunner(executable, args, cwd, env);
        if (args.includes("show")) await symlink(outside, path.join(source, ".git", "late"));
        return result;
      };
      const failure = await collectionFailure(
        source,
        { kind: "commit", ref: "HEAD" },
        { gitExecutable: await resolveGitExecutable(), runner },
      );
      expect(failure.message).toContain("[REVIEW_GIT_DIRECTORY_CHANGED]");
    });

    it("discards context when an allowed link changes while Git runs", async (ctx) => {
      const run = await gitOrSkip(ctx);
      if (run === undefined) return;
      const source = await commitRepo(run, "pioneer-gsl-race2-", "base");
      const runner: GitRunner = async (executable, args, cwd, env) => {
        const result = await defaultGitRunner(executable, args, cwd, env);
        if (args.includes("show")) await symlink("refs", path.join(source, ".git", "late"));
        return result;
      };
      const failure = await collectionFailure(
        source,
        { kind: "commit", ref: "HEAD" },
        { gitExecutable: await resolveGitExecutable(), runner },
      );
      expect(failure.message).toContain("[REVIEW_GIT_DIRECTORY_CHANGED]");
    });
  });
});
