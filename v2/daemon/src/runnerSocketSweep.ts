import { lstat, opendir, readdir, rmdir, unlink } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";

export const RUNNER_SOCKET_PREFIX = "hb-rh-";
export const RUNNER_SOCKET_FILE_NAME = "stdin.sock";
export const RUNNER_SOCKET_SWEEP_LIMIT = 20_000;
export const RUNNER_SOCKET_SWEEP_MIN_AGE_MS = 60_000;

export interface RunnerSocketSweepOptions {
  dirs: readonly string[];
  liveSocketPaths: ReadonlySet<string>;
  uid: number;
  now: number;
  limit?: number;
  minAgeMs?: number;
}

export interface RunnerSocketSweepResult {
  dir: string;
  scanned: number;
  removed: number;
}

function refusesConnections(path: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    const settle = (refused: boolean): void => {
      socket.destroy();
      resolve(refused);
    };
    socket.once("connect", () => settle(false));
    socket.once("error", (err: NodeJS.ErrnoException) => settle(err.code === "ECONNREFUSED"));
    socket.setTimeout(timeoutMs, () => settle(false));
  });
}

async function staleSocket(path: string, options: RunnerSocketSweepOptions): Promise<boolean> {
  const stat = await lstat(path).catch(() => null);
  if (!stat?.isSocket() || stat.uid !== options.uid) return false;
  if (options.liveSocketPaths.has(path)) return false;
  return refusesConnections(path);
}

async function removeIfLeaked(path: string, options: RunnerSocketSweepOptions): Promise<boolean> {
  const stat = await lstat(path).catch(() => null);
  if (!stat || stat.uid !== options.uid) return false;
  if (options.now - stat.mtimeMs < (options.minAgeMs ?? RUNNER_SOCKET_SWEEP_MIN_AGE_MS)) return false;
  if (stat.isSocket()) {
    if (!(await staleSocket(path, options))) return false;
    await unlink(path);
    return true;
  }
  if (!stat.isDirectory()) return false;
  const names = await readdir(path).catch(() => null);
  if (names == null) return false;
  if (names.length === 1 && names[0] === RUNNER_SOCKET_FILE_NAME) {
    const socket = join(path, RUNNER_SOCKET_FILE_NAME);
    if (!(await staleSocket(socket, options))) return false;
    await unlink(socket);
  } else if (names.length > 0) {
    return false;
  }
  await rmdir(path);
  return true;
}

export async function sweepRunnerSockets(options: RunnerSocketSweepOptions): Promise<RunnerSocketSweepResult[]> {
  let budget = options.limit ?? RUNNER_SOCKET_SWEEP_LIMIT;
  const results: RunnerSocketSweepResult[] = [];
  for (const dir of new Set(options.dirs)) {
    if (budget <= 0) break;
    const result: RunnerSocketSweepResult = { dir, scanned: 0, removed: 0 };
    results.push(result);
    const handle = await opendir(dir).catch(() => null);
    if (!handle) continue;
    for await (const entry of handle) {
      if (budget-- <= 0) break;
      if (!entry.name.startsWith(RUNNER_SOCKET_PREFIX)) continue;
      result.scanned += 1;
      if (await removeIfLeaked(join(dir, entry.name), options).catch(() => false)) result.removed += 1;
    }
  }
  return results;
}
