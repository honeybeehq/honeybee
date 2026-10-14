/**
 * Plain-git plumbing for the cell driver (WP5, spec 05).
 *
 * A1 ruling: no Kaia anywhere in v2 — everything the cell driver needs from
 * git is a few hundred lines of plain plumbing, executed synchronously with a
 * pinned, deterministic environment (no user global/system config, no hooks).
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { devNull } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { LocalRepoIdentity } from "../../core/src/types.ts";

export class GitError extends Error {
  readonly args: string[];
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(args: string[], exitCode: number | null, stderr: string) {
    super(`git ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
    this.name = "GitError";
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export const hostGitConfig: ReadonlyArray<readonly [string, string]> = [
  ["core.fsmonitor", "false"],
  ["core.hooksPath", devNull],
  ["submodule.recurse", "false"],
  ["diff.ignoreSubmodules", "all"],
  ["commit.gpgsign", "false"],
  ["tag.gpgsign", "false"],
  ["log.showSignature", "false"],
  ["core.alternateRefsCommand", ""],
];

const REPO_LOCAL_EXEC_CONFIG: ReadonlyArray<readonly [RegExp, string]> = [
  [/^filter\..+\.(?:clean|smudge|process)$/iu, ""],
  [/^filter\..+\.required$/iu, "false"],
  [/^diff\..+\.(?:textconv|command)$/iu, ""],
  [/^merge\..+\.driver$/iu, ""],
  [/^diff\.external$/iu, ""],
];

const READ_ONLY_VERBS = new Set([
  "cat-file", "config", "count-objects", "for-each-ref", "init", "log", "merge-base", "remote", "rev-list",
  "rev-parse", "show-ref", "symbolic-ref", "update-ref", "var",
]);

function subcommandOf(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "-c" || arg === "-C" || arg === "--git-dir" || arg === "--work-tree") {
      index += 1;
      continue;
    }
    if (!arg.startsWith("-")) return arg;
  }
  return undefined;
}

const EXEC_CONFIG_HINT = /filter|textconv|command|driver|external|include/iu;
const CONFIG_SCOPES = new Set(["system", "global", "local", "worktree", "command"]);

function readIfPresent(path: string): string | null {
  try {
    if (!lstatSync(path).isFile()) return null;
    return readFileSync(path, "utf8");
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT" ? "" : null;
  }
}

function repoLocalConfigText(cwd: string): string | null {
  const dotGit = join(cwd, ".git");
  let gitDir = dotGit;
  try {
    const info = lstatSync(dotGit);
    if (info.isSymbolicLink()) return null;
    if (info.isFile()) {
      const pointer = /^gitdir:\s*(.+)$/mu.exec(readFileSync(dotGit, "utf8"));
      if (!pointer) return null;
      gitDir = resolve(cwd, pointer[1]!.trim());
    }
  } catch {
    return "";
  }
  const parts: string[] = [];
  for (const name of ["config", "config.worktree"]) {
    const text = readIfPresent(join(gitDir, name));
    if (text === null) return null;
    parts.push(text);
  }
  const commonDir = readIfPresent(join(gitDir, "commondir"));
  if (commonDir === null) return null;
  if (commonDir.trim().length > 0) {
    const text = readIfPresent(join(resolve(gitDir, commonDir.trim()), "config"));
    if (text === null) return null;
    parts.push(text);
  }
  return parts.join("\n");
}

export function parseConfigListing(listing: string): Array<readonly [scope: string, key: string]> {
  const fields = listing.split("\0");
  if (fields.length % 2 !== 1 || fields[fields.length - 1] !== "") {
    throw new Error("git config listing is not scope/record pairs");
  }
  const entries: Array<readonly [string, string]> = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const scope = fields[index]!;
    if (!CONFIG_SCOPES.has(scope)) throw new Error(`git config listing has an unknown scope field: ${JSON.stringify(scope)}`);
    const record = fields[index + 1]!;
    const split = record.indexOf("\n");
    entries.push([scope, split < 0 ? record : record.slice(0, split)]);
  }
  return entries;
}

export function repoLocalExecOverrides(cwd: string, env: Record<string, string>): Array<readonly [string, string]> {
  const localConfig = repoLocalConfigText(cwd);
  if (localConfig !== null && !EXEC_CONFIG_HINT.test(localConfig)) return [];
  const args = ["config", "--list", "--show-scope", "--includes", "-z"];
  const probe = spawnSync("git", args, { cwd, encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024, timeout: 10_000 });
  if (probe.error) throw probe.error;
  if (probe.status !== 0) throw new GitError(args, probe.status, probe.stderr ?? "");
  const overrides = new Map<string, string>();
  for (const [scope, key] of parseConfigListing(probe.stdout ?? "")) {
    if (scope !== "local" && scope !== "worktree") continue;
    for (const [pattern, value] of REPO_LOCAL_EXEC_CONFIG) if (pattern.test(key)) overrides.set(key, value);
  }
  return [...overrides];
}

export function hostGitEnv(base: Record<string, string>, overrides: ReadonlyArray<readonly [string, string]> = []): Record<string, string> {
  const env = { ...base };
  const existing = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  const offset = Number.isFinite(existing) && existing > 0 ? existing : 0;
  const entries = [...hostGitConfig, ...overrides];
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${offset + index}`] = key;
    env[`GIT_CONFIG_VALUE_${offset + index}`] = value;
  });
  env.GIT_CONFIG_COUNT = String(offset + entries.length);
  return env;
}

/**
 * Deterministic environment for every driver-run git command: the user's
 * global/system config never leaks into cell operations (gpg signing, hooks
 * templates, fsmonitor daemons), and merge/rebase commits the driver mints
 * carry a fixed identity.
 */
