import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtempSync, readFileSync, writeFileSync, appendFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {openCoreStore} from "../../core/src/index.ts";
import {codexAdapter, claudeAdapter} from "../../adapters/src/index.ts";
import {HsrDriver} from "../src/index.ts";
import {inspectProcess, sameProcess, type ProcessIdentity} from "../src/psutil.ts";
import {drainUntil, ofKind, sleep} from "./helpers.ts";

const fakeCodex = new URL("../test-agent/fake-codex.mjs", import.meta.url).pathname;

for (const mode of ["idle", "active", "transient-status", "agent-birth", "unowned-agent"] as const) test(`adopted Codex readiness: ${mode}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-adopt-ready-"));
  const store = openCoreStore(join(dir, "core.sqlite3"), {ephemeral: true});
  const {bee} = store.createBee({name: "quiet", agent: "codex", substrate: "hsr", cwd: dir});
  const log = join(dir, "rpc.jsonl");
  const makeDriver = () => new HsrDriver({runtimeIdentity: store.runtimeIdentityHooks(), sessionLogDir: join(dir, "logs"), resolve: () => ({adapter: codexAdapter({cwd: dir}), command: process.execPath, args: [fakeCodex], cwd: dir, env: {FAKE_CODEX_RPC_LOG: log}})});
  const first = makeDriver(); let second: HsrDriver | undefined, third: HsrDriver | undefined;
  try {
    first.start(bee.id, 1);
    await drainUntil(first, events => ofKind(events, "booted").length > 0);
    const proc = first.procOf(bee.id, 1)!;
    const statusPath = join(dir, "runners", `${bee.id}.1.status.json`);
    const status = JSON.parse(readFileSync(statusPath, "utf8"));
    const child = inspectProcess(status.agentPid);
    assert.equal(child.kind, "present");
    if (mode === "active") {
      first.deliver(bee.id, 1, 1, "@slow:2000");
      await sleep(80); first.observe();
    }
    const cursor = first.observeRecoveryCursors().at(-1)!.cursor;
    store.recordRuntimeProc(bee.id, 1, {pid: proc.pid, pidStartedAt: proc.pidStartedAt, observationCursor: cursor});
    first.detachAll();
    if (mode === "unowned-agent") {status.agentPid = process.pid; writeFileSync(statusPath, JSON.stringify(status));}
    second = makeDriver();
    assert.equal(second.adopt(bee.id, 1, proc.pid, proc.pidStartedAt, "booting", cursor), true);
    if (mode === "agent-birth") {
      const procs = (second as unknown as {procs: Map<string, {readinessRecovery: {agent: ProcessIdentity}}>}).procs;
      procs.get(bee.id)!.readinessRecovery.agent = {pid: status.agentPid, birth: "wrong", bootId: ""};
    }
    if (mode === "agent-birth" || mode === "unowned-agent") {
      await sleep(200);
      assert.deepEqual(second.observe(), []);
      assert.equal(second.deliver(bee.id, 1, 2, "must stay held").accepted, false);
      assert.equal(store.runtimeProcessIdentity(bee.id, 1).kind, "bound");
      assert.equal(store.currentRuntime(bee.id)!.state, "booting");
    } else {
      if (mode === "active") {
        await sleep(200);
        assert.deepEqual(second.observe(), []);
        assert.equal(second.deliver(bee.id, 1, 2, "must wait for idle").accepted, false);
      }
      const observed = await drainUntil(second, events => ofKind(events, "booted").length > 0);
      assert.equal(ofKind(observed, "booted")[0]!.synthetic, false);
      assert.equal(ofKind(observed, "turn_ended").length, 1);
      assert.ok(proc.processIdentity && sameProcess(proc.processIdentity, inspectProcess(proc.pid)));
      assert.ok(child.kind === "present" && sameProcess(child, inspectProcess(status.agentPid)));
      second.detachAll();
      third = makeDriver();
      assert.equal(third.adopt(bee.id, 1, proc.pid, proc.pidStartedAt, "booting", cursor), true);
      if (mode === "transient-status") {
        const contents = readFileSync(statusPath, "utf8");
        writeFileSync(statusPath, "{");
        await sleep(200);
        assert.deepEqual(third.observe(), []);
        writeFileSync(statusPath, contents);
      }
      await drainUntil(third, events => ofKind(events, "booted").length > 0);
    }
    const requests = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(requests.filter(row => row.method === "thread/start").length, 1);
    assert.equal(store.auditTail(0, 1000).filter(row => row.kind === "runtime.readiness_recovery_claimed").length, 0);
  } finally {third?.detachAll(); second?.detachAll(); first.disposeAll(); store.close(); rmSync(dir, {recursive: true, force: true});}
});

test("Claude adopted readiness waits for the complete journal before deriving idle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-claude-tail-"));
  const store = openCoreStore(join(dir, "core.sqlite3"), {ephemeral: true});
  const {bee} = store.createBee({name: "quiet", agent: "claude", substrate: "hsr", cwd: dir});
  const makeDriver = () => new HsrDriver({runtimeIdentity: store.runtimeIdentityHooks(), sessionLogDir: join(dir, "logs"), resolve: () => ({adapter: claudeAdapter, command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: dir})});
  const first = makeDriver(); let second: HsrDriver | undefined;
  try {
    first.start(bee.id, 1);
    await drainUntil(first, events => ofKind(events, "booted").length > 0);
    const proc = first.procOf(bee.id, 1)!;
    first.detachAll();
    store.recordRuntimeProc(bee.id, 1, {pid: proc.pid, pidStartedAt: proc.pidStartedAt, observationCursor: 0});
    const path = first.observationLogPath(bee.id, 1);
    appendFileSync(path, '{"type":"system","subtype":"thinking_tokens"}\n'.repeat(120000) + '{"type":"assistant","message":{"content":[]}}\n');
    second = makeDriver();
    assert.equal(second.adopt(bee.id, 1, proc.pid, proc.pidStartedAt, "booting", 0), true);
    await sleep(100);
    assert.deepEqual(second.observe(), []);
    await sleep(1100);
    assert.deepEqual(second.observe(), []);
    assert.equal(second.deliver(bee.id, 1, 1, "must wait").accepted, false);
    appendFileSync(path, '{"type":"result","subtype":"success","result":"finished"}\n');
    const events = await drainUntil(second, events => ofKind(events, "booted").length > 0);
    assert.equal(ofKind(events, "booted")[0]!.synthetic, true);
    assert.equal(ofKind(events, "turn_ended").length, 1);
  } finally {second?.detachAll(); first.disposeAll(); store.close(); rmSync(dir, {recursive: true, force: true});}
});
