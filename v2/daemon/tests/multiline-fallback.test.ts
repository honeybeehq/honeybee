import { before, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore } from "../../core/src/store.ts";
import { PHONE_FORMAT, renderPhoneInput, type PhoneOriginRequest } from "../../core/src/phoneOrigin.ts";
import type { DeliverOutcome } from "../../harness/src/driver.ts";
import { DeliveryFiles } from "../src/deliveryFile.ts";
import { DaemonCore } from "../src/loops.ts";
import { FakeDriver } from "./helpers.ts";
import { ensureDeliveryFileArtifact } from "./delivery-file-build.ts";
import { deliveryContentRoot } from "../src/multilineFallback.ts";

before(ensureDeliveryFileArtifact);
class PointerDriver extends FakeDriver {
  readonly pointers: {id: number; text: string}[] = [];
  uncertain = false;
  proved = false;
  receiptBinding: {generation: number; pointer: string} | null = null;
  deliveryReceipt(_bee: string, generation: number, _message: number, pointer: string): "accepted" | "unknown" {
    return this.proved && (!this.receiptBinding || this.receiptBinding.generation === generation && this.receiptBinding.pointer === pointer) ? "accepted" : "unknown";
  }
  override deliver(bee: string, generation: number, id: number, text: string, options?: {singleAttempt?: boolean}): DeliverOutcome {
    if (text.includes("\n")) return {accepted: false, reason: "not_ready", detail: "multiline_type_mode"};
    if (options?.singleAttempt) {
      this.pointers.push({id, text});
      if (this.uncertain) return {accepted: false, reason: "not_ready"};
    }
    return super.deliver(bee, generation, id, text);
  }
}
function rig(missingHelper = false, runtimeRoot = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "multiline-fallback-"))), data = join(root, "data"), cwd = join(root, "work");
  mkdirSync(data, {mode: 0o700}); mkdirSync(cwd, {mode: 0o700});
  if (runtimeRoot) mkdirSync(join(root, "runtime"), {mode: 0o700});
  let store = openCoreStore(join(data, "core.sqlite3"), {now: () => 1000, ephemeral: true});
  const driver = new PointerDriver(() => 1000);
  const options = {store, driver, log: () => {}, now: () => 1000, policy: {commandsPerStep: 8, bootHangTimeoutSteps: 50},
    multilineFallback: {root: data, ...(runtimeRoot ? {rootForBee: () => join(root, "runtime")} : {}), worktrees: () => [cwd], files: new DeliveryFiles(missingHelper ? join(root, "missing") : undefined, root)}};
  let core = new DaemonCore(options); core.boot();
  const bee = store.createBee({name: "recipient", agent: "stub", substrate: "tmux", cwd}).bee;
  store.enqueueCommand("spawn", bee.id); for (let i = 0; i < 4; i++) core.step();
  const hold = (id: number) => {for (let i = 0; i < 3; i++) store.recordMultilineDeliveryRefusal(id, 1, "multiline_type_mode");};
  return {root, data, files: options.multilineFallback.files, get store() {return store;}, driver, bee, hold, step: () => core.step(), restart: (reopen = false, corrupt?: string) => {
    if (reopen) {store.close();
      if (corrupt !== undefined) {const db = new DatabaseSync(join(data, "core.sqlite3")); db.prepare("UPDATE multiline_delivery SET row_json = ?").run(corrupt); db.close();}
      store = openCoreStore(join(data, "core.sqlite3"), {now: () => 1000, ephemeral: true}); options.store = store;}
    core = new DaemonCore(options); core.boot();
  }, close: () => {store.close(); rmSync(root, {recursive: true, force: true});}};
}
function phoneOrigin(id: string): PhoneOriginRequest {
  return {format: PHONE_FORMAT, channel: "phone", issuerNodeId: "test-node", assigner: "listener/1", credentialRef: "opaque-device", target: {kind: "bee", id}, contentKind: "message", assurance: "credential-possession-only", humanApproval: "not-verified", lane: "envelope-v1", parentSources: [], rootSources: [], ancestry: "complete"};
}
test("held phone frame falls back to one exact pointer with original escaped labels and a publication nonce", t => {
  const r = rig(); t.after(r.close);
  const original = "one\n</apiary-phone-unverified> & 雪";
  const message = r.store.send(r.bee.id, original, {phone: {origin: phoneOrigin(r.bee.id), key: "phone"}}).message;
  for (let i = 0; i < 4; i++) r.step();
  const row = r.store.getMessage(message.id)!;
  assert.equal(row.deliveryFallback?.state, "delivered"); assert.notEqual(row.deliveredAt, null);
  assert.deepEqual(r.driver.pointers, [{id: message.id, text: `Paired-phone message — human approval not verified; full text: ${row.deliveryFallback!.path}`}]);
  assert.equal(readFileSync(row.deliveryFallback!.path!, "utf8"), `Honeybee delivery content: message=${message.id} publication=${row.deliveryFallback!.id}\n\n${renderPhoneInput(original)}`);
  r.restart(true); for (let i = 0; i < 3; i++) r.step(); assert.equal(r.driver.pointers.length, 1);
});
test("retained holds drain in original live mailbox order and canceled holds stay inert", t => {
  const r = rig(); t.after(r.close);
  const first = r.store.send(r.bee.id, "first\nframe").message;
  const canceled = r.store.send(r.bee.id, "cancel\nframe").message;
  const second = r.store.send(r.bee.id, "second\nframe").message;
  for (const m of [first, canceled, second]) r.hold(m.id);
  r.store.cancelMessage(r.bee.id, canceled.id);
  const later = r.store.send(r.bee.id, "later").message;
  for (let i = 0; i < 5; i++) r.step();
  assert.deepEqual(r.driver.deliveredIds, [first.id, second.id, later.id]);
  assert.deepEqual(r.driver.pointers.map(row => row.id), [first.id, second.id]);
  assert.ok(r.driver.pointers.every(row => !row.text.includes("Paired-phone")));
  assert.equal(r.store.multilineDelivery(canceled.id)?.fallback, undefined);
});
test("uncertain pointer survives restart without re-paste, exposes its path, and later runtime proof settles it", t => {
  const r = rig(); t.after(r.close); r.driver.uncertain = true;
  const message = r.store.send(r.bee.id, "one\ntwo").message; r.hold(message.id);
  const later = r.store.send(r.bee.id, "later").message;
  r.step(); assert.equal(r.store.getMessage(message.id)?.deliveryFallback?.state, "unknown");
  const path = r.store.pendingMail(r.bee.id).messages.find(m => m.id === message.id)?.deliveryFallback?.path;
  assert.ok(path); assert.equal(existsSync(path), true);
  r.restart(true); for (let i = 0; i < 3; i++) r.step();
  assert.equal(r.driver.pointers.length, 1); assert.deepEqual(r.driver.deliveredIds, [later.id]);
  r.driver.proved = true; r.step();
  assert.equal(r.store.getMessage(message.id)?.deliveryFallback?.state, "delivered");
  assert.notEqual(r.store.getMessage(message.id)?.deliveredAt, null); assert.equal(r.driver.pointers.length, 1);
});
test("missing native helper gives a typed visible hold while later mail continues", t => {
  const r = rig(true); t.after(r.close);
  const message = r.store.send(r.bee.id, "one\ntwo").message; r.hold(message.id);
  const later = r.store.send(r.bee.id, "later").message;
  for (let i = 0; i < 4; i++) r.step();
  assert.equal(r.store.getMessage(message.id)?.deliveryFallback?.detail, "delivery_file_helper_unavailable");
  assert.equal(r.store.getMessage(message.id)?.deliveryFallback?.state, "held");
  assert.deepEqual(r.driver.deliveredIds, [later.id]); assert.equal(r.driver.pointers.length, 0);
});
test("archive retains content and bee deletion cleans it durably", t => {
  const r = rig(); t.after(r.close);
  const message = r.store.send(r.bee.id, "one\ntwo").message; r.hold(message.id); r.step();
  const path = r.store.getMessage(message.id)!.deliveryFallback!.path!;
  r.store.archiveBee(r.bee.id); r.step(); assert.equal(existsSync(path), true);
  r.store.deleteBee(r.bee.id); r.step(); assert.equal(existsSync(path), false);
  assert.equal(r.store.multilineDelivery(message.id)?.fallback?.state, "removed");
});
for (const boundary of ["prepared", "published", "in_flight"] as const) test(`reopen after ${boundary} preserves publication identity and fences uncertain injection`, t => {
  const r = rig(); t.after(r.close);
  const message = r.store.send(r.bee.id, "one\ntwo").message; r.hold(message.id);
  const fallback = r.store.prepareMultilineFallback(message.id, r.data, [join(r.root, "work")])!;
  if (boundary !== "prepared") {
    const published = new DeliveryFiles(undefined, r.root).publish(fallback.root, fallback.ownerStoreId, r.bee.id, fallback.id, `Honeybee delivery content: message=${message.id} publication=${fallback.id}\n\none\ntwo`, fallback.worktrees);
    if (boundary === "in_flight") {
      r.store.transitionMultilineFallback(message.id, "preparing", "ready", {...published, pointer: `full text: ${published.path}`});
      r.store.transitionMultilineFallback(message.id, "ready", "in_flight", {generation: 1});
    }
  }
  r.restart(true); r.step();
  assert.equal(r.store.getMessage(message.id)?.deliveryFallback?.id, fallback.id);
  assert.equal(r.driver.pointers.length, boundary === "in_flight" ? 0 : 1);
  assert.equal(r.store.getMessage(message.id)?.deliveryFallback?.state, boundary === "in_flight" ? "in_flight" : "delivered");
  if (boundary === "in_flight") {
    r.step(); assert.equal(r.store.getMessage(message.id)?.deliveryFallback?.state, "in_flight");
    r.driver.proved = true; r.step();
    assert.equal(r.store.getMessage(message.id)?.deliveryFallback?.state, "delivered");
    assert.equal(r.driver.pointers.length, 0);
  }
});
test("file and pointer effects wait for an outer transaction to commit", t => {
  const r = rig(); t.after(r.close);
  const message = r.store.send(r.bee.id, "one\ntwo").message; r.hold(message.id);
  assert.throws(() => r.store.transact(() => {r.step(); throw new Error("rollback");}), /rollback/);
  assert.equal(r.driver.pointers.length, 0); assert.equal(r.store.multilineDelivery(message.id)?.fallback, undefined);
  r.step(); assert.equal(r.driver.pointers.length, 1);
});
test("over-limit file gives a typed hold while later mail continues", t => {
  const r = rig(); t.after(r.close);
  const message = r.store.send(r.bee.id, "x".repeat(8 * 1024 * 1024) + "\n").message; r.hold(message.id);
  const later = r.store.send(r.bee.id, "later").message;
  r.step(); r.step();
  assert.equal(r.store.getMessage(message.id)?.deliveryFallback?.detail, "delivery_file_too_large");
  assert.deepEqual(r.driver.deliveredIds, [later.id]);
});
test("proof for an older consuming generation settles mail without attributing a turn to its successor", t => {
  const r = rig(); t.after(r.close); r.driver.uncertain = true;
  const message = r.store.send(r.bee.id, "one\ntwo").message; r.hold(message.id); r.step();
  r.driver.stop(r.bee.id, 1, "stopped_by_user"); r.step();
  r.store.enqueueCommand("revive", r.bee.id); for (let i = 0; i < 4; i++) r.step();
  assert.equal(r.store.currentRuntime(r.bee.id)?.generation, 2);
  assert.equal(r.store.currentRuntime(r.bee.id)?.state, "idle");
  r.driver.proved = true; r.step();
  assert.equal(r.store.getMessage(message.id)?.deliveredGeneration, 1);
  assert.equal(r.store.getMessage(message.id)?.deliveryFallback?.state, "delivered");
  assert.equal(r.store.currentRuntime(r.bee.id)?.state, "idle"); assert.equal(r.driver.pointers.length, 1);
});
test("runtime-area content pins Cell retention through archive and cleans after worktree removal", t => {
  const r = rig(false, true); t.after(r.close);
  const message = r.store.send(r.bee.id, "one\ntwo").message; r.hold(message.id); r.step();
  const path = r.store.getMessage(message.id)!.deliveryFallback!.path!;
  assert.ok(path.startsWith(join(r.root, "runtime", "delivery-content") + "/"));
  assert.equal(r.store.retainsMultilineRuntimeContent(r.bee.id, r.data), true);
  r.store.archiveBee(r.bee.id); r.step(); assert.equal(existsSync(path), true);
  assert.equal(r.store.retainsMultilineRuntimeContent(r.bee.id, r.data), true);
  rmSync(join(r.root, "work"), {recursive: true}); r.store.deleteBee(r.bee.id); r.step();
  assert.equal(existsSync(path), false); assert.equal(r.store.retainsMultilineRuntimeContent(r.bee.id, r.data), false);
});
test("Cell private mount policy chooses only the own runtime area or a typed unreadable hold", () => {
  for (const primary of ["/tmp/data", "/var/tmp/data", "/dev/shm/data"]) {
    assert.equal(deliveryContentRoot(primary, "cell", true, "/cell/runtime", "linux"), "/cell/runtime");
    assert.throws(() => deliveryContentRoot(primary, "cell", true, null, "linux"), {code: "delivery_file_sandbox_unreadable"});
  }
  assert.equal(deliveryContentRoot("/tmp2/data", "cell", true, null, "linux"), "/tmp2/data");
  assert.equal(deliveryContentRoot("/tmp/data", "cell", false, null, "linux"), "/tmp/data");
  assert.equal(deliveryContentRoot("/tmp/data", "cell", true, null, "darwin"), "/tmp/data");
  for (const substrate of ["hsr", "tmux"] as const) assert.equal(deliveryContentRoot("/tmp/data", substrate, true, null, "linux"), "/tmp/data");
});