export function gitEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "hive-cell",
    GIT_AUTHOR_EMAIL: "cell@hive.invalid",
    GIT_COMMITTER_NAME: "hive-cell",
    GIT_COMMITTER_EMAIL: "cell@hive.invalid",
    ...extra,
  };
}

export interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run git, returning the result without throwing. */
export function tryGit(cwd: string, args: string[], opts: { env?: Record<string, string>; input?: string; timeoutMs?: number } = {}): GitResult {
  const env = gitEnv(opts.env);
  const verb = subcommandOf(args);
  const overrides = verb !== undefined && READ_ONLY_VERBS.has(verb) ? [] : repoLocalExecOverrides(cwd, env);
  const res = spawnSync("git", args, { cwd, encoding: "utf8", env: hostGitEnv(env, overrides), input: opts.input, timeout: opts.timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw res.error; // git binary missing — a machine boundary, not a git failure
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** Run git; non-zero exit throws GitError. Returns trimmed stdout. */
export function git(cwd: string, args: string[]): string {
  const res = tryGit(cwd, args);
  if (res.status !== 0) throw new GitError(args, res.status, res.stderr);
  return res.stdout.trim();
}

/** rev-parse a ref; null when it does not resolve. */
export function revParse(repo: string, ref: string): string | null {
  const res = tryGit(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return res.status === 0 ? res.stdout.trim() : null;
}

/** True iff `ancestor` is an ancestor of (or equal to) `descendant`. */
export function isAncestor(repo: string, ancestor: string, descendant: string): boolean {
  const res = tryGit(repo, ["merge-base", "--is-ancestor", ancestor, descendant]);
  return res.status === 0;
}

/** True iff the commit object exists in the repo. */
export function hasCommit(repo: string, sha: string): boolean {
  const res = tryGit(repo, ["cat-file", "-e", `${sha}^{commit}`]);
  return res.status === 0;
}

/** Realpath of `git rev-parse --git-common-dir` — same-node repo identity. */
export function gitCommonDirRealpath(repo: string): string | null {
  if (!existsSync(repo)) return null;
  const res = tryGit(repo, ["rev-parse", "--git-common-dir"]);
  if (res.status !== 0) return null;
  const raw = res.stdout.trim();
  if (raw.length === 0) return null;
  const abs = isAbsolute(raw) ? raw : resolve(repo, raw);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

export function gitObjectFormat(repo: string): LocalRepoIdentity["objectFormat"] {
  const res = tryGit(repo, ["rev-parse", "--show-object-format"]);
  return res.status === 0 && res.stdout.trim() === "sha256" ? "sha256" : "sha1";
}

export function localRepoIdentity(repo: string): LocalRepoIdentity | null {
  const dir = gitCommonDirRealpath(repo);
  if (!dir) return null;
  return { version: 1, gitCommonDirRealpath: dir, objectFormat: gitObjectFormat(repo) };
}

/** The branch HEAD symbolically points at (short name), or null when detached. */
export function currentBranch(repo: string): string | null {
  const res = tryGit(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return res.status === 0 ? res.stdout.trim() : null;
}

/** `git status --porcelain` — empty string means a clean working tree. */
export function porcelainStatus(repo: string): string {
  return git(repo, ["status", "--porcelain", "--ignore-submodules=all"]);
}

/** Full ref set of a repo (`git for-each-ref`), for bit-identical assertions. */
export function refSet(repo: string): string {
  return git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
}
