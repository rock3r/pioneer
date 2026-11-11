import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, readlink, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { diagnosticMessage } from "../diagnostics.js";
import { isWithin } from "../eval-run/isolation.js";
import { canonicalReviewReadGrant } from "./isolation.js";

/**
 * How an operator pre-approved a directory outside the repository as a valid
 * symbolic-link destination for Git metadata.
 */
export type GitSymlinkRootKind = "symlink-root" | "android-repo";

export interface GitSymlinkRootRequest {
  readonly kind: GitSymlinkRootKind;
  readonly path: string;
}

export interface ApprovedGitSymlinkRoot {
  readonly kind: GitSymlinkRootKind;
  /** Canonical directory path. */
  readonly path: string;
}

export interface AllowedGitSymlink {
  /** Link path inside a walked Git directory or a linked directory. */
  readonly link: string;
  /** Canonical final destination after every hop. */
  readonly target: string;
  /** Number of symbolic-link hops in the chain. */
  readonly hops: number;
  /** `repository`, or the canonical approved root the chain resolves under. */
  readonly zone: string;
}

export interface GitDirectoryAudit {
  readonly approvedRoots: readonly ApprovedGitSymlinkRoot[];
  readonly allowedLinks: readonly AllowedGitSymlink[];
  /** Allowed links omitted from `allowedLinks` because of the record cap. */
  readonly allowedLinksOmitted: number;
}

export interface ValidatedGitDirectories {
  /** Canonical Git directory. */
  readonly gitDir: string;
  /** Canonical common directory. */
  readonly commonDir: string;
  /** Canonical object directory, after resolving a validated `objects` link. */
  readonly objectDir: string;
  readonly audit: GitDirectoryAudit;
  /** Digest over the link layout and root identities, for post-use comparison. */
  readonly fingerprint: string;
}

export interface GitDirectoryGuardOptions {
  /** Canonical repository root (the review source). */
  readonly repo: string;
  /** Canonical Git and common directories, as reported by Git. */
  readonly gitDir: string;
  readonly commonDir: string;
  /** Canonical in-repository containment roots. */
  readonly boundary: readonly string[];
  readonly approvedRoots: readonly ApprovedGitSymlinkRoot[];
  /** Test seam: maximum directory entries walked across all roots. */
  readonly maxEntries?: number;
}

export const MAX_GIT_SYMLINK_HOPS = 40;
export const MAX_GIT_DIRECTORY_ENTRIES = 1_000_000;
const MAX_RECORDED_LINKS = 64;
const OPT_IN_HINT =
  "If this location is trusted, pass --allow-git-symlink-root DIR naming a directory that contains it, or --allow-android-repo-root DIR for the .repo directory of an Android repo checkout.";

function invalid(message: string): Error {
  return new Error(diagnosticMessage("REVIEW_GIT_REPOSITORY_INVALID", message));
}

