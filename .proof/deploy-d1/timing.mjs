import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [beforeDir, afterDir, scratch] = process.argv.slice(2);
const BEES = 200, MAIL_PER_BEE = 250, OPENS = 40;
const load = async dir => import(pathToFileURL(join(dir, "v2/core/src/index.ts")).href);
const before = await load(beforeDir), after = await load(afterDir);
const root = mkdtempSync(join(scratch, "timing-"));
const ms = fn => { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; };
const stats = xs => { const s = [...xs].sort((a, b) => a - b); return { median: s[Math.floor(s.length / 2)], p90: s[Math.floor(s.length * 0.9)], min: s[0] }; };
const fmt = s => `median ${s.median.toFixed(2)} ms, p90 ${s.p90.toFixed(2)} ms, min ${s.min.toFixed(2)} ms`;

function populate(core, path) {
  const store = core.openCoreStore(path);
  for (let b = 0; b < BEES; b += 1) {
    const { bee, runtime } = store.createBee({ name: `bee-${b}`, agent: "claude", substrate: "hsr", cwd: root });
    store.updateRuntimeState(bee.id, runtime.generation, "stopped", { exitCause: "clean" });
    for (let m = 0; m < MAIL_PER_BEE; m += 1) store.send(bee.id, `message ${m} for bee ${b} ${"x".repeat(200)}`);
  }
  store.close();
}
const opens = (core, path) => { const out = []; for (let i = 0; i < OPENS; i += 1) out.push(ms(() => core.openCoreStore(path).close())); return out; };

mkdirSync(join(root, "before")); mkdirSync(join(root, "after")); mkdirSync(join(root, "migrate"));
const beforePath = join(root, "before", "core.sqlite3"), afterPath = join(root, "after", "core.sqlite3"), migratePath = join(root, "migrate", "core.sqlite3");
populate(before, beforePath);
populate(after, afterPath);
copyFileSync(beforePath, migratePath);
console.log(`store: ${BEES} bees, ${BEES * MAIL_PER_BEE} mail rows, ${(statSync(beforePath).size / 1e6).toFixed(1)} MB; ${OPENS} open+close per series, two alternating rounds; schema ${before.SCHEMA_VERSION} is today's main, ${after.SCHEMA_VERSION} is this change`);
const series = { before: [], after: [] };
for (let round = 0; round < 2; round += 1) {
  series.before.push(...opens(before, beforePath));
  series.after.push(...opens(after, afterPath));
}
console.log(`before (schema ${before.SCHEMA_VERSION} build on its own store): ${fmt(stats(series.before))}`);
console.log(`after  (schema ${after.SCHEMA_VERSION} build on its own store): ${fmt(stats(series.after))}`);
const migration = ms(() => after.openCoreStore(migratePath).close());
console.log(`one-time: schema ${after.SCHEMA_VERSION} build opens the schema ${before.SCHEMA_VERSION} store (backup receipt + migration + both stamps): ${migration.toFixed(2)} ms`);
console.log(`then every later open of that migrated store: ${fmt(stats(opens(after, migratePath)))}`);
rmSync(root, { recursive: true, force: true });
