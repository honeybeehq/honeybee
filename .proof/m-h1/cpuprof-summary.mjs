import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[2], top = Number(process.argv[3] ?? 40);
for (const file of readdirSync(dir).filter((f) => f.endsWith(".cpuprofile"))) {
  const prof = JSON.parse(readFileSync(join(dir, file), "utf8"));
  const byId = new Map(prof.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const self = new Map(), total = new Map();
  let sum = 0;
  for (let i = 0; i < prof.samples.length; i++) {
    const dt = prof.timeDeltas[i] ?? 0; sum += dt;
    let id = prof.samples[i];
    const n = byId.get(id); const key = `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").slice(-2).join("/")}:${n.callFrame.lineNumber}`;
    self.set(key, (self.get(key) ?? 0) + dt);
    const seen = new Set();
    while (id !== undefined) { const m = byId.get(id); const k = `${m.callFrame.functionName || "(anon)"} ${m.callFrame.url.split("/").slice(-2).join("/")}:${m.callFrame.lineNumber}`; if (!seen.has(k)) { seen.add(k); total.set(k, (total.get(k) ?? 0) + dt); } id = parent.get(id); }
  }
  console.log(file, "total ms", (sum / 1000).toFixed(0));
  console.log("--- self time");
  for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(((v / sum) * 100).toFixed(1).padStart(5) + "%  " + k);
  console.log("--- inclusive time");
  for (const [k, v] of [...total.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(((v / sum) * 100).toFixed(1).padStart(5) + "%  " + k);
}
