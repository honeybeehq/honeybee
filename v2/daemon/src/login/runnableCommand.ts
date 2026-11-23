import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { isExecutableFile, resolveExecutable, type ResolveExecutableOptions } from "../../../core/src/executables.ts";

const VERSION_PROBE_TIMEOUT_MS = 5_000;
const MAC_APP_BIN = "Cursor.app/Contents/Resources/app/bin";

export function cursorIdeBinDirs(platform: string, home: string): string[] {
  if (platform === "darwin") return [join(home, "Applications", MAC_APP_BIN), join("/Applications", MAC_APP_BIN)];
  if (platform === "linux") return [join(home, ".local/share/cursor/bin"), "/usr/share/cursor/bin", "/opt/Cursor/resources/app/bin", "/opt/cursor/resources/app/bin"];
  return [];
}

export interface RunnableCommand {
  path: string;
  ideBinDir: string | null;
}

function runsVersion(path: string, env: Record<string, string>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(path, ["--version"], { env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024 }, (error) => resolve(error === null));
  });
}

async function firstThatRuns(
  names: readonly string[],
  env: Record<string, string>,
  opts: Pick<ResolveExecutableOptions, "fallbackDirs"> & { timeoutMs?: number },
): Promise<string | null> {
  for (const name of names) {
    const resolved = resolveExecutable(name, { env, ...(opts.fallbackDirs ? { fallbackDirs: opts.fallbackDirs } : {}) });
    if (resolved && await runsVersion(resolved.path, env, opts.timeoutMs ?? VERSION_PROBE_TIMEOUT_MS)) return resolved.path;
  }
  return null;
}

export function withPathDir(env: Record<string, string>, dir: string): Record<string, string> {
  return { ...env, PATH: env.PATH ? `${dir}${delimiter}${env.PATH}` : dir };
}

export async function firstRunnableCommand(
  names: readonly string[],
  env: Record<string, string>,
  opts: Pick<ResolveExecutableOptions, "fallbackDirs"> & { timeoutMs?: number; ideBinDirs?: readonly string[] } = {},
): Promise<RunnableCommand | null> {
  const onPath = await firstThatRuns(names, env, opts);
  if (onPath) return { path: onPath, ideBinDir: null };
  for (const ideBinDir of opts.ideBinDirs ?? cursorIdeBinDirs(process.platform, homedir())) {
    if (!isExecutableFile(join(ideBinDir, "cursor"))) continue;
    const path = await firstThatRuns(names, withPathDir(env, ideBinDir), opts);
    if (path) return { path, ideBinDir };
  }
  return null;
}
