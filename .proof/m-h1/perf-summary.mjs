import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[2];
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
for (const file of files) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(join(dir, file), "utf8")); } catch { continue; }
  const events = parsed.traceEvents ?? [];
  if (!events.length) { console.log(file, Object.keys(parsed).slice(0, 10)); continue; }
  const by = new Map();
  for (const e of events) {
    if (e.ph !== "X" || typeof e.dur !== "number") continue;
    const row = by.get(e.name) ?? { n: 0, totalUs: 0, maxUs: 0 };
    row.n += 1; row.totalUs += e.dur; row.maxUs = Math.max(row.maxUs, e.dur);
    by.set(e.name, row);
  }
  const rows = [...by.entries()].sort((a, b) => b[1].totalUs - a[1].totalUs);
  console.log(file);
  for (const [name, r] of rows) console.log(`${name.padEnd(32)} n=${String(r.n).padStart(6)} mean=${(r.totalUs / r.n / 1000).toFixed(3).padStart(9)}ms max=${(r.maxUs / 1000).toFixed(1).padStart(8)}ms total=${(r.totalUs / 1000).toFixed(0).padStart(8)}ms`);
}
