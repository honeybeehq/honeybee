// M-H5 timing receipt: champions are always on, so every turn end of every bee now runs
// syncChampionHome -> store.getChampionByBee(beeId) (one indexed SELECT) before deciding there is nothing to do.
// This measures that per-turn-end cost on a store with many bees and one Champion, and the champion.start/export
// paths' store work, in-process. Run: node --experimental-strip-types .proof/m-h5/turn-end-cost.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore } from "../../v2/core/src/store.ts";

const dir = mkdtempSync(join(tmpdir(), "m-h5-cost-"));
try {
  const store = openCoreStore(join(dir, "core.sqlite3"), { ephemeral: true });
  const bees: string[] = [];
  for (let i = 0; i < 1000; i += 1) bees.push(store.createBee({ name: `bee-${i}`, agent: "stub", substrate: "hsr", cwd: dir }).bee.id);
  const champion = store.putChampion({ name: "Vera", agent: "stub", home: join(dir, "vera") }).champion;
  const incarnation = store.createBee({ name: "Vera", agent: "stub", substrate: "hsr", cwd: join(dir, "vera"), kind: "champion" }).bee;
  store.bindChampionBee(champion.id, incarnation.id);
  const samples = (f: () => void, n: number): { p50us: number; p95us: number; perCallUs: number } => {
    const times: number[] = [];
    for (let i = 0; i < n; i += 1) { const t = process.hrtime.bigint(); f(); times.push(Number(process.hrtime.bigint() - t) / 1000); }
    times.sort((a, b) => a - b);
    return { p50us: round(times[Math.floor(n * 0.5)]!), p95us: round(times[Math.floor(n * 0.95)]!), perCallUs: round(times.reduce((a, b) => a + b, 0) / n) };
  };
  const round = (v: number) => Math.round(v * 100) / 100;
  let i = 0;
  const result = {
    bees: 1001,
    "getChampionByBee on an ordinary bee (the per-turn-end lookup every node now does)": samples(() => { store.getChampionByBee(bees[i++ % bees.length]!); }, 20_000),
    "getChampionByBee on the incarnation": samples(() => { store.getChampionByBee(incarnation.id); }, 20_000),
    "getBee (for scale: the lookup the daemon already does per turn end)": samples(() => { store.getBee(bees[i++ % bees.length]!); }, 20_000),
    "createBee with kind: champion (the one extra column on the spawn insert)": samples(() => { store.createBee({ name: `c-${i++}`, agent: "stub", substrate: "hsr", cwd: dir, kind: "champion" }); }, 200),
    "createBee default kind": samples(() => { store.createBee({ name: `a-${i++}`, agent: "stub", substrate: "hsr", cwd: dir }); }, 200),
  };
  console.log(JSON.stringify(result, null, 2));
  store.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
