import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { INBOX_AGENT, STORE_RETENTION, auditRetention, openCoreStore, type CoreStore } from "../src/index.ts";
import { harness } from "./helpers.ts";

const DAY = 86_400_000;

function clockedStore(path: string): { store: CoreStore; clock: { now: number } } {
  const clock = { now: 1_800_000_000_000 };
  return { store: openCoreStore(path, { ephemeral: true, now: () => (clock.now += 1) }), clock };
}

function auditAs(store: CoreStore, kind: string, beeId: string | null, payload: Record<string, unknown>): number {
  return (store as unknown as { audit: (kind: string, beeId: string | null, payload: Record<string, unknown>) => number }).audit(kind, beeId, payload);
}

function pruneUntilDone(store: CoreStore, now: number): { auditRows: number; commands: number; slices: number; floorSeq: number } {
  const total = { auditRows: 0, commands: 0, slices: 0, floorSeq: 0 };
  for (;;) {
    const slice = store.pruneRetained(now);
    assert.ok(slice.auditRows <= STORE_RETENTION.sliceAuditRows && slice.commands <= STORE_RETENTION.sliceCommandRows, "a slice never exceeds its declared size");
    total.auditRows += slice.auditRows;
    total.commands += slice.commands;
    total.slices += 1;
    total.floorSeq = slice.floorSeq;
    if (slice.done) return total;
    assert.ok(total.slices < 10_000);
  }
}

