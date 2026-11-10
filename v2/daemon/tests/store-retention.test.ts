import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STORE_RETENTION, openCoreStore } from "../../core/src/index.ts";
import type { AuditTailResult } from "../src/protocol.ts";
import { makeDaemonDir, sleep, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const PASS_FIELDS = ["audit", "commands", "mail_history_copies_cleared", "mail_history_orphans_removed", "floor", "slices"] as const;
type Pass = Record<(typeof PASS_FIELDS)[number], number> & { line: string };
function passOf(line: string): Pass | null {
  const op = (() => { try { return (JSON.parse(line) as { op?: unknown }).op; } catch { return null; } })();
  if (typeof op !== "string" || !op.startsWith("store.retention.pass ")) return null;
  const fields = new Map([...op.matchAll(/(\w+)=(\d+(?:\.\d+)?)/g)].map((match) => [match[1]!, Number(match[2])]));
  if (!PASS_FIELDS.every((name) => fields.has(name))) return null;
  const field = (name: (typeof PASS_FIELDS)[number]): number => fields.get(name)!;
  return { audit: field("audit"), commands: field("commands"), mail_history_copies_cleared: field("mail_history_copies_cleared"), mail_history_orphans_removed: field("mail_history_orphans_removed"), floor: field("floor"), slices: field("slices"), line: op };
}
const passes = (dir: string): Pass[] => readFileSync(join(dir, "hived.log"), "utf8").split("\n").flatMap((line) => { const pass = passOf(line); return pass ? [pass] : []; });

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
    const pass = await waitFor(() => passes(dir)[0] ?? null, "the first complete retention pass line", 60_000, 50);
    assert.ok(pass.audit >= rows, pass.line);
    assert.equal(pass.floor, expired);
    assert.ok(pass.slices >= 4, `a backlog of ${rows} rows takes several slices: ${pass.line}`);
    assert.equal(pass.mail_history_copies_cleared, 0, pass.line);
    assert.equal(pass.mail_history_orphans_removed, 0, pass.line);
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
