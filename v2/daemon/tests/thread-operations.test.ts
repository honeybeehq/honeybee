import { threadFixture } from "./thread-fixture.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { replayAudit, type ThreadOperationRow } from "../../core/src/index.ts";
import { stubAdapter } from "../../adapters/src/stub.ts";
import { ThreadOperations } from "../src/threadOperations.ts";
import { copyPinnedHistory, pinThreadHistory, readThreadHistory, seedSuccessorHistory } from "../src/threadHistory.ts";
import { DaemonCore } from "../src/loops.ts";
import { FakeDriver, waitFor } from "./helpers.ts";


const spec = { command: "unused", args: [], adapter: stubAdapter };

test("thread pipeline publishes history before compaction; queued messages wait through failure and restart", async t => {
  const f = threadFixture(t);
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const service = new ThreadOperations(f.store, () => spec, async () => { await hold; throw new Error("provider failure"); });
  service.tick();
  await waitFor(() => f.store.getThreadOperation(f.row.id)?.phase === "compacting", "compacting");
  assert.equal(f.store.getThreadOperation(f.row.id)?.transcriptReady, true);
  const inherited = await readThreadHistory(f.store.getThreadOperation(f.row.id)!, 0, 1048576);
  assert.match(Buffer.from(inherited.data, "base64").toString(), /SQLite/);
  f.store.send("successor", "queued next");
  f.store.send("successor", "queued now", { urgency: "now" });
  const driver = new FakeDriver(Date.now);
  let core = new DaemonCore({ store: f.store, driver, policy: { commandsPerStep: 10, bootHangTimeoutSteps: 10 }, now: Date.now, log: () => {} });
  core.step();
  assert.equal(driver.deliveredIds.length, 0);
  assert.equal(f.store.currentRuntime("successor")?.generation, 1);
  release();
  await waitFor(() => f.store.getThreadOperation(f.row.id)?.phase === "failed", "failed");
  await service.shutdown();
  f.restart();
  assert.equal(f.store.threadOperationByKey("key")?.successorBeeId, "successor");
  assert.equal(f.store.getThreadOperation(f.row.id)?.transcriptReady, true, "reload retains readable history");
  assert.equal(f.store.claimNextCommand(), null);
  f.store.retryThreadOperation(f.row.id);
  const recovered = new ThreadOperations(f.store, () => spec, async ({ row }) => { assert.equal(row.successorBeeId, "successor"); });
  recovered.tick();
  await waitFor(() => f.store.getThreadOperation(f.row.id)?.phase === "starting", "starting");
  core = new DaemonCore({ store: f.store, driver, policy: { commandsPerStep: 10, bootHangTimeoutSteps: 10000 }, now: Date.now, log: () => {} });
  core.step(); core.step();
  assert.equal(driver.deliveredIds.length, 0, "real boot still waits for authoritative ready transition");
  recovered.tick(); core.step();
  assert.equal(f.store.getThreadOperation(f.row.id)?.phase, "ready");
  assert.equal(driver.deliveredIds[0], f.row.continuationMessageId);
  assert.equal(f.store.getBee("source")?.lifecycle, "active");
  assert.deepEqual(replayAudit(f.store.auditRows()), f.store.dumpState());
  await recovered.shutdown();
});

test("pinned prefix ignores concurrent output, streams large history, rekeys only the native header, and pages all bytes", async t => {
  const f = threadFixture(t, "fork");
  const line = JSON.stringify({ timestamp: new Date().toISOString(), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "✓".repeat(5000) }] } }) + "\n";
  for (let i = 0; i < 1500; i++) appendFileSync(f.sourcePath, line);
  const row: ThreadOperationRow = { ...f.row, source: pinThreadHistory(f.sourcePath, f.row.sourceProviderSessionId) };
  appendFileSync(f.sourcePath, '{"partial":');
  const pinnedPartial = pinThreadHistory(f.sourcePath, f.row.sourceProviderSessionId);
  assert.equal(pinnedPartial.bytes, row.source.bytes);
  const copying = copyPinnedHistory(row);
  appendFileSync(f.sourcePath, '"LATER OUTPUT"}\n');
  await copying;
  await seedSuccessorHistory(row);
  const history = readFileSync(row.historyPath);
  assert.equal(history.length, row.source.bytes);
  assert.equal(history.includes("LATER OUTPUT"), false);
  const successor = readFileSync(row.sessionPath);
  const end = history.indexOf(10); const successorEnd = successor.indexOf(10);
  assert.deepEqual(history.subarray(end + 1), successor.subarray(successorEnd + 1));
  assert.equal(JSON.parse(successor.subarray(0, successorEnd).toString()).payload.id, row.successorProviderSessionId);
  const pages: Buffer[] = []; let offset = 0;
  while (offset < history.length) {
    const page = await readThreadHistory({ ...row, transcriptReady: true }, offset, 65537);
    pages.push(Buffer.from(page.data, "base64")); offset = page.nextOffset;
  }
  assert.deepEqual(Buffer.concat(pages), history, "UTF-8 byte boundaries lose no content");
});

