import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { openCoreStore } from "../../core/src/store.ts";
import { replayAudit } from "../../core/src/audit.ts";
import { DaemonCore } from "../src/loops.ts";
import { TmuxDriver } from "../../driver-tmux/src/driver.ts";
import { TmuxServer } from "../../driver-tmux/src/tmux.ts";

const fixture = fileURLToPath(new URL("../../driver-tmux/test-agent/phone-terminal.mjs", import.meta.url));

test("real type-mode driver holds on expiry, sends single-line receipt and next FIFO notice, and never retries held mail", async () => {
  const root = mkdtempSync(join(tmpdir(), "mtype-")), socketPath = join(root, "t.sock"), path = join(root, "core.sqlite3");
  const clock = { now: 1000 };
  let store = openCoreStore(path, { now: () => clock.now, ephemeral: true });
  const server = new TmuxServer({ socketPath, allowKillServer: true });
  const driver = new TmuxDriver({ socketPath, eventsDir: join(root, "events"), allowKillServer: true, now: () => clock.now, stopKillGraceMs: 100,
    resolve: beeId => ({ command: process.execPath, args: [fixture, "off"], cwd: root, env: { ...process.env, PHONE_PROVIDER_RECEIPT: join(root, `${beeId}.jsonl`) }, deliveryMode: "type", observation: { paneFallback: true, quiesceMs: 10, deliveryGraceMs: 1000 } }) });
  const calls: { id: number; body: string }[] = [];
  const deliver = driver.deliver.bind(driver);
  driver.deliver = (...args) => { calls.push({ id: args[2], body: args[3] }); return deliver(...args); };
  const core = new DaemonCore({ store, driver, now: () => clock.now, log: () => {}, policy: { commandsPerStep: 8, idleWindowSteps: null, bootHangTimeoutSteps: 100_000 } });
  const rows = (beeId: string): { ready?: boolean; submittedBody?: string }[] => {
    try { return readFileSync(join(root, `${beeId}.jsonl`), "utf8").trim().split("\n").map(line => JSON.parse(line)); } catch { return []; }
  };
  const wait = async (condition: () => boolean) => {
    for (let attempt = 0; attempt < 400; attempt++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 15)); }
    assert.fail("private type-mode fixture timed out");
  };
  try {
    core.boot();
    const sender = store.createBee({ name: "sender", agent: "stub", substrate: "tmux", cwd: root }).bee;
    const receiver = store.createBee({ name: "receiver", agent: "stub", substrate: "tmux", cwd: root }).bee;
    store.enqueueCommand("spawn", sender.id); store.enqueueCommand("spawn", receiver.id);
    await wait(() => { core.step(); return rows(sender.id).some(row => row.ready) && rows(receiver.id).some(row => row.ready) && store.currentRuntime(receiver.id)?.state === "idle"; });
    const first = store.send(receiver.id, "one\ntwo", { sender: sender.id }).message;
    const second = store.send(receiver.id, "second").message;
    const third = store.send(receiver.id, "third").message;
    for (let attempt = 0; attempt < 3; attempt++) { clock.now += 1000; core.step(); }
    const hold = store.multilineDelivery(first.id)!;
    assert.equal(hold.stage, "held");
    assert.equal(hold.heldSince, clock.now);
    assert.equal(hold.receipt?.code, "delivery_unsupported_multiline");
    const noticeId = hold.receipt!.senderNoticeMessageId!;
    assert.equal(store.getMessage(noticeId)?.body.includes("\n"), false);
    assert.equal(calls.filter(call => call.id === first.id).length, 3);
    await wait(() => { clock.now += 1000; core.step(); return store.getMessage(second.id)?.deliveredAt != null && store.getMessage(third.id)?.deliveredAt != null && store.getMessage(noticeId)?.deliveredAt != null; });
    await wait(() => rows(receiver.id).filter(row => row.submittedBody !== undefined).length >= 2 && rows(sender.id).some(row => row.submittedBody !== undefined));
    assert.deepEqual(calls.filter(call => [second.id, third.id].includes(call.id)).map(call => call.id), [second.id, third.id]);
    const delivered = rows(receiver.id).filter(row => row.submittedBody !== undefined);
    assert.equal(delivered.length, 2);
    assert.ok(delivered[0]!.submittedBody!.includes("delivered later messages; this one is held"));
    assert.ok(delivered[0]!.submittedBody!.endsWith("second"));
    assert.equal(delivered[0]!.submittedBody!.includes("\n"), false);
    assert.equal(delivered[1]!.submittedBody, "third");
    const senderInput = rows(sender.id).filter(row => row.submittedBody !== undefined);
    assert.equal(senderInput.length, 1);
    assert.ok(senderInput[0]!.submittedBody!.includes("delivery_unsupported_multiline"));
    assert.equal(senderInput[0]!.submittedBody!.includes("\n"), false);
    for (let attempt = 0; attempt < 5; attempt++) core.step();
    assert.equal(calls.filter(call => call.id === first.id).length, 3);
    assert.equal(store.getMessage(first.id)?.deliveredAt, null);
    assert.equal(store.multilineDelivery(first.id)?.notice, "delivered later messages; this one is held");
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close(); store = openCoreStore(path, { now: () => clock.now, ephemeral: true });
    assert.equal(store.getMessage(first.id)?.deliveryHold?.heldSince, hold.heldSince);
    assert.equal(store.getMessage(first.id)?.deliveryHold?.receipt?.senderNoticeMessageId, noticeId);
    assert.equal(store.readDaemonWork().find(row => row.runtime.beeId === receiver.id)?.pending.length, 0);
  } finally { driver.disposeAll(); server.killServer(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
