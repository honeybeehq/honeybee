import { execFile } from "node:child_process";
import { join } from "node:path";
import { resolveExecutable, type ResolveExecutableOptions } from "../../../core/src/executables.ts";

const VERSION_PROBE_TIMEOUT_MS = 5_000;
const BUNDLED_AGENT = "User/globalStorage/anysphere.cursor-agent-worker/agent-cli/.local/bin/cursor-agent";

export const CURSOR_AGENT_VERSION = /^\d{4}\.\d{1,2}\.\d{1,2}-[0-9a-f]{6,}$/;

export function cursorBundledAgentPaths(platform: string, home: string): string[] {
  if (platform === "darwin") return [join(home, "Library/Application Support/Cursor", BUNDLED_AGENT)];
  if (platform === "linux") return [join(home, ".config/Cursor", BUNDLED_AGENT)];
  return [];
}

function versionOf(path: string, env: Record<string, string>, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(path, ["--version"], { env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024 }, (error, stdout) => {
      resolve(error === null ? String(stdout).trim().split("\n")[0]!.trim() : null);
    });
  });
}

export async function firstRunnableCommand(
  candidates: readonly string[],
  env: Record<string, string>,
  opts: Pick<ResolveExecutableOptions, "fallbackDirs"> & { timeoutMs?: number; versionPattern?: RegExp } = {},
): Promise<string | null> {
  for (const candidate of candidates) {
    const resolved = resolveExecutable(candidate, { env, ...(opts.fallbackDirs ? { fallbackDirs: opts.fallbackDirs } : {}) });
    if (!resolved) continue;
    const version = await versionOf(resolved.path, env, opts.timeoutMs ?? VERSION_PROBE_TIMEOUT_MS);
    if (version !== null && (opts.versionPattern?.test(version) ?? true)) return resolved.path;
  }
  return null;
}