test("copy refuses a truncated pinned source", async t => {
  const f = threadFixture(t);
  writeFileSync(f.sourcePath, "truncated\n");
  await assert.rejects(copyPinnedHistory(f.row), /replaced or truncated/);
});

test("recovery refuses an unverifiable live worker and bounds automatic attempts", async t => {
  const f = threadFixture(t);
  f.store.updateThreadOperation(f.row.id, { worker: { pid: process.pid, startedAt: 1 } });
  const service = new ThreadOperations(f.store, () => spec);
  service.tick();
  await waitFor(() => f.store.getThreadOperation(f.row.id)?.phase === "failed", "worker refusal");
  assert.equal(f.store.getThreadOperation(f.row.id)?.failure?.code, "worker_unreachable");
  assert.equal(f.store.claimNextCommand(), null);
  await service.shutdown();
  f.store.retryThreadOperation(f.row.id);
  f.store.updateThreadOperation(f.row.id, { worker: null, attempt: 3 });
  const recovered = new ThreadOperations(f.store, () => spec);
  recovered.tick();
  await waitFor(() => f.store.getThreadOperation(f.row.id)?.phase === "failed", "attempt budget");
  assert.equal(f.store.getThreadOperation(f.row.id)?.failure?.code, "attempts_exhausted");
  assert.equal(f.store.listBees().length, 2);
  await recovered.shutdown();
});

test("fork never calls compaction and never enqueues continuation", async t => {
  const f = threadFixture(t, "fork");
  let calls = 0;
  const service = new ThreadOperations(f.store, () => spec, async () => { calls++; });
  service.tick();
  await waitFor(() => f.store.getThreadOperation(f.row.id)?.phase === "starting", "plain copy");
  assert.equal(calls, 0);
  assert.equal(f.store.listMessages("successor").length, 0);
  assert.equal(f.store.getThreadOperation(f.row.id)?.compacted, false);
  await service.shutdown();
});

test("restart after completed copy but lost readiness receipt uses owned history even when the source is gone", async t => {
  const f = threadFixture(t, "fork");
  await copyPinnedHistory(f.row);
  const original = readFileSync(f.row.historyPath);
  rmSync(f.sourcePath);
  f.restart();
  const service = new ThreadOperations(f.store, () => spec);
  service.tick();
  await waitFor(() => f.store.getThreadOperation(f.row.id)?.phase === "starting", "recovered copy receipt");
  assert.deepEqual(readFileSync(f.row.historyPath), original);
  assert.equal(f.store.listBees().length, 2);
  await service.shutdown();
});

test("startup crashes exhaust the ordinary budget; explicit retry keeps the same compacted successor", async t => {
  let now = Date.now();
  const f = threadFixture(t, "handoff", { now: () => now, backoffBaseMs: 1, maxAttempts: 3 });
  let compactCalls = 0;
  const service = new ThreadOperations(f.store, () => spec, async () => { compactCalls++; });
  service.tick();
  await waitFor(() => f.store.getThreadOperation(f.row.id)?.phase === "starting", "prepared successor");
  const driver = new FakeDriver(() => now); driver.bootCrash = true;
  const core = new DaemonCore({ store: f.store, driver, policy: { commandsPerStep: 10, bootHangTimeoutSteps: 10000 }, now: () => now, log: () => {} });
  for (let i = 0; i < 30; i++) { now += 100; service.tick(); core.step(); }
  assert.equal(f.store.getThreadOperation(f.row.id)?.failure?.code, "startup_failed");
  assert.equal(f.store.getBee("successor")?.spawnFailures, 3);
  assert.equal(driver.deliveredIds.length, 0);
  assert.equal(compactCalls, 1);
  f.store.retryThreadOperation(f.row.id); driver.bootCrash = false;
  for (let i = 0; i < 5; i++) { now += 100; service.tick(); core.step(); }
  assert.equal(f.store.getThreadOperation(f.row.id)?.phase, "ready");
  assert.equal(compactCalls, 1, "retry of readiness never recompacts");
  assert.equal(f.store.threadOperationByKey("key")?.successorBeeId, "successor");
  await service.shutdown();
});

test("restart during compaction retries the same native session without releasing queued mail", async t => {
  const f = threadFixture(t);
  const service = new ThreadOperations(f.store, () => spec, async ({ signal }) => {
    appendFileSync(f.row.sessionPath, '{"type":"compacted","payload":{"message":"first attempt"}}\n');
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  service.tick();
  await waitFor(() => f.store.getThreadOperation(f.row.id)?.phase === "compacting", "compaction in progress");
  await service.shutdown();
  f.restart();
  assert.equal(f.store.getThreadOperation(f.row.id)?.phase, "compacting");
  assert.equal(f.store.claimNextCommand(), null);
  const recovered = new ThreadOperations(f.store, () => spec, async ({ row }) => {
    assert.equal(row.successorProviderSessionId, f.row.successorProviderSessionId);
    assert.match(readFileSync(row.sessionPath, "utf8"), /first attempt/);
  });
  recovered.tick();
  await waitFor(() => f.store.getThreadOperation(f.row.id)?.phase === "starting", "reconciled compaction");
  assert.equal(f.store.listBees().length, 2);
  await recovered.shutdown();
});
