import { enableCompileCache, flushCompileCache } from "node:module";
import { readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cache = enableCompileCache();
await import("./payload.mjs");
flushCompileCache();
let entries = [];
try {
  entries = readdirSync(cache.directory ?? "", { recursive: true });
} catch {}
const escapes = {};
for (const dir of JSON.parse(process.env.PROBE_ESCAPE_DIRS ?? "[]")) {
  try {
    writeFileSync(join(dir, `escape-${process.env.HIVE_BEE_ID}-${process.pid}`), "leak");
    escapes[dir] = true;
  } catch {
    escapes[dir] = false;
  }
}
let fillError = null;
if (process.env.PROBE_FILL_TMP_BYTES) {
  try {
    writeFileSync("/tmp/fill", Buffer.alloc(Number(process.env.PROBE_FILL_TMP_BYTES)));
  } catch (error) {
    fillError = error.code ?? String(error);
  }
}
let tmpWritable = false;
try {
  writeFileSync(join(tmpdir(), "probe-write"), "ok");
  tmpWritable = true;
} catch {}
writeFileSync(join(process.env.PROBE_OUT_DIR ?? process.cwd(), `${process.env.HIVE_BEE_ID}.${process.pid}.json`), JSON.stringify({
  TMPDIR: process.env.TMPDIR ?? null,
  tmpdir: tmpdir(),
  NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE ?? null,
  cacheStatus: cache.status,
  cacheDirectory: cache.directory ?? null,
  cacheEntries: entries.length,
  tmpWritable,
  escapes,
  fillError,
}));
