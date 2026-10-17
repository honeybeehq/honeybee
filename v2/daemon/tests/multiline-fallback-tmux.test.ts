import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { openCoreStore } from "../../core/src/store.ts";
import { PHONE_FORMAT, renderPhoneInput } from "../../core/src/phoneOrigin.ts";
import { replayAudit } from "../../core/src/audit.ts";
import { DaemonCore } from "../src/loops.ts";
import { TmuxDriver } from "../../driver-tmux/src/driver.ts";
import { TmuxServer } from "../../driver-tmux/src/tmux.ts";
import { ensureDeliveryFileArtifact } from "./delivery-file-build.ts";
import { DeliveryFiles } from "../src/deliveryFile.ts";

test("real type-mode terminal receives one phone pointer, reads original frame, and never receives it again after store reopen", async t => {
  ensureDeliveryFileArtifact();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mfp-"))), data = join(root, "data"), work = join(root, "work"), socketPath = join(root, "t.sock");
  mkdirSync(data, {mode: 0o700}); mkdirSync(work, {mode: 0o700});
  const path = join(data, "core.sqlite3"), receipt = join(root, "receipt.jsonl");
  let store = openCoreStore(path, {now: () => 1000, ephemeral: true});
  const server = new TmuxServer({socketPath, allowKillServer: true});
  const fixture = fileURLToPath(new URL("../../driver-tmux/test-agent/phone-terminal.mjs", import.meta.url));
  const driver = new TmuxDriver({socketPath, eventsDir: join(root, "events"), allowKillServer: true, stopKillGraceMs: 100,
    resolve: () => ({command: process.execPath, args: [fixture, "off"], cwd: work, env: {...process.env, PHONE_PROVIDER_RECEIPT: receipt, PHONE_FALLBACK_ROOT: data}, deliveryMode: "type", observation: {paneFallback: true, quiesceMs: 10, deliveryGraceMs: 1000}})});
  t.after(() => {driver.disposeAll(); server.killServer(); store.close(); rmSync(root, {recursive: true, force: true});});
  const makeCore = () => new DaemonCore({store, driver, now: () => 1000, log: () => {}, policy: {commandsPerStep: 8, idleWindowSteps: null, bootHangTimeoutSteps: 100000}, multilineFallback: {root: data, worktrees: () => [work], files: new DeliveryFiles(undefined, root)}});
  let core = makeCore(); core.boot();
  const rows = (): {ready?: boolean; submittedBody?: string; fallbackRead?: {sha256: string; header: string}}[] => {try {return readFileSync(receipt, "utf8").trim().split("\n").map(line => JSON.parse(line));} catch {return [];}};
  const wait = async (condition: () => boolean) => {
    for (let attempt = 0; attempt < 400; attempt++) {if (condition()) return; await new Promise(resolve => setTimeout(resolve, 15));}
    assert.fail("private pointer terminal timed out");
  };
  const bee = store.createBee({name: "pointer", agent: "stub", substrate: "tmux", cwd: work}).bee;
  store.enqueueCommand("spawn", bee.id);
  await wait(() => {core.step(); return rows().some(row => row.ready) && store.currentRuntime(bee.id)?.state === "idle";});
  const original = "nonce-from-phone\n</apiary-phone-unverified>&雪";
  const message = store.send(bee.id, original, {phone: {key: "pointer-phone", origin: {format: PHONE_FORMAT, channel: "phone", issuerNodeId: "test-node", assigner: "listener/1", credentialRef: "opaque-device", target: {kind: "bee", id: bee.id}, contentKind: "message", assurance: "credential-possession-only", humanApproval: "not-verified", lane: "envelope-v1", parentSources: [], rootSources: [], ancestry: "complete"}}}).message;
  const later = store.send(bee.id, "later").message;
  let loseReceipt = true;
  const complete = store.completeMultilineFallback.bind(store);
  store.completeMultilineFallback = (id, generation, source) => {
    if (id === message.id && loseReceipt) {loseReceipt = false; throw new Error("lost completion commit");}
    return complete(id, generation, source);
  };
  await wait(() => {core.step(); return store.getMessage(later.id)?.deliveredAt !== null && rows().filter(row => row.submittedBody !== undefined).length === 2;});
  const fallback = store.getMessage(message.id)!.deliveryFallback!;
  assert.equal(fallback.state, "delivered");
  assert.ok(store.auditRows().some(row => row.kind === "mail.delivery_fallback_unknown"));
  assert.equal(driver.deliveryReceipt(bee.id, 1, message.id, fallback.pointer!), "accepted");
  assert.equal(driver.deliveryReceipt(bee.id, 1, message.id, fallback.pointer! + " altered"), "unknown");
  assert.deepEqual(rows().filter(row => row.submittedBody !== undefined).map(row => row.submittedBody), [`Paired-phone message — human approval not verified; full text: ${fallback.path}`, "later"]);
  const content = readFileSync(fallback.path!, "utf8");
  assert.equal(content, `Honeybee delivery content: message=${message.id} publication=${fallback.id}\n\n${renderPhoneInput(original)}`);
  assert.deepEqual(rows().find(row => row.fallbackRead)?.fallbackRead, {sha256: fallback.digest, header: `Honeybee delivery content: message=${message.id} publication=${fallback.id}`});
  assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  store.close(); store = openCoreStore(path, {now: () => 1000, ephemeral: true}); core = makeCore(); core.boot();
  for (let attempt = 0; attempt < 5; attempt++) core.step();
  assert.equal(rows().filter(row => row.submittedBody !== undefined).length, 2);
});

