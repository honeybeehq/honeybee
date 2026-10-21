import { inspectProcess } from "../src/psutil.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, statSync, readFileSync, chmodSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { HsrDriver } from "../src/driver.ts";
import { BRIDGE_ENV } from "../src/externalBridge.ts";
import { stubAdapter } from "../../adapters/src/index.ts";
import { externalExecAdapter } from "../../adapters/src/externalExec.ts";
import { sha256, externalIdentity } from "../../core/src/externalExec.ts";
import { externalFixture, externalReceipt } from "../../core/tests/fixtures/externalExec.ts";
import { drainUntil } from "./helpers.ts";

test("external stop uses the owner control lane and waits for validated terminal capture", async () => {
  const base = join(process.cwd(), ".local", "external-exec-tests");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(base, "host-"));
  const short = `/proc/self/cwd/.local/external-exec-tests/${basename(root)}`;
  const binding = externalFixture();
  const started = { schema: "honeybee.external.observation.v1", event: { schema: "urbench.bridge.event.v1", type: "started", seq: 1, attemptId: binding.dispatch.attemptId, fencingTokenSha256: sha256(binding.dispatch.fencingToken), data: { status: "running" } } };
  const terminal = { ...started, event: { ...started.event, type: "terminal", seq: 2, data: { ...externalReceipt(binding), status: "stopped" } } };
  const script = `const r = require('node:readline').createInterface({ input: process.stdin });
process.on('SIGTERM', () => process.exit(99));
console.log(${JSON.stringify(JSON.stringify(started))});
r.on('line', line => { if (JSON.parse(line).operation === 'stop') {
console.log(${JSON.stringify(JSON.stringify(terminal))}); r.close(); process.stdin.destroy();
} });`;
  let receipts = 0;
  const driver = new HsrDriver({ sessionLogDir: join(root, "logs"), socketDir: short, isExternal: () => true,
    onExternalReceipt: () => { receipts++; },
    resolve: () => ({ adapter: externalExecAdapter(externalIdentity(binding)), command: process.execPath, args: ["-e", script], cwd: "/", env: { ...BRIDGE_ENV } }) });
  try {
    driver.start("synthetic-external", 1);
    await drainUntil(driver, events => events.some(e => e.kind === "booted"));
    assert.equal(statSync(join(root, "runners", "synthetic-external.1.json")).mode & 0o077, 0);
    assert.equal(driver.stop("synthetic-external", 1, "stopped_by_user").hadProcess, true);
    const events = await drainUntil(driver, events => events.some(e => e.kind === "exited"));
    assert.equal(events.find(e => e.kind === "exited")?.exitCause, "stopped_by_user");
    assert.equal(receipts, 1);
  } finally { driver.disposeAll(); }
});

test("external escalation signals a non-cooperating group and records reconciliation", async () => {
  const base = join(process.cwd(), ".local", "external-exec-tests"); mkdirSync(base, {recursive: true, mode: 0o700});
  const root = mkdtempSync(join(base, "escalation-"));
  const binding = externalFixture();
  const event = {schema: "honeybee.external.observation.v1", event: {schema: "urbench.bridge.event.v1", type: "started", seq: 1, attemptId: binding.dispatch.attemptId, fencingTokenSha256: sha256(binding.dispatch.fencingToken), data: {}}};
  let uncertain = 0;
  const driver = new HsrDriver({sessionLogDir: join(root, "logs"), socketDir: `/proc/self/cwd/.local/external-exec-tests/${basename(root)}`, stopKillGraceMs: 50, isExternal: () => true,
    onExternalError: () => { uncertain++; },
    resolve: () => ({adapter: externalExecAdapter(externalIdentity(binding)), command: process.execPath, args: ["-e", `process.on('SIGTERM',()=>{}); console.log(${JSON.stringify(JSON.stringify(event))}); setInterval(()=>{},1000);`], env: {...BRIDGE_ENV}})});
  try {
    driver.start("uncooperative", 1);
    await drainUntil(driver, events => events.some(e => e.kind === "booted"));
    driver.stop("uncooperative", 1, "stopped_by_user");
    await drainUntil(driver, events => events.some(e => e.kind === "exited"));
    assert.equal(uncertain, 1);
  } finally {driver.disposeAll();}
});

