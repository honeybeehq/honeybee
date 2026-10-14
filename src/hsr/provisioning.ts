/**
 * Working-copy provisioning (APIA-95) — clone/enumerate git checkouts ON THE
 * REMOTE under `<storeRoot>/worktrees/<name>`, so a bee can be spawned inside a
 * fresh checkout of a repo/branch on the node. git is driven via child_process
 * (present on any node that runs honeybee); no new deps, bundle stays inlinable.
 * Split out of remoteHost.ts so the controller stays focused on RPC wiring.
 *
 * Groundwork for Apiary's "where-it-lives" selector on non-local substrates
 * (substrates-research §5.3 / architecture §7.5): `provisionCheckout` +
 * `enumerateCheckouts` are the substrate primitives that selector will drive.
 * Node builtins only (bundle-safe).
 */

import { execFile } from "node:child_process";
import { existsSync, lstatSync, renameSync, rmSync, writeFileSync, type Dirent } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { devNull } from "node:os";
import { join } from "node:path";
import { hostGitEnv, untrustedCheckoutGitEnv } from "../hostGit.js";
import { worktreesRoot } from "./runDir.js";

/** Run git without throwing: resolves `{ ok, stdout, stderr, code }`. */
function runGit(args: string[], cwd?: string): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    let env: Record<string, string>;
    try {
      env = args[0] === "-C" && args[1] ? untrustedCheckoutGitEnv(args[1]) : hostGitEnv();
    } catch (error) {
      resolve({ ok: false, stdout: "", stderr: `checkout config probe failed: ${error instanceof Error ? error.message : String(error)}`, code: 1 });
      return;
    }
    execFile("git", args, { cwd, env, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ ok: true, stdout: stdout ?? "", stderr: stderr ?? "", code: 0 });
        return;
      }
      const code = typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1;
      resolve({ ok: false, stdout: stdout ?? "", stderr: stderr ?? "", code });
    });
  });
}

const OWNED_CONFIG_KEEP: ReadonlyArray<readonly [RegExp, RegExp]> = [
  [/^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)$/u, /^(?:true|false|0|1)$/u],
  [/^extensions\.(objectformat|refstorage|partialclone)$/u, /^(?:sha1|sha256|files|reftable|origin)$/u],
  [/^remote\.origin\.(promisor|partialclonefilter)$/u, /^[A-Za-z0-9:=._-]+$/u],
];

