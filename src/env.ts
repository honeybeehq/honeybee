import { statSync } from "node:fs";
import { userInfo } from "node:os";

/**
 * The home the caller's environment names. HOME wins whenever it is set and
 * is a directory; the passwd entry is consulted only when HOME is unset, so a
 * run that deliberately points HOME elsewhere never reaches the account home
 * behind its back.
 */
export function realUserHome(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.HIVE_REAL_HOME;
  if (explicit && explicit.trim().length > 0) return explicit;
  const home = env.HOME;
  if (home !== undefined) {
    if (home.length > 0 && isDirectory(home)) return home;
    return passwdHome() ?? (home.length > 0 ? home : undefined);
  }
  return passwdHome();
}

function passwdHome(): string | undefined {
  try {
    const home = userInfo().homedir;
    return home && home.length > 0 ? home : undefined;
  } catch {
    return undefined;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Environment for launching developer tools. Provider identity env may still
 * override HOME explicitly, but inherited fake account homes do not leak onward.
 */
export function launchEnv(extra: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const home = realUserHome(base);
  if (home) env.HOME = home;
  return { ...env, ...extra };
}