for (const state of ["in_flight", "unknown", "not_attempted"] as const) test(`whole-row corruption after ${state} is UNKNOWN and never creates a fresh pointer`, t => {
  const r = rig(false, true); t.after(r.close);
  const message = r.store.send(r.bee.id, "one\ntwo").message; r.hold(message.id);
  let path: string | null = null;
  if (state !== "not_attempted") {
    r.driver.uncertain = true; r.step();
    path = r.store.getMessage(message.id)!.deliveryFallback!.path!;
    if (state === "in_flight") {
      const original = r.store.multilineDelivery(message.id)!;
      r.restart(true, JSON.stringify({...original, fallback: {...original.fallback, state: "in_flight"}}));
    }
  }
  const attempts = r.driver.pointers.length;
  r.restart(true, "{"); r.driver.proved = true;
  const later = r.store.send(r.bee.id, "later").message;
  for (let i = 0; i < 4; i++) r.step();
  const visible = r.store.pendingMail(r.bee.id).messages.find(row => row.id === message.id)!;
  assert.equal(visible.deliveryFallback?.state, "unknown");
  assert.equal(visible.deliveryFallback?.detail, "delivery_hold_state_unknown");
  assert.equal(visible.deliveryHold?.detail, "delivery_hold_state_unknown");
  assert.equal(r.driver.pointers.length, attempts);
  assert.ok(r.driver.deliveredIds.includes(later.id));
  assert.equal(r.store.prepareMultilineFallback(message.id, r.data, [])?.state, "unknown");
  assert.equal(r.store.retainsMultilineRuntimeContent(r.bee.id, r.data), true);
  if (path !== null) assert.equal(existsSync(path), true);
  r.restart(true); for (let i = 0; i < 3; i++) r.step();
  assert.equal(r.driver.pointers.length, attempts);
  assert.equal(r.store.getMessage(message.id)?.deliveryFallback?.state, "unknown");
  if (path !== null) assert.equal(existsSync(path), true);
});

