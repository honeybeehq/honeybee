import { userInfo } from "node:os";

/**
 * The developer's OS account home: the explicit HIVE_REAL_HOME override, else
 * the passwd entry, else the caller's HOME only when passwd has no answer. An
 * account-sandbox home inherited in HOME (the agy recipe activates with
 * HOME={home}) therefore never reaches a launched tool or pane; a run that
 * must keep a scratch HOME names it in HIVE_REAL_HOME.
 */
export function realUserHome(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.HIVE_REAL_HOME;
  if (explicit && explicit.trim().length > 0) return explicit;
  return passwdHome() ?? (env.HOME && env.HOME.length > 0 ? env.HOME : undefined);
}

function passwdHome(): string | undefined {
  try {
    const home = userInfo().homedir;
    return home && home.length > 0 ? home : undefined;
  } catch {
    return undefined;
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
