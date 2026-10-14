import { execFileSync } from "node:child_process";
import { devNull } from "node:os";

const hostGitConfig: ReadonlyArray<readonly [string, string]> = [
  ["core.fsmonitor", "false"],
  ["core.hooksPath", devNull],
  ["submodule.recurse", "false"],
  ["diff.ignoreSubmodules", "all"],
  ["log.showSignature", "false"],
  ["core.alternateRefsCommand", ""],
];

const configScopes = new Set(["system", "global", "local", "worktree", "command"]);

const repoLocalExecConfig: ReadonlyArray<readonly [RegExp, string]> = [
  [/^filter\..+\.(?:clean|smudge|process)$/iu, ""],
  [/^filter\..+\.required$/iu, "false"],
  [/^diff\..+\.(?:textconv|command)$/iu, ""],
  [/^merge\..+\.driver$/iu, ""],
  [/^diff\.external$/iu, ""],
];

function withConfig(base: NodeJS.ProcessEnv, entries: ReadonlyArray<readonly [string, string]>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value;
  const existing = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  const offset = Number.isFinite(existing) && existing > 0 ? existing : 0;
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${offset + index}`] = key;
    env[`GIT_CONFIG_VALUE_${offset + index}`] = value;
  });
  env.GIT_CONFIG_COUNT = String(offset + entries.length);
  env.GIT_ALLOW_PROTOCOL = "file:git:http:https:ssh";
  return env;
}

export function parseConfigListing(listing: string): Array<readonly [scope: string, key: string]> {
  const fields = listing.split("\0");
  if (fields.length % 2 !== 1 || fields[fields.length - 1] !== "") {
    throw new Error("git config listing is not scope/record pairs");
  }
  const entries: Array<readonly [string, string]> = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const scope = fields[index]!;
    if (!configScopes.has(scope)) throw new Error(`git config listing has an unknown scope field: ${JSON.stringify(scope)}`);
    const record = fields[index + 1]!;
    const split = record.indexOf("\n");
    entries.push([scope, split < 0 ? record : record.slice(0, split)]);
  }
  return entries;
}

export function hostGitEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return withConfig(base, hostGitConfig);
}

export function untrustedCheckoutGitEnv(cwd: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const probe = execFileSync("git", ["-C", cwd, "config", "--list", "--show-scope", "--includes", "-z"], {
    encoding: "utf8",
    env: hostGitEnv(base),
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  const overrides = new Map<string, string>([["commit.gpgsign", "false"], ["tag.gpgsign", "false"]]);
  for (const [scope, key] of parseConfigListing(probe)) {
    if (scope !== "local" && scope !== "worktree") continue;
    for (const [pattern, value] of repoLocalExecConfig) if (pattern.test(key)) overrides.set(key, value);
  }
  return withConfig(base, [...hostGitConfig, ...overrides]);
}