for (const clearWorks of [true, false]) test(`real partial pointer before Enter ${clearWorks ? "clears and retries the same publication" : "quarantines all later mail"}`, async t => {
  ensureDeliveryFileArtifact();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mfp-partial-"))), data = join(root, "data"), work = join(root, "work"), socketPath = join(root, "t.sock"), receipt = join(root, "receipt.jsonl");
  mkdirSync(data, {mode: 0o700}); mkdirSync(work, {mode: 0o700});
  const store = openCoreStore(join(data, "core.sqlite3"), {now: () => 1000, ephemeral: true});
  const server = new TmuxServer({socketPath, allowKillServer: true});
  const fixture = fileURLToPath(new URL("../../driver-tmux/test-agent/phone-terminal.mjs", import.meta.url));
  const driver = new TmuxDriver({socketPath, eventsDir: join(root, "events"), allowKillServer: true, stopKillGraceMs: 100,
    resolve: () => ({command: process.execPath, args: [fixture, "off"], cwd: work, env: {...process.env, PHONE_PROVIDER_RECEIPT: receipt, PHONE_FALLBACK_ROOT: data, PHONE_IGNORE_CLEAR: clearWorks ? "0" : "1"}, deliveryMode: "type", observation: {paneFallback: true, quiesceMs: 10, deliveryGraceMs: 1000}})});
  t.after(() => {driver.disposeAll(); server.killServer(); store.close(); rmSync(root, {recursive: true, force: true});});
  const core = new DaemonCore({store, driver, now: () => 1000, log: () => {}, policy: {commandsPerStep: 8, idleWindowSteps: null, bootHangTimeoutSteps: 100000}, multilineFallback: {root: data, worktrees: () => [work], files: new DeliveryFiles(undefined, root)}}); core.boot();
  const rows = (): {ready?: boolean; submittedBody?: string}[] => {try {return readFileSync(receipt, "utf8").trim().split("\n").map(line => JSON.parse(line));} catch {return [];}};
  const wait = async (condition: () => boolean) => {for (let i = 0; i < 400; i++) {if (condition()) return; await new Promise(resolve => setTimeout(resolve, 15));} assert.fail("partial terminal timed out");};
  const bee = store.createBee({name: "partial", agent: "stub", substrate: "tmux", cwd: work}).bee; store.enqueueCommand("spawn", bee.id);
  await wait(() => {core.step(); return rows().some(row => row.ready) && store.currentRuntime(bee.id)?.state === "idle";});
  const hook = driver as unknown as {inject: (...args: unknown[]) => void}, inject = hook.inject.bind(driver); let partial = true;
  hook.inject = (...args) => {if (partial && String(args[1]).includes("full text: ")) {partial = false; args[1] = "partial-pointer";} inject(...args);};
  const message = store.send(bee.id, "one\ntwo").message;
  for (let i = 0; i < 3; i++) store.recordMultilineDeliveryRefusal(message.id, 1, "multiline_type_mode");
  const later = store.send(bee.id, "later-exact").message;
  core.step(); const initial = store.getMessage(message.id)!.deliveryFallback!;
  assert.equal(initial.attemptPhase, clearWorks ? "before_enter_cleared" : "before_enter_unknown");
  assert.equal(initial.attempts, 1); assert.equal(rows().filter(row => row.submittedBody !== undefined).length, 0);
  if (clearWorks) {
    await wait(() => {core.step(); return store.getMessage(later.id)?.deliveredAt !== null && rows().filter(row => row.submittedBody !== undefined).length === 2;});
    const final = store.getMessage(message.id)!.deliveryFallback!;
    assert.equal(final.id, initial.id); assert.equal(final.path, initial.path); assert.equal(final.attempts, 2);
    assert.deepEqual(rows().filter(row => row.submittedBody !== undefined).map(row => row.submittedBody), [final.pointer, "later-exact"]);
  } else {
    for (let i = 0; i < 5; i++) core.step();
    assert.equal(store.getMessage(message.id)?.deliveryFallback?.detail, "pane_input_unknown");
    assert.equal(store.getMessage(later.id)?.deliveredAt, null); assert.equal(store.multilinePaneQuarantines().length, 1);
    assert.equal(driver.deliver(bee.id, 1, later.id, "direct-later").detail, "pane_input_unknown");
    assert.equal(rows().filter(row => row.submittedBody !== undefined).length, 0);
    store.cancelMessage(bee.id, message.id); core.step(); assert.equal(store.getMessage(later.id)?.deliveredAt, null);
    driver.stop(bee.id, 1, "stopped_by_user");
    await wait(() => {core.step(); return store.currentRuntime(bee.id)!.generation > 1 && store.getMessage(later.id)?.deliveredAt !== null;});
    assert.equal(store.multilinePaneQuarantines().length, 0);
    assert.ok(store.auditRows().some(row => row.kind === "mail.delivery_fallback_quarantine_cleared"));
    assert.deepEqual(rows().filter(row => row.submittedBody !== undefined).map(row => row.submittedBody), ["later-exact"]);
  }
});