test("private bootstrap never enters runner config or bidirectional transcript", async () => {
  const base = join(process.cwd(), ".local", "external-exec-tests"); mkdirSync(base, {recursive: true, mode: 0o700});
  const root = mkdtempSync(join(base, "private-"));
  const binding = externalFixture();
  const event = {schema: "honeybee.external.observation.v1", event: {schema: "urbench.bridge.event.v1", type: "started", seq: 1, attemptId: binding.dispatch.attemptId, fencingTokenSha256: sha256(binding.dispatch.fencingToken), data: {}}};
  const secret = "private-bootstrap-synthetic-fencing-token";
  const script = `const r=require('node:readline').createInterface({input:process.stdin}); r.once('line',line=>{if(require('node:crypto').createHash('sha256').update(line).digest('hex')!==${JSON.stringify(sha256(secret))}) process.exit(1); console.log(${JSON.stringify(JSON.stringify(event))}); r.close(); process.stdin.destroy();});`;
  const driver = new HsrDriver({sessionLogDir: join(root, "logs"), socketDir: `/proc/self/cwd/.local/external-exec-tests/${basename(root)}`,
    resolve: () => ({adapter: externalExecAdapter(externalIdentity(binding)), privateBootLines: [secret], command: process.execPath, args: ["-e", script], env: {...BRIDGE_ENV}})});
  try {
    mkdirSync(join(root, "runners"), {recursive: true});
    writeFileSync(join(root, "runners", "private-bootstrap.1.json"), "previous", {mode: 0o644});
    driver.start("private-bootstrap", 1);
    const observations = await drainUntil(driver, events => events.some(e => e.kind === "exited"));
    assert.ok(observations.some(e => e.kind === "booted"));
    const cfg = join(root, "runners", "private-bootstrap.1.json");
    assert.equal(statSync(cfg).mode & 0o777, 0o600);
    const stored = JSON.parse(readFileSync(cfg, "utf8"));
    assert.deepEqual(stored.bootLines, []);
    assert.ok(!readFileSync(cfg, "utf8").includes(secret));
    assert.equal(stored.privateBoot, true);
    assert.ok(!readFileSync(driver.sessionLogPath("private-bootstrap"), "utf8").includes(secret));
  } finally {driver.disposeAll();}
});

test("an external owner with no usable adapter can still stop its verified process", async () => {
  const base = join(process.cwd(), ".local", "external-exec-tests"); mkdirSync(base, {recursive: true, mode: 0o700});
  const root = mkdtempSync(join(base, "degraded-stop-"));
  let uncertain = 0;
  const driver = new HsrDriver({sessionLogDir: join(root, "logs"), socketDir: `/proc/self/cwd/.local/external-exec-tests/${basename(root)}`, stopKillGraceMs: 50,
    isExternal: () => true, onExternalError: () => {uncertain++;},
    resolve: () => ({adapter: stubAdapter, command: process.execPath, args: ["-e", `process.on('SIGTERM',()=>{}); console.log(JSON.stringify({event:"ready"})); setInterval(()=>{},1000)`], env: {...BRIDGE_ENV}})});
  try {
    driver.start("degraded-external", 1);
    await drainUntil(driver, events => events.some(e => e.kind === "booted"));
    assert.equal(driver.stop("degraded-external", 1, "stopped_by_user").hadProcess, true);
    await drainUntil(driver, events => events.some(e => e.kind === "exited"));
    assert.ok(uncertain >= 1);
  } finally {driver.disposeAll();}
});

test("external KILL remains armed after the host leader exits with a survivor", async () => {
  const base = join(process.cwd(), ".local", "external-exec-tests"); mkdirSync(base, {recursive: true, mode: 0o700});
  const root = mkdtempSync(join(base, "group-survivor-"));
  const binding = externalFixture();
  const event = {schema: "honeybee.external.observation.v1", event: {schema: "urbench.bridge.event.v1", type: "started", seq: 1, attemptId: binding.dispatch.attemptId, fencingTokenSha256: sha256(binding.dispatch.fencingToken), data: {}}};
  const survivorFile = join(root, "survivor.pid");
  const script = `const cp=require('node:child_process');
const survivor=cp.spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']});
survivor.stdout.once('data',()=>{ require('node:fs').writeFileSync(${JSON.stringify(survivorFile)}, String(survivor.pid)); console.log(${JSON.stringify(JSON.stringify(event))}); });
process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000);`;
  let uncertain = 0;
  const driver = new HsrDriver({sessionLogDir: join(root, "logs"), socketDir: `/proc/self/cwd/.local/external-exec-tests/${basename(root)}`, stopKillGraceMs: 150, isExternal: () => true,
    onExternalError: () => {uncertain++;},
    resolve: () => ({adapter: externalExecAdapter(externalIdentity(binding)), command: process.execPath, args: ["-e", script], env: {...BRIDGE_ENV}})});
  try {
    driver.start("leader-exits", 1);
    await drainUntil(driver, events => events.some(e => e.kind === "booted"));
    const survivor = Number(readFileSync(survivorFile, "utf8"));
    const identity = inspectProcess(survivor);
    assert.equal(identity.kind, "present");
    driver.stop("leader-exits", 1, "stopped_by_user");
    await drainUntil(driver, events => events.some(e => e.kind === "exited"));
    driver.detachAll();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const value = inspectProcess(survivor);
      if (value.kind === "gone" || value.kind === "present" && value.state === "zombie") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const value = inspectProcess(survivor);
    assert.ok(value.kind === "gone" || value.kind === "present" && value.state === "zombie");
    assert.ok(uncertain >= 1);
  } finally {driver.disposeAll();}
});
