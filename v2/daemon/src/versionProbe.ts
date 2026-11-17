import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_HOME_ENV, recipeEnvFor } from "../../core/src/accountRecipes.ts";

const XDG_DIRS = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const;

export function versionProbeEnv(kinds: readonly string[], env: Readonly<Record<string, string>>, scratch: string): Record<string, string> {
  const home = join(scratch, "home");
  const out: Record<string, string> = { ...env };
  for (const name of XDG_DIRS) out[name] = join(scratch, name.toLowerCase());
  for (const name of Object.values(HARNESS_HOME_ENV)) out[name] = home;
  for (const kind of kinds) Object.assign(out, recipeEnvFor(kind, home));
  return out;
}

export function runVersionProbe(path: string, kinds: readonly string[], env: Readonly<Record<string, string>>): Promise<string | null> {
  const scratch = mkdtempSync(join(tmpdir(), "hive-version-probe-"));
  const probeEnv = versionProbeEnv(kinds, env, scratch);
  for (const dir of new Set([join(scratch, "home"), ...XDG_DIRS.map((name) => probeEnv[name]!)])) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return new Promise((resolvePromise) => {
    execFile(path, ["--version"], { env: probeEnv, cwd: scratch, timeout: 2000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      rmSync(scratch, { recursive: true, force: true });
      const line = error ? null : String(stdout).split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? null;
      resolvePromise(line ? line.slice(0, 120) : null);
    });
  });
}
