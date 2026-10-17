import { before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { spawn } from "node:child_process";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { openCoreStore } from "../../core/src/store.ts";
import { DaemonCore } from "../src/loops.ts";
import { codexAdapter, museAdapter, stubAdapter } from "../../adapters/src/index.ts";
import { HsrDriver } from "../../driver-hsr/src/driver.ts";
import { defaultScratchPaths, sandboxDefaultFor, seatbeltProfile, wrapWithSandbox } from "../../driver-cell/src/sandbox.ts";
import { DeliveryFiles } from "../src/deliveryFile.ts";
import { defaultDataDir } from "../src/config.ts";
import { deliveryContentRoot } from "../src/multilineFallback.ts";
import { ensureDeliveryFileArtifact } from "./delivery-file-build.ts";
import { DELIVERY_READ_SOCKET_NAME, deliveryReadFixtureBase, outsideLinuxPrivateMounts } from "./delivery-file-read-root.ts";

before(ensureDeliveryFileArtifact);
for (const substrate of ["hsr", "cell-sandbox", "satellite-default"] as const) test(`${process.platform === "darwin" ? "Darwin " : ""}OS-level file read outside cwd: ${substrate}; tool-policy read UNVERIFIED (OS-level only)`, {skip: process.platform !== "linux" && process.platform !== "darwin"}, async t => {
  const needsVisibleRoot = process.platform === "linux" && substrate !== "hsr";
  const base = deliveryReadFixtureBase(process.platform, substrate !== "hsr", tmpdir(), process.env.RUNNER_TEMP, process.cwd());
  mkdirSync(base, {recursive: true, mode: 0o700});
  const canonicalBase = realpathSync(base);
  if (needsVisibleRoot) assert.ok(outsideLinuxPrivateMounts(canonicalBase), "Sandboxed Linux delivery read fixture base resolves inside a private mount");
  const root = realpathSync(mkdtempSync(join(canonicalBase, "fr-"))), data = join(root, "data"), work = join(root, "work");
  if (needsVisibleRoot) assert.ok(outsideLinuxPrivateMounts(root), "Sandboxed Linux delivery read fixture root is hidden by a private mount");
  const maxSocketPathBytes = Buffer.byteLength(join(root, "s", DELIVERY_READ_SOCKET_NAME));
  assert.ok(maxSocketPathBytes <= 103, `Delivery read fixture longest socket path is ${maxSocketPathBytes} bytes; maximum is 103`);
  t.diagnostic(`fixture max socket path bytes: ${maxSocketPathBytes}`);
  mkdirSync(data, {mode: 0o700}); mkdirSync(work, {mode: 0o700});
  mkdirSync(join(root, "s"), {mode: 0o700});
  const id = randomUUID(), content = `Honeybee delivery content: publication=${id}\n\nnonce-${randomUUID()}`;
  const row = new DeliveryFiles(undefined, root).publish(data, "owner", "bee", id, content, [work]);
  const fixture = fileURLToPath(new URL("./fixtures/delivery-file-reader.mjs", import.meta.url));
  const sandboxed = substrate !== "hsr";
  if (substrate === "satellite-default") assert.equal(sandboxDefaultFor("satellite"), true);
  const profilePath = join(work, "sandbox.sb");
  const policy = {cellDir: work, writablePaths: [], scratchPaths: []};
  const command = sandboxed ? wrapWithSandbox(policy, process.execPath, [fixture], profilePath) : {command: process.execPath, args: [fixture]};
  if (process.platform === "darwin" && sandboxed) {
    assert.equal(command.command, "sandbox-exec");
    assert.ok("profile" in command && typeof command.profile === "string");
    const scratches = defaultScratchPaths("darwin", null);
    const scratchEntries = new Set(scratches.flatMap(path => {
      try {return [path, realpathSync(path)];} catch {return [path];}
    }).map(path => `  (subpath ${JSON.stringify(path)})`));
    const productionProfile = seatbeltProfile({...policy, scratchPaths: scratches});
    assert.equal(command.profile, productionProfile.split("\n").filter(line => !scratchEntries.has(line)).join("\n"));
    writeFileSync(profilePath, command.profile, {mode: 0o600});
  }
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
  if (sandboxed) assert.ok(["EACCES", "EPERM", "EROFS"].includes(reply.writeDeniedErrno));
  assert.deepEqual(reply, {sha256: row.digest, header: content.split("\n")[0], cwd: work, writeDenied: sandboxed ? true : null, writeDeniedErrno: sandboxed ? reply.writeDeniedErrno : null});
  assert.equal(readFileSync(row.path, "utf8"), content);
  assert.ok(typeof reply.header === "string");
  t.diagnostic(`SCG_READ_RESULT=${JSON.stringify({substrate, expectedDigest: row.digest, observedDigest: reply.sha256, expectedHeaderSha256: createHash("sha256").update(content.split("\n")[0]!).digest("hex"), observedHeaderSha256: createHash("sha256").update(reply.header).digest("hex"), readClass: "read", writeDenied: reply.writeDenied})}`);
  t.diagnostic(substrate === "hsr" ? "write denied: NOT APPLICABLE (unsandboxed by design)" : `write denied: ${substrate}; errno=${reply.writeDeniedErrno}; scratchPaths:[] fixture narrowing; all other SBPL rules byte-for-byte production`);
  for (const harness of ["Claude", "Codex", "Grok", "Kimi", "Muse", "Agy"]) t.diagnostic(`${harness}: tool-policy read UNVERIFIED (OS-level only)`);
});

test("default Darwin dataDir and delivery-content for a /Users home are outside default scratch paths and TMPDIR", t => {
  const home = "/Users/delivery-fixture", userTemp = "/private/var/folders/zz/delivery-fixture/T", runTemp = "/private/var/tmp/g.fixture/t";
  const mockedHome = t.mock.method(os, "homedir", () => home);
  let data: string;
  try {
    syncBuiltinESMExports();
    data = defaultDataDir({});
  } finally {
    mockedHome.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(data, join(home, ".hive", "v2"));
  const root = deliveryContentRoot(data, "cell", true, null, "darwin");
  const ownerBee = createHash("sha256").update(JSON.stringify(["owner", "bee"])).digest("hex");
  const content = join(root, "delivery-content", ownerBee, "00000000-0000-4000-8000-000000000000.txt");
  for (const scratch of [...defaultScratchPaths("darwin", userTemp), ...defaultScratchPaths("darwin", null), runTemp]) {
    for (const path of [data, root, content]) {
      const rel = relative(scratch, path);
      assert.ok(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel), `${path} is inside ${scratch}`);
    }
  }
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
  await wait(() => {core.step(); return store.getMessage(message.id)?.deliveryFallback?.state === "in_flight";});
  const initial = store.getMessage(message.id)!.deliveryFallback!;
  assert.equal(initial.state, "in_flight"); assert.equal(initial.attempts, 1);
  assert.equal(store.countUnknownMultilineHolds(), 0);
  assert.equal(store.auditRows().some(row => row.kind === "mail.delivery_fallback_unknown"), false);
  if (loseAttempt) {
    (driver as unknown as {pointerAttempts: Map<number, unknown>}).pointerAttempts.clear();
    core.boot();
    assert.equal(store.getMessage(message.id)?.deliveryFallback?.state, "unknown");
  }
  await wait(() => {core.step(); return readFileSync(driver.sessionLogPath(bee.id), "utf8").includes("turn/completed");});
  if (!loseAttempt) await wait(() => {core.step(); return store.getMessage(message.id)?.deliveryFallback?.state === "delivered";});
  else for (let i = 0; i < 4; i++) {await new Promise(resolve => setTimeout(resolve, 10)); core.step();}
  assert.equal(store.getMessage(message.id)?.deliveryFallback?.state, loseAttempt ? "unknown" : "delivered");
  assert.equal(driver.deliveryReceipt(bee.id, 1, message.id, initial.pointer!), loseAttempt ? "unknown" : "accepted");
  assert.equal(driver.deliveryReceipt(bee.id, 2, message.id, initial.pointer!), "unknown");
  assert.equal(driver.deliveryReceipt(bee.id, 1, message.id, initial.pointer! + " altered"), "unknown");
  assert.equal(store.getMessage(message.id)?.deliveryFallback?.attempts, 1);
  if (loseAttempt) {
    const later = store.send(bee.id, "later after daemon restart").message;
    await wait(() => {core.step(); return store.getMessage(later.id)?.deliveredAt !== null;});
    assert.equal(store.getMessage(message.id)?.deliveryFallback?.state, "unknown");
    assert.equal(store.countUnknownMultilineHolds(), 1);
    assert.equal(store.currentRuntime(bee.id)?.generation, 1);
    assert.equal(store.multilineDelivery(message.id)?.notice, "state unknown, may have been delivered");
  }
  assert.equal(readFileSync(rpcLog, "utf8").trim().split("\n").filter(line => JSON.parse(line).method === "turn/start").length, loseAttempt ? 2 : 1);
});

for (const harness of ["codex", "muse"] as const) for (const refuse of [false, true]) test(`real ${harness} pointer confirmation ${refuse ? "refusal retries the saved publication" : "stays pending without UNKNOWN notices"}`, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pc-"))), data = join(root, "data"), work = join(root, "work");
  for (const path of [data, work, join(root, "s")]) mkdirSync(path, {mode: 0o700});
  const fixture = fileURLToPath(new URL(`../../driver-hsr/test-agent/fake-${harness}.mjs`, import.meta.url));
  const driver = new HsrDriver({sessionLogDir: join(root, "logs"), socketDir: join(root, "s"), stopKillGraceMs: 100, resolve: () => ({command: process.execPath, args: [fixture, ...(harness === "muse" ? ["serve"] : [])], cwd: work,
    env: {...process.env, ...(refuse ? {FAKE_DELIVERY_REFUSE_ONCE: "1"} : {}), ...(harness === "muse" ? {FAKE_MUSE_NATIVE: "1", MUSE_NO_AUTO_UPDATE: "1"} : {})}, adapter: harness === "codex" ? codexAdapter({cwd: work}) : museAdapter({cwd: work})})});
  const store = openCoreStore(join(data, "core.sqlite3"), {now: () => 1000, ephemeral: true});
  t.after(() => {driver.disposeAll(); store.close(); rmSync(root, {recursive: true, force: true});});
  const core = new DaemonCore({store, driver, now: () => 1000, log: () => {}, policy: {commandsPerStep: 8, idleWindowSteps: null, bootHangTimeoutSteps: 100000}, multilineFallback: {root: data, worktrees: () => [work], files: new DeliveryFiles(undefined, root)}}); core.boot();
  const bee = store.createBee({name: "confirm", agent: "stub", substrate: "hsr", cwd: work}).bee; store.enqueueCommand("spawn", bee.id);
  const wait = async (condition: () => boolean) => {for (let i = 0; i < 500; i++) {if (condition()) return; await new Promise(resolve => setTimeout(resolve, 10));} assert.fail("real adapter confirmation timed out");};
  await wait(() => {core.step(); return store.currentRuntime(bee.id)?.state === "idle";});
  const message = store.send(bee.id, "one\ntwo").message;
  for (let i = 0; i < 3; i++) store.recordMultilineDeliveryRefusal(message.id, 1, "multiline_type_mode");
  core.step();
  const pending = store.getMessage(message.id)!.deliveryFallback!;
  assert.equal(pending.state, "in_flight"); assert.equal(store.countUnknownMultilineHolds(), 0);
  const bytes = readFileSync(pending.path!);
  await wait(() => {core.step(); return store.getMessage(message.id)?.deliveryFallback?.state === "delivered";});
  const delivered = store.getMessage(message.id)!.deliveryFallback!;
  assert.equal(delivered.id, pending.id); assert.equal(delivered.pointer, pending.pointer);
  assert.equal(delivered.attempts, refuse ? 2 : 1); assert.deepEqual(readFileSync(delivered.path!), bytes);
  assert.equal(store.auditRows().filter(row => row.kind === "mail.delivery_fallback_prepared").length, 1);
  assert.equal(store.auditRows().some(row => row.kind === "mail.delivery_fallback_unknown"), false);
  assert.equal(store.multilineDelivery(message.id)?.notice, null);
});