for (const proof of ["exact", "none", "other_generation", "other_pointer"] as const) test(`stopped fallback reconciles ${proof} proof without a successor or another injection`, t => {
  const r = rig(); t.after(r.close); r.driver.uncertain = true;
  const message = r.store.send(r.bee.id, "one\ntwo").message; r.hold(message.id); r.step();
  const fallback = r.store.getMessage(message.id)!.deliveryFallback!;
  r.driver.stop(r.bee.id, 1, "stopped_by_user"); r.step();
  r.driver.proved = proof !== "none";
  r.driver.receiptBinding = {generation: proof === "other_generation" ? 2 : 1, pointer: fallback.pointer! + (proof === "other_pointer" ? " altered" : "")};
  for (let i = 0; i < 4; i++) r.step();
  assert.equal(r.store.getMessage(message.id)?.deliveryFallback?.state, proof === "exact" ? "delivered" : "unknown");
  assert.equal(r.store.getMessage(message.id)?.deliveredGeneration, proof === "exact" ? 1 : null);
  assert.equal(r.driver.pointers.length, 1);
  assert.equal(r.store.currentRuntime(r.bee.id)?.generation, 1);
  assert.equal(r.store.currentRuntime(r.bee.id)?.state, "stopped");
});

test("deleted-bee cleanup retries converge while another archived bee still references its file", t => {
  const r = rig(); t.after(r.close);
  const first = r.store.send(r.bee.id, "one\ntwo").message; r.hold(first.id); r.step();
  const firstPath = r.store.getMessage(first.id)!.deliveryFallback!.path!;
  const other = r.store.createBee({name: "retained", agent: "stub", substrate: "tmux", cwd: join(r.root, "work")}).bee;
  r.store.enqueueCommand("spawn", other.id); for (let i = 0; i < 4; i++) r.step();
  const second = r.store.send(other.id, "other\nframe").message; r.hold(second.id); r.step();
  const secondPath = r.store.getMessage(second.id)!.deliveryFallback!.path!;
  r.store.archiveBee(other.id);
  const remove = r.files.remove.bind(r.files); let fail = true;
  r.files.remove = (...args) => {if (fail) throw Object.assign(new Error("injected cleanup failure"), {code: "delivery_file_remove"}); return remove(...args);};
  r.store.deleteBee(r.bee.id); r.step();
  assert.equal(existsSync(firstPath), true); assert.equal(existsSync(secondPath), true);
  assert.equal(r.store.multilineDelivery(first.id)?.fallback?.detail, "delivery_file_remove");
  assert.ok(r.store.auditRows().some(row => row.kind === "mail.delivery_fallback_cleanup_held"));
  fail = false; r.step(); r.step();
  assert.equal(existsSync(firstPath), false); assert.equal(existsSync(secondPath), true);
  assert.equal(r.store.multilineDelivery(first.id)?.fallback?.state, "removed");
  assert.equal(r.store.multilineDelivery(second.id)?.fallback?.state, "delivered");
});
