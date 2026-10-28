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
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !key.startsWith("GIT_CONFIG") && !["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"].includes(key)) env[key] = value;
  }
  return { ...env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_NOSYSTEM: "1" };
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

export function configureCellGit(cwd: string): void {
  const env = cellGitEnv(process.env);
  const worktreeConfig = entries(cwd, env).some(([key, value]) => key.toLowerCase() === "extensions.worktreeconfig" && value === "true");
  for (const scope of worktreeConfig ? ["--local", "--worktree"] : ["--local"]) {
    const keys = run(cwd, ["config", scope, "--no-includes", "--name-only", "--null", "--list"], env).split("\0").filter(Boolean);
    for (const key of new Set(keys)) {
      if ((scope === "--worktree" && /^remote\.origin\.(?:url|pushurl)$/i.test(key)) || helper.test(key) || rewrite.test(key) || /^include(?:if\..+)?\.path$/i.test(key)) {
        run(cwd, ["config", scope, "--unset-all", key], env);
      }
    }
  }
  run(cwd, ["config", "--local", "--replace-all", "credential.helper", ""], env);
  const raw = run(cwd, ["config", "--get", "remote.origin.url"], env).trim();
  const https = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(raw);
  const url = https ? `git@github.com:${https[1]}/${https[2]}.git` : raw;
  if (!sshOrigin.test(url)) throw new CellGitSafetyError("origin", "origin must be git@github.com:<org>/<repo>.git");
  run(cwd, ["config", "--local", "--replace-all", "remote.origin.url", url], env);
  run(cwd, ["config", "--local", "--replace-all", "remote.origin.pushurl", url], env);
  assertCellGitSafe(cwd, env);
}

export function assertCellGitSafe(cwd: string, env: NodeJS.ProcessEnv): void {
  const config = entries(cwd, env);
  if (config.some(([key, value]) => helper.test(key) && value.length > 0)) throw new CellGitSafetyError("credential_helper", "credential helper is configured");
  if (config.some(([key]) => rewrite.test(key))) throw new CellGitSafetyError("url_rewrite", "URL rewrite is configured");
  for (const args of [["remote", "get-url", "--all", "origin"], ["remote", "get-url", "--push", "--all", "origin"]]) {
    const urls = run(cwd, args, env).trim().split("\n");
    if (urls.some(url => !sshOrigin.test(url))) throw new CellGitSafetyError("origin", "origin must be git@github.com:<org>/<repo>.git");
  }
}