test("SIGKILL after in_flight on a surviving HSR generation becomes UNKNOWN and later mail flows", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bc-"))), data = join(root, "data"), work = join(root, "work"), socketDir = join(root, "s"), logs = join(root, "logs"), db = join(data, "core.sqlite3");
  for (const path of [data, work, socketDir]) mkdirSync(path, {mode: 0o700});
  const modulePath = (path: string) => fileURLToPath(new URL(path, import.meta.url));
  const fixture = modulePath("../../driver-hsr/test-agent/fake-codex.mjs");
  const code = `import {openCoreStore} from ${JSON.stringify(modulePath("../../core/src/store.ts"))};
import {DaemonCore} from ${JSON.stringify(modulePath("../src/loops.ts"))};
import {DeliveryFiles} from ${JSON.stringify(modulePath("../src/deliveryFile.ts"))};
import {HsrDriver} from ${JSON.stringify(modulePath("../../driver-hsr/src/driver.ts"))};
import {codexAdapter} from ${JSON.stringify(modulePath("../../adapters/src/index.ts"))};
const store=openCoreStore(${JSON.stringify(db)}),driver=new HsrDriver({sessionLogDir:${JSON.stringify(logs)},socketDir:${JSON.stringify(socketDir)},resolve:()=>({command:process.execPath,args:[${JSON.stringify(fixture)}],cwd:${JSON.stringify(work)},env:process.env,adapter:codexAdapter({cwd:${JSON.stringify(work)}})})});
const core=new DaemonCore({store,driver,now:Date.now,log:()=>{},policy:{commandsPerStep:8,idleWindowSteps:null,bootHangTimeoutSteps:100000}});core.boot();
const bee=store.createBee({name:"crash",agent:"stub",substrate:"hsr",cwd:${JSON.stringify(work)}}).bee;store.enqueueCommand("spawn",bee.id);
for(let i=0;store.currentRuntime(bee.id)?.state!=="idle";i++){if(i>500)throw Error("boot timeout");core.step();await new Promise(r=>setTimeout(r,10));}
const message=store.send(bee.id,"one\\ntwo").message;for(let i=0;i<3;i++)store.recordMultilineDeliveryRefusal(message.id,1,"multiline_type_mode");
const f=store.prepareMultilineFallback(message.id,${JSON.stringify(data)},[${JSON.stringify(work)}]);const p=new DeliveryFiles(undefined,${JSON.stringify(root)}).publish(f.root,f.ownerStoreId,bee.id,f.id,"saved content",f.worktrees);
store.transitionMultilineFallback(message.id,"preparing","ready",{...p,pointer:"full text: "+p.path});store.transitionMultilineFallback(message.id,"ready","in_flight",{generation:1,attempts:1});
process.stdout.write(JSON.stringify({beeId:bee.id,messageId:message.id,proc:driver.procOf(bee.id,1)})+"\\n");setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"]});
  let driver: HsrDriver | undefined, store: ReturnType<typeof openCoreStore> | undefined;
  t.after(() => {if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); driver?.disposeAll(); store?.close(); rmSync(root, {recursive: true, force: true});});
  const saved = await new Promise<{beeId: string; messageId: number; proc: {pid: number; pidStartedAt: number; observationCursor: number}}>((resolve, reject) => {
    let out = "", error = "";
    const timer = setTimeout(() => reject(new Error("crash fixture timed out: " + error)), 10000);
    child.stderr.on("data", bytes => error += String(bytes));
    child.stdout.on("data", bytes => {out += String(bytes); try {const row = JSON.parse(out.trim()); clearTimeout(timer); resolve(row);} catch {}});
    child.once("exit", status => {clearTimeout(timer); if (!out.trim()) reject(new Error(`crash fixture exit ${status}: ${error}`));});
  });
  const exited = new Promise(resolve => child.once("exit", (_code, signal) => resolve(signal)));
  child.kill("SIGKILL"); assert.equal(await exited, "SIGKILL");
  driver = new HsrDriver({sessionLogDir: logs, socketDir, stopKillGraceMs: 100, resolve: () => ({command: process.execPath, args: [fixture], cwd: work, env: process.env as Record<string, string>, adapter: codexAdapter({cwd: work})})});
  assert.equal(driver.adopt(saved.beeId, 1, saved.proc.pid, saved.proc.pidStartedAt, "idle", saved.proc.observationCursor), true);
  store = openCoreStore(db);
  const core = new DaemonCore({store, driver, now: Date.now, log: () => {}, policy: {commandsPerStep: 8, idleWindowSteps: null, bootHangTimeoutSteps: 100000}, multilineFallback: {root: data, worktrees: () => [work], files: new DeliveryFiles(undefined, root)}});
  assert.equal(core.boot().adopted, 1);
  assert.equal(store.getMessage(saved.messageId)?.deliveryFallback?.state, "unknown");
  const later = store.send(saved.beeId, "later").message;
  for (let i = 0; i < 500 && store.getMessage(later.id)?.deliveredAt === null; i++) {core.step(); await new Promise(resolve => setTimeout(resolve, 10));}
  assert.notEqual(store.getMessage(later.id)?.deliveredAt, null);
  assert.equal(store.currentRuntime(saved.beeId)?.generation, 1);
  assert.equal(store.countUnknownMultilineHolds(), 1);
  assert.equal(store.getMessage(saved.messageId)?.deliveryFallback?.attempts, 1);
  assert.equal(store.multilineDelivery(saved.messageId)?.notice, "state unknown, may have been delivered");
});
