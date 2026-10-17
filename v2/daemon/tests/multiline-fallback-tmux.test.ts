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
