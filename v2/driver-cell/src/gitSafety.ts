import { spawnSync } from "node:child_process";
import { devNull } from "node:os";

export class CellGitSafetyError extends Error {
  readonly code = "cell_git_unsafe";
  readonly reason: "origin" | "credential_helper" | "url_rewrite" | "config";
  constructor(reason: CellGitSafetyError["reason"], detail: string) {
    super(`[cell_git_unsafe] Cell git safety check refused start: ${detail}`);
    this.name = "CellGitSafetyError";
    this.reason = reason;
  }
}

export function cellGitEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  const allowedGit = new Set(["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_AUTHOR_DATE", "GIT_COMMITTER_DATE"]);
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && (!key.startsWith("GIT_") || allowedGit.has(key)) && !key.includes("ASKPASS")) env[key] = value;
  }
  return { ...env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
}

function run(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8", timeout: 10_000 });
  if (result.error || result.status !== 0) throw new CellGitSafetyError("config", `git ${args[0]} could not be checked`);
  return result.stdout;
}

function entries(cwd: string, env: NodeJS.ProcessEnv): Array<[string, string]> {
  return run(cwd, ["config", "--includes", "--null", "--list"], env).split("\0").filter(Boolean).map(record => {
    const split = record.indexOf("\n");
    return [split < 0 ? record : record.slice(0, split), split < 0 ? "" : record.slice(split + 1)];
  });
}

const helper = /^credential(?:\..+)?\.helper$/i;
const rewrite = /^url\..+\.(?:insteadof|pushinsteadof)$/i;
const sshOrigin = /^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/;

function credentialCarrier(key: string, value: string): boolean {
  return /^http(?:\..+)?\.extraheader$/i.test(key)
    || /^core\.(?:askpass|sshcommand)$/i.test(key)
    || (/^remote\.(?!origin\.)[^\n]+\.(?:url|pushurl)$/i.test(key) && /^https?:/i.test(value));
}

export function configureCellGit(cwd: string): void {
  const env = cellGitEnv(process.env);
  const identityEnv = { ...env };
  for (const key of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"]) {
    delete identityEnv[key];
    if (process.env[key] !== undefined) identityEnv[key] = process.env[key]!;
  }
  for (const [key, fallback] of [["user.name", "hive-cell"], ["user.email", "cell@hive.invalid"]]) {
    const identity = spawnSync("git", ["config", "--get", key!], { cwd, env: identityEnv, encoding: "utf8", timeout: 10_000 });
    if (identity.error || (identity.status !== 0 && identity.status !== 1)) throw new CellGitSafetyError("config", "cannot read Git identity");
    run(cwd, ["config", "--local", "--replace-all", key!, identity.stdout.trim() || fallback!], env);
  }
  const worktreeConfig = entries(cwd, env).some(([key, value]) => key.toLowerCase() === "extensions.worktreeconfig" && /^(?:true|yes|on|1)?$/i.test(value));
  for (const scope of worktreeConfig ? ["--local", "--worktree"] : ["--local"]) {
    const records = run(cwd, ["config", scope, "--no-includes", "--null", "--list"], env).split("\0").filter(Boolean);
    const unsafe = new Set<string>();
    for (const record of records) {
      const split = record.indexOf("\n");
      const key = split < 0 ? record : record.slice(0, split);
      const value = split < 0 ? "" : record.slice(split + 1);
      if ((scope === "--worktree" && /^remote\.origin\.(?:url|pushurl)$/i.test(key))
        || credentialCarrier(key, value) || /^core\.(?:fsmonitor|hookspath)$/i.test(key)
        || helper.test(key) || rewrite.test(key) || /^include(?:if\..+)?\.path$/i.test(key)) {
        unsafe.add(key);
      }
    }
    for (const key of unsafe) run(cwd, ["config", scope, "--unset-all", key], env);
  }
  run(cwd, ["config", "--local", "core.hooksPath", devNull], env);
  run(cwd, ["config", "--local", "core.fsmonitor", "false"], env);
  run(cwd, ["config", "--local", "--replace-all", "credential.helper", ""], env);
  const raw = run(cwd, ["config", "--get", "remote.origin.url"], env).trim();
  const github = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(raw);
  const url = github ? `git@github.com:${github[1]}/${github[2]}.git` : raw;
  if (!sshOrigin.test(url)) throw new CellGitSafetyError("origin", "origin must be git@github.com:<org>/<repo>.git");
  run(cwd, ["config", "--local", "--replace-all", "remote.origin.url", url], env);
  run(cwd, ["config", "--local", "--replace-all", "remote.origin.pushurl", url], env);
  assertCellGitSafe(cwd, env);
  run(cwd, ["config", "--local", "hive.cellGitSafety", "1"], env);
}

export function prepareCellGit(cwd: string): void {
  const env = cellGitEnv(process.env);
  const marker = spawnSync("git", ["config", "--local", "--get", "hive.cellGitSafety"], { cwd, env, encoding: "utf8", timeout: 10_000 });
  if (marker.status === 0 && marker.stdout.trim() === "1") assertCellGitSafe(cwd, env);
  else configureCellGit(cwd);
}

export function assertCellGitSafe(cwd: string, env: NodeJS.ProcessEnv): void {
  const config = entries(cwd, env);
  if (config.some(([key, value]) => helper.test(key) && value.length > 0)) throw new CellGitSafetyError("credential_helper", "credential helper is configured");
  if (config.some(([key, value]) => credentialCarrier(key, value))) throw new CellGitSafetyError("credential_helper", "credential-bearing Git config is configured");
  if (config.some(([key]) => rewrite.test(key))) throw new CellGitSafetyError("url_rewrite", "URL rewrite is configured");
  for (const args of [["remote", "get-url", "--all", "origin"], ["remote", "get-url", "--push", "--all", "origin"]]) {
    const urls = run(cwd, args, env).trim().split("\n");
    if (urls.some(url => !sshOrigin.test(url))) throw new CellGitSafetyError("origin", "origin must be git@github.com:<org>/<repo>.git");
  }
}
