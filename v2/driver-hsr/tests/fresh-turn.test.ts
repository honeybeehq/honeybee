import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryReceipts, type DeliveryStatus } from "../src/delivery-receipts.ts";
import { HsrDriver } from "../src/driver.ts";
import { claudeAdapter, codexAdapter } from "../../adapters/src/index.ts";

for (const adapter of [claudeAdapter, codexAdapter({ cwd: "/fixture" })]) {
  test(`${adapter.harness}: fresh delivery refuses known active without writing`, t => {
    const dir = mkdtempSync(join(tmpdir(), "fresh-turn-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const driver = new HsrDriver({ sessionLogDir: join(dir, "logs"), resolve: () => { throw new Error("no spawn"); } });
    const writes: string[] = [];
    const proc = {
      generation: 1, phase: "running", adapter, sessionId: "thread", turnId: "turn",
      confirmedDeliveries: new Set(), pendingDeliveries: new Set(),
      child: { stdin: { writable: true, destroyed: false, write: (line: string) => writes.push(line) } },
    };
    const internals = driver as unknown as { procs: Map<string, unknown> };
    internals.procs.set("bee", proc);
    assert.deepEqual(driver.deliver("bee", 1, 31, "fresh", { freshTurn: true }), {accepted: false, reason: "not_ready"});
    assert.equal(driver.consumedGeneration(31), undefined);
    assert.deepEqual(writes, []);
    if (adapter.confirmsDelivery) assert.equal(driver.planDeliveryConfirmation("bee", 1, 31, "fresh", { freshTurn: true }), "not_ready");
  });
}


test("codex: fresh start refusal remains unconsumed and a stale steer plan cannot write", t => {
  const dir = mkdtempSync(join(tmpdir(), "fresh-refusal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const driver = new HsrDriver({ sessionLogDir: join(dir, "logs"), resolve: () => { throw new Error("no spawn"); } });
  const adapter = codexAdapter({ cwd: dir });
  const frames: string[] = [];
  const proc = {
    beeId: "bee", generation: 1, phase: "idle", adapter, sessionId: "thread", turnId: null,
    realEvidence: true, hostStyle: true, outboundPending: [], pendingWrites: [],
    processIdentity: { pid: 1, birth: "fixture", bootId: "fixture" },
    deliveryProtocol: { authenticated: true, supported: true, legacy: false, replies: new Map<number, DeliveryStatus>(), pending: new Set<number>() },
    turn: { messageIds: [] as number[] },
    confirmedDeliveries: new Set<number>(), pendingDeliveries: new Set<number>(),
    socket: { writable: true, destroyed: false, write: (line: string) => frames.push(line) },
  };
  const internals = driver as unknown as { procs: Map<string, unknown>; onSignal(proc: unknown, signal: unknown, raw: string): void };
  internals.procs.set("bee", proc);
  const plan = driver.planDeliveryConfirmation("bee", 1, 32, "fresh", { freshTurn: true });
  assert.ok(plan && plan !== "not_ready");
  assert.equal(JSON.parse(plan.wireLine).method, "turn/start");
  const staleWire = adapter.encodeMessage("fresh", { sessionId: "thread", messageId: 32, turnActive: true, turnId: "old" })!;
  assert.deepEqual(driver.deliver("bee", 1, 32, "fresh", { freshTurn: true, confirmation: { wireLine: staleWire, digest: "unused", host: { pid: 1, birth: "birth", bootId: "boot" } } }), { accepted: false, reason: "not_ready" });
  assert.deepEqual(frames, []);
  assert.deepEqual(driver.deliver("bee", 1, 32, "fresh", { freshTurn: true }), { accepted: false, reason: "not_ready" });
  assert.equal(proc.pendingDeliveries.has(32), true);
  const request = JSON.parse(JSON.parse(frames[0]!).line);
  assert.equal(request.method, "turn/start");
  assert.equal(driver.consumedGeneration(32), undefined);
  const receipts = new DeliveryReceipts("bee", 1);
  const tag = { id: 32, digest: plan.digest, beeId: "bee", generation: 1 };
  assert.equal(receipts.begin(tag, plan.wireLine), true);
  proc.deliveryProtocol.replies.set(32, receipts.status(tag));
  assert.equal(driver.reconcileDeliveryConfirmation("bee", 1, 32, plan), "pending_ack");
  assert.equal(driver.consumedGeneration(32), undefined);
  const raw = JSON.stringify({ id: request.id, error: { message: "active turn" } });
  receipts.observe(raw);
  proc.deliveryProtocol.replies.set(32, receipts.status(tag));
  assert.equal(driver.reconcileDeliveryConfirmation("bee", 1, 32, plan), "refused");
  for (const signal of adapter.parseLine(raw)) internals.onSignal(proc, signal, raw);
  assert.equal(proc.pendingDeliveries.has(32), false);
  assert.equal(proc.confirmedDeliveries.has(32), false);
  assert.equal(driver.consumedGeneration(32), undefined);
  assert.equal(frames.length, 1);
});
