import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Node 22 compile cache: strip-types of v2 .ts tests and daemon spawns reuse the cache. */
export function compileCacheDir() {
  return process.env.NODE_COMPILE_CACHE?.trim() || resolve(root, ".cache/node-compile");
}

export function testEnv(extra = {}) {
  const dir = compileCacheDir();
  mkdirSync(dir, { recursive: true });
  const ambient = { ...process.env };
  for (const key of ["HIVE_BEE_ID", "HIVE_BEE", "HIVE_PARENT", "HIVE_CELL", "HIVE_CELL_SPACE", "HIVE_V2_DATA_DIR", "HIVE_V2_SOCKET_PATH"]) delete ambient[key];
  return { ...ambient, HIVE_NO_KEYCHAIN: ambient.HIVE_NO_KEYCHAIN ?? "1", NODE_COMPILE_CACHE: dir, ...extra };
}
