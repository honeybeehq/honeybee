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
let escapeWritable = null;
if (process.env.PROBE_ESCAPE_DIR) {
  try {
    writeFileSync(join(process.env.PROBE_ESCAPE_DIR, `escape-${process.env.HIVE_BEE_ID}`), "leak");
    escapeWritable = true;
  } catch {
    escapeWritable = false;
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
  escapeWritable,
}));