test("retention declaration covers every audit kind the store reads back, and nothing else", () => {
  const source = readFileSync(new URL("../src/store.ts", import.meta.url), "utf8");
  const read = new Set<string>();
  for (const statement of source.matchAll(/(["`])((?:(?!\1)[^\\]|\\.)*?\bFROM audit\b(?:(?!\1)[^\\]|\\.)*?)\1/gs)) {
    for (const condition of statement[2]!.matchAll(/kind\s*(?:=|IN\s*\()\s*((?:'[a-z_.]+'\s*,?\s*)+)/g)) {
      for (const literal of condition[1]!.matchAll(/'([a-z_.]+)'/g)) read.add(literal[1]!);
    }
  }
  const declared = [...STORE_RETENTION.audit.keptKinds, ...STORE_RETENTION.audit.keptWhileMessageUndelivered, ...STORE_RETENTION.audit.readOnlyInsideWindow];
  assert.equal(new Set(declared).size, declared.length, "a kind is declared once");
  assert.deepEqual([...read].sort(), [...declared].sort(), "declare how long each audit kind read by SQL is kept (v2/core/src/storeRetention.ts)");
  for (const kind of STORE_RETENTION.audit.keptKinds) assert.equal(auditRetention(kind), "kept");
  for (const kind of STORE_RETENTION.audit.keptWhileMessageUndelivered) assert.equal(auditRetention(kind), "kept_while_message_undelivered");
  assert.equal(auditRetention("mail.enqueued"), "kept_above_mail_projection");
  for (const kind of ["cell.evicted", "cell.retention.pass", "runtime.updated", "flag.clear_noop", "a.kind.added.later"]) assert.equal(auditRetention(kind), "window");
});

test("a retention pass deletes audit rows and settled commands older than the window, in bounded slices, and keeps what is still read", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const { store, clock } = clockedStore(h.path);
  t.after(() => store.close());
  const { bee } = store.createBee({ id: "old-bee", name: "old-bee", agent: "stub", substrate: "hsr", cwd: "/tmp" });
  store.createBee({ id: "inbox", name: "inbox", agent: INBOX_AGENT, substrate: "hsr", cwd: "" });
  store.updateRuntimeState(bee.id, 1, "running", { pid: 10, pidStartedAt: 10 });
  const spawn = store.enqueueCommand("spawn", bee.id);
  assert.equal(store.claimNextCommand()?.id, spawn.id);
  store.completeCommand(spawn.id);
  const pending = store.send("inbox", "still waiting", { sender: "operator" }).message;
  auditAs(store, "mail.confirmation_prepared", "inbox", { row: { messageId: pending.id, generation: 1, wireLine: "x" } });
  auditAs(store, "mail.confirmation_prepared", "inbox", { row: { messageId: 999_999, generation: 1, wireLine: "x" } });
  auditAs(store, "mail.confirmation_released", "inbox", { row: { messageId: 999_998 } });
  auditAs(store, "mail.confirmation_prepared", "inbox", { row: "malformed" });
  for (let i = 0; i < STORE_RETENTION.sliceAuditRows * 2 + 50; i++) auditAs(store, "runtime.updated", bee.id, { n: i });
  auditAs(store, "cell.retention.pass", null, { kind: "land" });
  auditAs(store, "quota.observed", bee.id, { eventId: "evt-1" });
  const queued = store.enqueueCommand("stop", bee.id);
  const oldSeq = store.lastAuditSeq();
  const oldKinds = new Map<string, number>();
  for (const row of store.auditRows()) oldKinds.set(row.kind, (oldKinds.get(row.kind) ?? 0) + 1);

  clock.now += 31 * DAY;
  auditAs(store, "runtime.updated", bee.id, { n: "young" });
  const young = store.enqueueCommand("archive", "inbox");
  assert.equal(store.claimNextCommand()?.id, queued.id);
  store.completeCommand(queued.id);
  const now = clock.now + 1_000;

  assert.equal(store.retentionLastPassAt(), null);
  const first = store.pruneRetained(now);
  assert.equal(first.done, false, "the first slice of a large backlog leaves more to do");
  assert.equal(store.retentionLastPassAt(), null);
  const rest = pruneUntilDone(store, now);
  assert.ok(first.auditRows + rest.auditRows >= STORE_RETENTION.sliceAuditRows * 2 + 50);
  assert.ok(rest.slices >= 2);
  assert.equal(rest.floorSeq, oldSeq);
  assert.equal(store.auditRetentionFloorSeq(), oldSeq);
  assert.equal(store.retentionLastPassAt(), now);

  const kept = new Map<string, number>();
  for (const row of store.auditRows()) if (row.seq <= oldSeq) kept.set(row.kind, (kept.get(row.kind) ?? 0) + 1);
  assert.deepEqual([...kept].sort(), [
    ["bee.created", oldKinds.get("bee.created")],
    ["mail.confirmation_prepared", 2],
    ["quota.observed", 1],
  ].sort(), "only kept kinds, the pending message's row and the unreadable row survive below the floor");
  assert.equal(store.auditRows().filter((row) => row.seq > oldSeq && row.kind === "runtime.updated").length, 1, "rows inside the window stay");
  assert.equal(store.creationLineage(bee.id)?.parentId ?? null, null);
  assert.equal(store.getCommand(spawn.id), null, "a settled command older than the window is gone");
  assert.equal(store.getCommand(queued.id)?.status, "done", "a command settled inside the window stays");
  assert.equal(store.getCommand(young.id)?.status, "queued");
  assert.equal(store.undeliveredMessages("inbox").length, 1, "mail is not touched");
  assert.equal(store.mailHistory().messages.length, 1);
  assert.equal(store.auditTail(0, 5, null).at(-1)!.seq, store.lastAuditSeq());

  assert.deepEqual(store.pruneRetained(now), { auditRows: 0, commands: 0, floorSeq: oldSeq, done: true });
  clock.now += DAY;
  assert.deepEqual(store.pruneRetained(clock.now), { auditRows: 0, commands: 0, floorSeq: oldSeq, done: true }, "the next day's pass costs one empty slice when nothing aged out");
});

test("a retention pass stops at the window and steps over rows dated in the future", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const { store, clock } = clockedStore(h.path);
  t.after(() => store.close());
  const { bee } = store.createBee({ id: "bee", name: "bee", agent: "stub", substrate: "hsr", cwd: "/tmp" });
  const old = auditAs(store, "runtime.updated", bee.id, { n: 1 });
  const present = clock.now;
  clock.now += 400 * DAY;
  const future = auditAs(store, "runtime.updated", bee.id, { n: "future" });
  clock.now = present;
  const alsoOld = auditAs(store, "runtime.updated", bee.id, { n: 2 });
  clock.now = present + 31 * DAY;
  const young = auditAs(store, "runtime.updated", bee.id, { n: 3 });
  const slice = store.pruneRetained(clock.now + 1);
  assert.equal(slice.done, true);
  assert.equal(slice.floorSeq, alsoOld);
  const seqs = new Set(store.auditRows().map((row) => row.seq));
  assert.deepEqual([seqs.has(old), seqs.has(future), seqs.has(alsoOld), seqs.has(young)], [false, true, false, true]);
});
