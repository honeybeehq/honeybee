import { devNull } from "node:os";

const hostGitConfig: ReadonlyArray<readonly [string, string]> = [
  ["core.fsmonitor", "false"],
  ["core.hooksPath", devNull],
  ["submodule.recurse", "false"],
  ["diff.ignoreSubmodules", "all"],
];

export function hostGitEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value;
  const existing = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  const offset = Number.isFinite(existing) && existing > 0 ? existing : 0;
  hostGitConfig.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${offset + index}`] = key;
    env[`GIT_CONFIG_VALUE_${offset + index}`] = value;
  });
  env.GIT_CONFIG_COUNT = String(offset + hostGitConfig.length);
  return env;
}