function configValue(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

/**
 * A reused checkout's .git/config belonged to whoever ran there last. Rewrite
 * it from the request before any host git touches the tree: only repository
 * format keys survive, hooks and fsmonitor stay pinned, and origin is exactly
 * the requested repo, so no planted filter, signing, credential, url rewrite
 * or upload-pack command can run as the host.
 */
async function ownCheckoutConfig(path: string, repo: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const gitDir = join(path, ".git");
  const configPath = join(gitDir, "config");
  try {
    if (!lstatSync(gitDir).isDirectory() || !lstatSync(configPath).isFile()) {
      return { ok: false, error: `${path} does not own its git directory` };
    }
  } catch {
    return { ok: false, error: `${path} does not own its git directory` };
  }
  const listed = await runGit(["config", "--file", configPath, "--list", "-z"]);
  if (!listed.ok) return { ok: false, error: `read checkout config failed: ${firstLine(listed.stderr) || `git exited ${listed.code}`}` };
  const kept = new Map<string, string>();
  let origin = "";
  for (const entry of listed.stdout.split("\0")) {
    const split = entry.indexOf("\n");
    if (split < 0) continue;
    const key = entry.slice(0, split).toLowerCase();
    const value = entry.slice(split + 1);
    if (key === "remote.origin.url") origin = value;
    if (OWNED_CONFIG_KEEP.some(([keyPattern, valuePattern]) => keyPattern.test(key) && valuePattern.test(value))) kept.set(key, value);
  }
  if (origin && !sameRepo(origin, repo)) return { ok: false, error: `${path} is a checkout of a different repo (${origin})` };
  const core = ["repositoryformatversion", "filemode", "ignorecase", "precomposeunicode", "symlinks"]
    .filter((name) => kept.has(`core.${name}`))
    .map((name) => `\t${name} = ${kept.get(`core.${name}`)}`);
  const extensions = ["objectformat", "refstorage", "partialclone"]
    .filter((name) => kept.has(`extensions.${name}`))
    .map((name) => `\t${name} = ${kept.get(`extensions.${name}`)}`);
  const remote = ["promisor", "partialclonefilter"]
    .filter((name) => kept.has(`remote.origin.${name}`))
    .map((name) => `\t${name} = ${kept.get(`remote.origin.${name}`)}`);
  const lines = [
    "[core]",
    ...(kept.has("core.repositoryformatversion") ? [] : ["\trepositoryformatversion = 0"]),
    ...core,
    "\tbare = false",
    "\tlogallrefupdates = true",
    `\thooksPath = ${configValue(devNull)}`,
    "\tfsmonitor = false",
    ...(extensions.length > 0 ? ["[extensions]", ...extensions] : []),
    "[remote \"origin\"]",
    `\turl = ${configValue(repo)}`,
    "\tfetch = +refs/heads/*:refs/remotes/origin/*",
    ...remote,
    "",
  ];
  const staged = `${configPath}.hive-owned`;
  try {
    writeFileSync(staged, lines.join("\n"), { mode: 0o600 });
    renameSync(staged, configPath);
    rmSync(join(gitDir, "config.worktree"), { force: true });
  } catch (error) {
    rmSync(staged, { force: true });
    return { ok: false, error: `own checkout config failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true };
}

function firstLine(text: string): string {
  return (text.split("\n").find((l) => l.trim().length > 0) ?? "").trim();
}

/** Normalize a git url for identity comparison (strip trailing `.git` / slashes). */
function normRepo(url: string): string {
  return url.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
}

function sameRepo(a: string, b: string): boolean {
  return normRepo(a) === normRepo(b);
}

/** Derive a filesystem-safe checkout name from a repo url (last path segment, no `.git`). */
function slugForRepo(repo: string): string {
  const trimmed = repo.trim().replace(/\.git$/i, "").replace(/[/\\]+$/, "");
  const seg = trimmed.split(/[/:\\]/).filter(Boolean).pop() ?? "repo";
  const cleaned = seg.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "repo";
}

/**
 * Validate a branch/ref for use as a git positional: conservative charset
 * (`^[A-Za-z0-9._/-]+$`), never `-`-leading (a `-refname` would be parsed as a
 * git flag, e.g. `--force`), no `..` (range/rev syntax). Returns null when invalid.
 */
function safeGitRef(raw: string): string | null {
  const ref = raw.trim();
  if (!ref || ref.startsWith("-") || ref.includes("..")) return null;
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) return null;
  return ref;
}

/**
 * Reject repo urls git would misinterpret: `-`-leading (parsed as an option,
 * e.g. `--upload-pack=…`) or remote-helper transport syntax (`ext::sh -c …`,
 * `fd::`, …) which executes arbitrary commands. Ordinary https/ssh/git/file
 * urls, scp-like specs and local paths pass through. Returns null when invalid.
 */
function safeRepoUrl(raw: string): string | null {
  const repo = raw.trim();
  if (!repo || repo.startsWith("-")) return null;
  if (/^[A-Za-z0-9][A-Za-z0-9+.-]*::/.test(repo)) return null;
  return repo;
}

/**
 * Validate a checkout name can never escape the worktrees dir: a single path
 * segment, no `..`, no separators, no absolute/NUL. Returns null when invalid.
 */
function safeCheckoutName(raw: string): string | null {
  const name = raw.trim();
  if (!name || name === "." || name === "..") return null;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return null;
  if (name.startsWith("/")) return null;
  return name;
}

/** Current branch of a checkout (`HEAD` when detached → undefined). Best-effort. */
async function currentBranch(path: string): Promise<string | undefined> {
  const res = await runGit(["-C", path, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (!res.ok) return undefined;
  const branch = res.stdout.trim();
  return branch && branch !== "HEAD" ? branch : undefined;
}

export type ProvisionParams = { repo?: unknown; branch?: unknown; name?: unknown; ref?: unknown };

/**
 * Clone (or idempotently reuse) a git checkout under `<storeRoot>/worktrees/<name>`.
 * Shallow (`--depth 1`) unless a `ref` needs history. Never throws — a git failure
 * (git missing, bad url, auth) surfaces as `{ ok:false, error }`.
 */
export async function provisionCheckout(params: ProvisionParams): Promise<Record<string, unknown>> {
  const rawRepo = typeof params.repo === "string" ? params.repo.trim() : "";
  if (!rawRepo) return { ok: false, error: "repo required" };
  // Never let repo/branch/ref reach git argv unvalidated: a `-`-leading value
  // becomes a git flag and an `ext::`-style url executes commands (HIVE-57).
  const repo = safeRepoUrl(rawRepo);
  if (!repo) return { ok: false, error: `invalid repo url: ${rawRepo}` };
  const rawBranch = typeof params.branch === "string" && params.branch ? params.branch : undefined;
  const branch = rawBranch === undefined ? undefined : safeGitRef(rawBranch);
  if (rawBranch !== undefined && !branch) return { ok: false, error: `invalid branch: ${rawBranch}` };
  const rawRef = typeof params.ref === "string" && params.ref ? params.ref : undefined;
  const ref = rawRef === undefined ? undefined : safeGitRef(rawRef);
  if (rawRef !== undefined && !ref) return { ok: false, error: `invalid ref: ${rawRef}` };
  const rawName = typeof params.name === "string" && params.name.trim() ? params.name.trim() : slugForRepo(repo);
  const name = safeCheckoutName(rawName);
  if (!name) return { ok: false, error: `invalid checkout name: ${rawName}` };

  const root = worktreesRoot();
  const path = join(root, name);

  if (existsSync(path)) {
    // Reuse an existing checkout of the SAME repo (fetch + checkout); refuse to
    // clobber a directory that is not this repo's checkout.
    const inside = await runGit(["-C", path, "rev-parse", "--is-inside-work-tree"]);
    if (!inside.ok || inside.stdout.trim() !== "true") {
      return { ok: false, error: `${path} exists but is not a git checkout` };
    }
    const owned = await ownCheckoutConfig(path, repo);
    if (!owned.ok) return owned;
    const fetchArgs = ref
      ? ["-C", path, "fetch", "--no-recurse-submodules", "--upload-pack=git-upload-pack", "origin"]
      : ["-C", path, "fetch", "--no-recurse-submodules", "--upload-pack=git-upload-pack", "--depth", "1", "origin", ...(branch ? ["--", branch] : [])];
    const fetched = await runGit(fetchArgs);
    if (!fetched.ok) return { ok: false, error: `fetch failed: ${firstLine(fetched.stderr) || `git exited ${fetched.code}`}` };
    if (ref) {
      // Trailing `--` pins the positional as a revision, never an option/pathspec.
      const co = await runGit(["-C", path, "checkout", "--no-recurse-submodules", ref, "--"]);
      if (!co.ok) return { ok: false, error: `checkout ${ref} failed: ${firstLine(co.stderr) || `git exited ${co.code}`}` };
    } else if (branch) {
      const co = await runGit(["-C", path, "checkout", "--no-recurse-submodules", branch, "--"]);
      if (!co.ok) return { ok: false, error: `checkout ${branch} failed: ${firstLine(co.stderr) || `git exited ${co.code}`}` };
      // Best-effort fast-forward to the freshly fetched tip.
      await runGit(["-C", path, "reset", "--hard", `origin/${branch}`]);
    }
    const resolvedBranch = branch ?? (await currentBranch(path));
    return { ok: true, path, repo, ...(resolvedBranch ? { branch: resolvedBranch } : {}), reused: true };
  }

  await mkdir(root, { recursive: true, mode: 0o700 }).catch(() => undefined);
  const cloneArgs = ["clone"];
  // Shallow by default; a pinned ref may need history, so clone full then check it out.
  if (!ref) cloneArgs.push("--depth", "1");
  if (branch) cloneArgs.push("--branch", branch);
  cloneArgs.push("--", repo, path);
  const cloned = await runGit(cloneArgs);
  if (!cloned.ok) {
    return { ok: false, error: `clone failed: ${firstLine(cloned.stderr) || firstLine(cloned.stdout) || `git exited ${cloned.code}`}` };
  }
  const owned = await ownCheckoutConfig(path, repo);
  if (!owned.ok) return owned;
  if (ref) {
    const co = await runGit(["-C", path, "checkout", "--no-recurse-submodules", ref, "--"]);
    if (!co.ok) return { ok: false, error: `checkout ${ref} failed: ${firstLine(co.stderr) || `git exited ${co.code}`}` };
  }
  const resolvedBranch = branch ?? (await currentBranch(path));
  return { ok: true, path, repo, ...(resolvedBranch ? { branch: resolvedBranch } : {}), reused: false };
}

/** Enumerate `<storeRoot>/worktrees/*` that are git checkouts. Best-effort; tolerates non-git dirs. */
export async function enumerateCheckouts(): Promise<Array<Record<string, unknown>>> {
  const root = worktreesRoot();
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const rows: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    const inside = await runGit(["-C", path, "rev-parse", "--is-inside-work-tree"]);
    if (!inside.ok || inside.stdout.trim() !== "true") continue; // tolerate a non-git dir
    const originRes = await runGit(["config", "--file", join(path, ".git", "config"), "--get", "remote.origin.url"]);
    const origin = originRes.ok ? originRes.stdout.trim() : "";
    const repo = origin ? safeRepoUrl(origin) : null;
    const owned = repo ? await ownCheckoutConfig(path, repo) : null;
    const branch = await currentBranch(path);
    const dirtyRes = owned?.ok ? await runGit(["-C", path, "status", "--porcelain", "--ignore-submodules=all"]) : null;
    rows.push({
      name: entry.name,
      path,
      repo: origin || null,
      branch: branch ?? null,
      ...(dirtyRes?.ok ? { dirty: dirtyRes.stdout.trim().length > 0 } : {}),
    });
  }
  return rows;
}
