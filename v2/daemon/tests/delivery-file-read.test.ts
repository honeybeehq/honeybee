import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openCoreStore } from "../../core/src/store.ts";
import { DaemonCore } from "../src/loops.ts";
import { codexAdapter, stubAdapter } from "../../adapters/src/index.ts";
import { HsrDriver } from "../../driver-hsr/src/driver.ts";
import { sandboxDefaultFor, wrapWithSandbox } from "../../driver-cell/src/sandbox.ts";
import { DeliveryFiles } from "../src/deliveryFile.ts";
import { ensureDeliveryFileArtifact } from "./delivery-file-build.ts";

before(ensureDeliveryFileArtifact);
for (const substrate of ["hsr", "cell-sandbox", "satellite-default"] as const) test(`OS-level file read outside cwd: ${substrate}; tool-policy read UNVERIFIED (OS-level only)`, {skip: process.platform !== "linux"}, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fr-"))), data = join(root, "data"), work = join(root, "work");
  mkdirSync(data, {mode: 0o700}); mkdirSync(work, {mode: 0o700});
  mkdirSync(join(root, "s"), {mode: 0o700});
  const id = randomUUID(), content = `Honeybee delivery content: publication=${id}\n\nnonce-${randomUUID()}`;
  const row = new DeliveryFiles(undefined, root).publish(data, "owner", "bee", id, content, [work]);
  const fixture = fileURLToPath(new URL("./fixtures/delivery-file-reader.mjs", import.meta.url));
  const sandboxed = substrate !== "hsr";
  if (substrate === "satellite-default") assert.equal(sandboxDefaultFor("satellite"), true);
  const command = sandboxed ? wrapWithSandbox({cellDir: work, writablePaths: [], scratchPaths: []}, process.execPath, [fixture], join(work, "sandbox.sb")) : {command: process.execPath, args: [fixture]};
  const driver = new HsrDriver({sessionLogDir: join(root, "logs"), stopKillGraceMs: 100, socketDir: join(root, "s"), resolve: () => ({...command, cwd: work, env: {...process.env, FILE_READ_ROOT: data, ...(sandboxed ? {FILE_EXPECT_READONLY: "1"} : {})}, adapter: stubAdapter})});
  t.after(() => {driver.disposeAll(); rmSync(root, {recursive: true, force: true});});
  driver.start("bee", 1);
  let accepted = false, ended = false;
  const observed: unknown[] = [];
  for (let attempt = 0; attempt < 500; attempt++) {
    const events = driver.observe();
    observed.push(...events);
    if (accepted) ended ||= readFileSync(driver.sessionLogPath("bee"), "utf8").trim().split("\n").some(line => {const value = JSON.parse(line); return value.event === "turn_ended" && value.messageId === 1;});
    if (!accepted && events.some(event => event.kind === "booted") || !accepted && driver.hasProcess("bee", 1)) accepted = driver.deliver("bee", 1, 1, `full text: ${row.path}`, {singleAttempt: true}).accepted;
    if (accepted && ended) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(accepted, true, JSON.stringify(observed)); assert.equal(ended, true, readFileSync(driver.sessionLogPath("bee"), "utf8"));
  assert.equal(driver.deliveryReceipt("bee", 1, 1, `full text: ${row.path}`), "accepted");
  assert.equal(driver.deliveryReceipt("bee", 1, 1, "another body"), "unknown");
  assert.equal(driver.deliveryReceipt("another-bee", 1, 1, `full text: ${row.path}`), "unknown");
  assert.equal(driver.deliveryReceipt("bee", 2, 1, `full text: ${row.path}`), "unknown");
  const replies = readFileSync(driver.sessionLogPath("bee"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const reply = JSON.parse(replies.find(value => value.event === "text").text);
  assert.deepEqual(reply, {sha256: row.digest, header: content.split("\n")[0], cwd: work, writeDenied: sandboxed ? true : null});
  assert.equal(readFileSync(row.path, "utf8"), content);
});

for (const loseAttempt of [false, true]) test(`real HSR asynchronous confirmation ${loseAttempt ? "with lost outbound-attempt state stays UNKNOWN" : "settles from exact passive proof"}`, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hc-"))), data = join(root, "data"), work = join(root, "work");
  for (const path of [data, work, join(root, "s")]) mkdirSync(path, {mode: 0o700});
  const fixture = fileURLToPath(new URL("../../driver-hsr/test-agent/fake-codex.mjs", import.meta.url)), rpcLog = join(root, "rpc.jsonl");
  const driver = new HsrDriver({sessionLogDir: join(root, "logs"), socketDir: join(root, "s"), stopKillGraceMs: 100, resolve: () => ({command: process.execPath, args: [fixture], cwd: work, env: {...process.env, FAKE_CODEX_RPC_LOG: rpcLog}, adapter: codexAdapter({cwd: work})})});
  const store = openCoreStore(join(data, "core.sqlite3"), {now: () => 1000, ephemeral: true});
  t.after(() => {driver.disposeAll(); store.close(); rmSync(root, {recursive: true, force: true});});
  const core = new DaemonCore({store, driver, now: () => 1000, log: () => {}, policy: {commandsPerStep: 8, idleWindowSteps: null, bootHangTimeoutSteps: 100000}, multilineFallback: {root: data, worktrees: () => [work], files: new DeliveryFiles(undefined, root)}}); core.boot();
  const bee = store.createBee({name: "confirm", agent: "stub", substrate: "hsr", cwd: work}).bee; store.enqueueCommand("spawn", bee.id);
  const wait = async (condition: () => boolean) => {for (let i = 0; i < 500; i++) {if (condition()) return; await new Promise(resolve => setTimeout(resolve, 10));} assert.fail("HSR confirm timed out");};
  await wait(() => {core.step(); return store.currentRuntime(bee.id)?.state === "idle";});
  const message = store.send(bee.id, "one\ntwo").message;
  for (let i = 0; i < 3; i++) store.recordMultilineDeliveryRefusal(message.id, 1, "multiline_type_mode");
  await wait(() => {core.step(); return store.getMessage(message.id)?.deliveryFallback?.state === "unknown";});
  const initial = store.getMessage(message.id)!.deliveryFallback!;
  assert.equal(initial.state, "unknown"); assert.equal(initial.attempts, 1);
  if (loseAttempt) (driver as unknown as {pointerAttempts: Map<number, unknown>}).pointerAttempts.clear();
  await wait(() => {core.step(); return readFileSync(driver.sessionLogPath(bee.id), "utf8").includes("turn/completed");});
  if (!loseAttempt) await wait(() => {core.step(); return store.getMessage(message.id)?.deliveryFallback?.state === "delivered";});
  else for (let i = 0; i < 4; i++) {await new Promise(resolve => setTimeout(resolve, 10)); core.step();}
  assert.equal(store.getMessage(message.id)?.deliveryFallback?.state, loseAttempt ? "unknown" : "delivered");
  assert.equal(driver.deliveryReceipt(bee.id, 1, message.id, initial.pointer!), loseAttempt ? "unknown" : "accepted");
  assert.equal(driver.deliveryReceipt(bee.id, 2, message.id, initial.pointer!), "unknown");
  assert.equal(driver.deliveryReceipt(bee.id, 1, message.id, initial.pointer! + " altered"), "unknown");
  assert.equal(store.getMessage(message.id)?.deliveryFallback?.attempts, 1);
  assert.equal(readFileSync(rpcLog, "utf8").trim().split("\n").filter(line => JSON.parse(line).method === "turn/start").length, 1);
});
