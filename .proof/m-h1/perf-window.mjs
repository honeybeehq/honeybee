import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const [dir, fromArg, toArg] = process.argv.slice(2);
const file = readdirSync(dir).find((f) => f.endsWith(".trace.json"));
const parsed = JSON.parse(readFileSync(join(dir, file), "utf8"));
const events = parsed.traceEvents.filter((e) => e.ph === "X" && typeof e.dur === "number");
const minTs = Math.min(...events.map((e) => e.ts)), maxTs = Math.max(...events.map((e) => e.ts + e.dur));
const from = minTs + Number(fromArg) * 1e6, to = maxTs - Number(toArg) * 1e6;
const by = new Map();
for (const e of events) {
  if (e.ts < from || e.ts + e.dur > to) continue;
  const row = by.get(e.name) ?? { n: 0, totalUs: 0, maxUs: 0 };
  row.n += 1; row.totalUs += e.dur; row.maxUs = Math.max(row.maxUs, e.dur); by.set(e.name, row);
}
console.log(`window ${((to - from) / 1e6).toFixed(1)}s of ${((maxTs - minTs) / 1e6).toFixed(1)}s`);
for (const [name, r] of [...by.entries()].sort((a, b) => b[1].totalUs - a[1].totalUs)) console.log(`${name.padEnd(30)} n=${String(r.n).padStart(5)} mean=${(r.totalUs / r.n / 1000).toFixed(3).padStart(8)}ms max=${(r.maxUs / 1000).toFixed(1).padStart(7)}ms total=${(r.totalUs / 1000).toFixed(0).padStart(7)}ms`);