function escapeFailure(message: string): Error {
  return new Error(diagnosticMessage("REVIEW_GIT_SYMLINK_ESCAPE", message));
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Canonicalize operator-approved symbolic-link roots. Each root must pass the
 * review read-grant checks and must neither be nor contain the home directory
 * or the filesystem root.
 */
export async function validateGitSymlinkRoots(
  requests: readonly GitSymlinkRootRequest[],
  platform: NodeJS.Platform = process.platform,
): Promise<ApprovedGitSymlinkRoot[]> {
  const approved: ApprovedGitSymlinkRoot[] = [];
  const homes = new Set([path.resolve(os.homedir())]);
  try {
    homes.add(await realpath(os.homedir()));
  } catch {
    // A missing home cannot be contained by a root.
  }
  for (const request of requests) {
    const option =
      request.kind === "android-repo" ? "--allow-android-repo-root" : "--allow-git-symlink-root";
    let canonical: string;
    try {
      canonical = await canonicalReviewReadGrant(request.path, platform);
    } catch (error) {
      throw new Error(
        diagnosticMessage(
          "REVIEW_GIT_SYMLINK_ROOT_INVALID",
          `${option} ${request.path} was refused: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
    for (const home of homes) {
      if (isWithin(canonical, home)) {
        throw new Error(
          diagnosticMessage(
            "REVIEW_GIT_SYMLINK_ROOT_INVALID",
            `${option} ${canonical} was refused: it is or contains the home directory`,
          ),
        );
      }
    }
    if (canonical === path.parse(canonical).root) {
      throw new Error(
        diagnosticMessage(
          "REVIEW_GIT_SYMLINK_ROOT_INVALID",
          `${option} ${canonical} was refused: it is the filesystem root`,
        ),
      );
    }
    if (request.kind === "android-repo") await assertAndroidRepoRoot(canonical);
    if (!approved.some((entry) => entry.path === canonical && entry.kind === request.kind)) {
      approved.push({ kind: request.kind, path: canonical });
    }
  }
  return approved;
}

async function assertAndroidRepoRoot(canonical: string): Promise<void> {
  if (path.basename(canonical) !== ".repo") {
    throw new Error(
      diagnosticMessage(
        "REVIEW_GIT_SYMLINK_ROOT_INVALID",
        `--allow-android-repo-root ${canonical} was refused: name the .repo directory of an Android repo checkout`,
      ),
    );
  }
  for (const name of ["projects", "project-objects"] as const) {
    try {
      if ((await lstat(path.join(canonical, name))).isDirectory()) return;
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
    }
  }
  throw new Error(
    diagnosticMessage(
      "REVIEW_GIT_SYMLINK_ROOT_INVALID",
      `--allow-android-repo-root ${canonical} was refused: it has no projects or project-objects directory`,
    ),
  );
}

interface Hop {
  readonly link: string;
  readonly target: string;
  readonly destination: string;
}

interface ResolvedLink {
  readonly final: string;
  readonly isDirectory: boolean;
  readonly hops: readonly Hop[];
}

class GitDirectoryWalker {
  private readonly visited = new Set<string>();
  /** Git-reported directories whose direct `hooks` child is exempt. */
  private readonly hookParents = new Set<string>();
  private readonly links: AllowedGitSymlink[] = [];
  private readonly layout: string[] = [];
  private entries = 0;

  constructor(private readonly options: GitDirectoryGuardOptions) {}

  async walkRoots(roots: readonly string[]): Promise<void> {
    for (const root of roots) this.hookParents.add(root);
    for (const root of roots) await this.walk(root);
  }

  allowedLinks(): AllowedGitSymlink[] {
    return this.links;
  }

  fingerprintParts(): readonly string[] {
    return this.layout;
  }

  zoneOf(candidate: string): string | undefined {
    for (const root of this.options.boundary) {
      if (isWithin(root, candidate)) return "repository";
    }
    for (const root of this.options.approvedRoots) {
      if (isWithin(root.path, candidate)) return root.path;
    }
    return undefined;
  }

  private describeZones(): string {
    const zones = [
      ...this.options.boundary,
      ...this.options.approvedRoots.map((root) => `${root.path} (approved)`),
    ];
    return zones.join(", ");
  }

  private async walk(directory: string): Promise<void> {
    if (this.visited.has(directory)) return;
    this.visited.add(directory);
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      const code = errnoCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") return;
      throw invalid(`Pioneer could not inspect Git metadata directory ${directory} (${code})`);
    }
    // Only the Git and common directories that Git reported are trusted as Git
    // directories; sibling names inside the repository are attacker-controlled.
    const hookParent = this.hookParents.has(directory);
    for (const entry of entries) {
      this.entries += 1;
      if (this.entries > (this.options.maxEntries ?? MAX_GIT_DIRECTORY_ENTRIES)) {
        throw invalid(
          `Git metadata, including linked directories, has more than ${this.options.maxEntries ?? MAX_GIT_DIRECTORY_ENTRIES} entries; Pioneer cannot verify its symbolic links. Pack loose objects with git gc, or remove links to large directories.`,
        );
      }
      // Hooks never run during collection (core.hooksPath points at the null device).
      if (hookParent && entry.name === "hooks") continue;
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const resolved = await this.resolve(full);
        const zone = this.zoneOf(resolved.final) ?? "repository";
        this.layout.push(
          `${full}\0${resolved.hops.map((hop) => hop.target).join("\0")}\0${resolved.final}`,
        );
        if (this.links.length < MAX_RECORDED_LINKS) {
          this.links.push({ link: full, target: resolved.final, hops: resolved.hops.length, zone });
        }
        if (resolved.isDirectory) await this.walk(resolved.final);
      } else if (entry.isDirectory()) {
        await this.walk(full);
      }
    }
  }

  /**
   * Resolve a link component by component without trusting realpath, so every
   * hop's destination is checked before it is followed. The link's parent must
   * already be a canonical directory.
   */
  async resolve(link: string): Promise<ResolvedLink> {
    const hops: Hop[] = [];
    const seen = new Set<string>();
    let current = path.dirname(link);
    let pending = [path.basename(link)];
    while (pending.length > 0) {
      const component = pending.shift() ?? "";
      if (component === "" || component === ".") continue;
      if (component === "..") {
        current = path.dirname(current);
        continue;
      }
      const next = path.join(current, component);
      let details: Awaited<ReturnType<typeof lstat>>;
      try {
        details = await lstat(next);
      } catch (error) {
        if (errnoCode(error) !== "ENOENT" && errnoCode(error) !== "ENOTDIR") throw error;
        // Dangling: Git cannot read through it now. Still require its spelled
        // destination to stay in an allowed zone so a later file cannot appear outside.
        const final = path.resolve(next, ...pending);
        if (this.zoneOf(final) === undefined) {
          throw this.escapeError(link, hops, { link: next, target: "", destination: final });
        }
        return { final, isDirectory: false, hops };
      }
      if (!details.isSymbolicLink()) {
        current = next;
        continue;
      }
      if (seen.has(next)) {
        throw invalid(
          `Git metadata symbolic link ${link} loops through ${next}; Pioneer rejects symbolic-link cycles`,
        );
      }
      seen.add(next);
      if (hops.length >= MAX_GIT_SYMLINK_HOPS) {
        throw invalid(
          `Git metadata symbolic link ${link} has more than ${MAX_GIT_SYMLINK_HOPS} hops; Pioneer rejects deeper chains`,
        );
      }
      const target = await readlink(next);
      const destination = path.resolve(current, target);
      const hop = { link: next, target, destination };
      hops.push(hop);
      if (this.zoneOf(destination) === undefined) throw this.escapeError(link, hops, hop);
      const targetRoot = path.isAbsolute(target) ? path.parse(destination).root : "";
      if (targetRoot !== "") current = targetRoot;
      const relativeTarget =
        targetRoot === "" ? target : target.slice(path.parse(target).root.length);
      pending = [
        ...relativeTarget.split(process.platform === "win32" ? /[\\/]+/u : /\/+/u),
        ...pending,
      ];
    }
    if (this.zoneOf(current) === undefined) {
      throw this.escapeError(link, hops, {
        link: hops.at(-1)?.link ?? link,
        target: hops.at(-1)?.target ?? "",
        destination: current,
      });
    }
    let isDirectory = false;
    try {
      isDirectory = (await stat(current)).isDirectory();
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
    }
    return { final: current, isDirectory, hops };
  }

  private escapeError(link: string, hops: readonly Hop[], hop: Hop): Error {
    const chain =
      hops.length > 1 ? ` (chain: ${hops.map((entry) => entry.link).join(" -> ")})` : "";
    return escapeFailure(
      `Git-target reviews reject Git metadata symbolic links that leave the repository: ${link}${chain}; hop ${hop.link} -> ${hop.target || "(missing)"} resolves to ${hop.destination}, outside ${this.describeZones()}. ${OPT_IN_HINT}`,
    );
  }
}

async function rootIdentity(root: string): Promise<string> {
  const details = await lstat(root);
  return `${root}\0${details.dev}:${details.ino}`;
}

/**
 * Walk the Git and common directories without following links and reject any
 * symbolic link whose chain leaves the repository or an approved root.
 */
export async function validateGitDirectories(
  options: GitDirectoryGuardOptions,
): Promise<ValidatedGitDirectories> {
  const walker = new GitDirectoryWalker(options);
  const roots = [...new Set([options.gitDir, options.commonDir])];
  await walker.walkRoots(roots);
  const objectsLink = path.join(options.commonDir, "objects");
  let objectDir = objectsLink;
  try {
    if ((await lstat(objectsLink)).isSymbolicLink()) {
      objectDir = (await walker.resolve(objectsLink)).final;
    }
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
  }
  const parts = [
    ...(await Promise.all(roots.map(rootIdentity))),
    `objects\0${objectDir}`,
    ...walker.fingerprintParts(),
  ].sort();
  const fingerprint = createHash("sha256").update(parts.join("\n")).digest("hex");
  const allLinks = walker.fingerprintParts().length;
  const allowedLinks = walker.allowedLinks();
  return {
    gitDir: options.gitDir,
    commonDir: options.commonDir,
    objectDir,
    fingerprint,
    audit: {
      approvedRoots: options.approvedRoots,
      allowedLinks,
      allowedLinksOmitted: allLinks - allowedLinks.length,
    },
  };
}

/**
 * Re-walk after Git has read the repository. A changed link layout or root
 * identity means Git may have read through unvalidated paths.
 */
export async function assertGitDirectoriesUnchanged(
  options: GitDirectoryGuardOptions,
  validated: ValidatedGitDirectories,
): Promise<void> {
  let after: ValidatedGitDirectories;
  try {
    after = await validateGitDirectories(options);
  } catch (error) {
    throw new Error(
      diagnosticMessage(
        "REVIEW_GIT_DIRECTORY_CHANGED",
        `Git metadata changed while Pioneer collected review context: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  if (after.fingerprint !== validated.fingerprint) {
    throw new Error(
      diagnosticMessage(
        "REVIEW_GIT_DIRECTORY_CHANGED",
        "Git metadata symbolic links or directory identities changed while Pioneer collected review context; the collected context was discarded",
      ),
    );
  }
}
