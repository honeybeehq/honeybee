import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harness } from "../../core/tests/helpers.ts";
import { ChampionHomeSync } from "../src/championHomes.ts";

test("champion-stale-homes: set-aside homes older than the retention are swept, younger ones are counted", async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-stale-homes-"));
  const h = harness();
  try {
    const store = h.open();
    const home = join(root, "homes", "vera");
    mkdirSync(home, { recursive: true });
    store.putChampion({ name: "Vera", agent: "stub", home });
    const old = join(root, "homes", "vera.stale-0-1000");
    const young = join(root, "homes", "vera.stale-1-2000");
    for (const dir of [old, young]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "MEMORY.md"), "# Memory\n");
    }
    const past = (Date.now() - 10 * 24 * 60 * 60_000) / 1000;
    utimesSync(old, past, past);
    writeFileSync(join(root, "homes", "vera.stale-not-a-dir"), "x");
    const sync = new ChampionHomeSync({ store: () => store, root: join(root, "objects"), now: () => Date.now(), log: () => undefined });
    const status = await sync.sweepOrphans();
    assert.equal(status.staleHomesSwept, 1);
    assert.equal(status.staleHomes, 1);
    assert.equal(existsSync(old), false, "the 10-day-old set-aside home is gone");
    assert.equal(existsSync(young), true, "the young one stays");
    assert.equal(existsSync(home), true, "the live home is untouched");
    assert.deepEqual(sync.status(), status);
    store.close();
  } finally {
    h.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
