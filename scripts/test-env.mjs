import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { availableParallelism, loadavg } from "node:os";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Keep process-backed test files within the host's apparent spare CPU budget. */
export function testConcurrency({ env = process.env, cpuCount = availableParallelism(), load = loadavg()[0] } = {}) {
  const requested = env.HIVE_TEST_CONCURRENCY?.trim();
  if (requested) {
    const value = Number(requested);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("HIVE_TEST_CONCURRENCY must be a positive integer");
    return value;
  }
  return Math.max(1, Math.min(8, Math.floor(cpuCount - Math.max(0, load))));
}

/** Node 22 compile cache: strip-types of v2 .ts tests and daemon spawns reuse the cache. */
export function compileCacheDir() {
  return process.env.NODE_COMPILE_CACHE?.trim() || resolve(root, ".cache/node-compile");
}

export function testEnv(extra = {}) {
  const dir = compileCacheDir();
  mkdirSync(dir, { recursive: true });
  return { ...process.env, HIVE_NO_KEYCHAIN: process.env.HIVE_NO_KEYCHAIN ?? "1", NODE_COMPILE_CACHE: dir, ...extra };
}
