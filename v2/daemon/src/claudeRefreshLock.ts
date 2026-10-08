/**
 * Claude Code's own cross-process OAuth refresh lock, taken by the daemon so
 * it refreshes as one more sibling of the running Claude processes instead of
 * racing them. Protocol read from the Claude Code 2.1.293 bundle: a
 * proper-lockfile directory lock at `<config dir>/.oauth_refresh.lock`
 * (stale 60 s, mtime heartbeat 5 s), plus the pre-existing
 * `<realpath(config dir)>.lock` that older versions use alone. A holder
 * re-reads the stored credential under the lock and adopts a sibling's newer
 * token rather than posting a refresh token that was already rotated.
 *
 * Claude Code rewrites its whole Keychain item (OAuth chain, MCP tokens, …)
 * from a fresh read under a third lock, `<config dir>/.storage-write.lock`
 * (stale 15 s). The daemon holds that one too, so no sibling's unrelated
 * storage write can put back the chain the daemon just rotated away.
 */
import { mkdirSync, realpathSync, rmdirSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";

export const CLAUDE_REFRESH_LOCK_STALE_MS = 60_000;
const HEARTBEAT_MS = 5_000;

export function claudeRefreshLockPaths(configDir: string): { current: string; legacy: string; storageWrite: string } {
  let resolved = configDir;
  try {
    resolved = realpathSync(configDir);
  } catch {
    resolved = configDir;
  }
  return { current: join(configDir, ".oauth_refresh.lock"), legacy: `${resolved}.lock`, storageWrite: join(configDir, ".storage-write.lock") };
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function tryAcquire(lockPath: string): boolean {
  for (const mayRemoveStale of [true, false]) {
    try {
      mkdirSync(lockPath);
      return true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    if (!mayRemoveStale) return false;
    try {
      if (statSync(lockPath).mtimeMs >= Date.now() - CLAUDE_REFRESH_LOCK_STALE_MS) return false;
      rmdirSync(lockPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return false;
    }
  }
  return false;
}

function release(lockPaths: string[]): void {
  for (const lockPath of [...lockPaths].reverse()) {
    try {
      rmdirSync(lockPath);
    } catch {
      continue;
    }
  }
}

function heartbeat(lockPaths: string[]): void {
  const at = new Date();
  for (const lockPath of lockPaths) {
    try {
      utimesSync(lockPath, at, at);
    } catch {
      continue;
    }
  }
}

export type ClaudeRefreshLockResult<T> = { acquired: true; value: T } | { acquired: false };

export async function withClaudeRefreshLock<T>(configDir: string, run: () => Promise<T>): Promise<ClaudeRefreshLockResult<T>> {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const paths = claudeRefreshLockPaths(configDir);
  if (!tryAcquire(paths.current)) return { acquired: false };
  const held = [paths.current];
  let legacy: "acquired" | "contended" | "unavailable";
  try {
    legacy = tryAcquire(paths.legacy) ? "acquired" : "contended";
  } catch {
    legacy = "unavailable";
  }
  if (legacy === "contended") {
    release(held);
    return { acquired: false };
  }
  if (legacy === "acquired") held.push(paths.legacy);
  let storageWrite: boolean;
  try {
    storageWrite = tryAcquire(paths.storageWrite);
  } catch (error) {
    release(held);
    throw error;
  }
  if (!storageWrite) {
    release(held);
    return { acquired: false };
  }
  held.push(paths.storageWrite);
  const beat = setInterval(() => heartbeat(held), HEARTBEAT_MS);
  beat.unref();
  try {
    return { acquired: true, value: await run() };
  } finally {
    clearInterval(beat);
    release(held);
  }
}
