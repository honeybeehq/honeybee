import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STORE_RETENTION, openCoreStore } from "../../core/src/index.ts";
import type { AuditTailResult } from "../src/protocol.ts";
import { makeDaemonDir, sleep, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const passes = (dir: string): string[] => readFileSync(join(dir, "hived.log"), "utf8").split("\n").filter((line) => line.includes("store.retention.pass"));

test("the daemon prunes the store once a day through its deadline heap, in slices, and a restart does not buy another pass", { timeout: 120_000 }, async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    let clock = Date.now() - STORE_RETENTION.windowMs - 86_400_000;
    const store = openCoreStore(join(dir, "core.sqlite3"), { ephemeral: true, now: () => (clock += 1) });
    store.createBee({ id: "old", name: "old", agent: "stub", substrate: "hsr", cwd: dir });
    store.updateRuntimeState("old", 1, "stopped", { exitCause: "clean" });
    const rows = STORE_RETENTION.sliceAuditRows * 3;
    for (let i = 0; i < rows; i++) store.renameBee("old", `old-${i}`);
    const expired = store.lastAuditSeq();
    store.close();

    daemon = await startDaemon(dir, { env: { HIVE_TEST_STORE_RETENTION_DELAY_MS: "0" } });
    const line = await waitFor(() => passes(dir)[0] ?? null, "the first retention pass", 60_000, 50);
    const pass = /audit=(\d+) commands=(\d+) floor=(\d+) slices=(\d+)/.exec(line)!;
    assert.ok(Number(pass[1]) >= rows, line);
    assert.equal(Number(pass[3]), expired);
    assert.ok(Number(pass[4]) >= 4, `a backlog of ${rows} rows takes several slices: ${line}`);
    const client = await daemon.client();
    try {
      const old = await client.request<AuditTailResult>("audit.tail", { beeId: "old", afterSeq: 0, limit: 1000 });
      assert.deepEqual(old.rows.filter((row) => row.seq <= expired).map((row) => row.kind), ["bee.created"], "only what the store still reads survives below the floor");
      assert.equal((await client.request<{ bee: { name: string } }>("view", { beeId: "old" })).bee.name, `old-${rows - 1}`);
    } finally { client.close(); }

    await daemon.stop();
    daemon = await startDaemon(dir, { env: { HIVE_TEST_STORE_RETENTION_DELAY_MS: "0" } });
    await sleep(2_000);
    assert.equal(passes(dir).length, 1, "the next pass is a day after the last one, whatever the restarts in between");
  } finally { await daemon?.stop(); cleanup(); }
});
