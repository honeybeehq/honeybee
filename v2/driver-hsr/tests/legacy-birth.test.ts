import {inspectProcess, exactProcessBirth} from "../../harness/src/processIdentity.ts";
import assert from "node:assert/strict";
import {test} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {join} from "node:path";
import {harness, makeBee} from "../../core/tests/helpers.ts";
import {makeRig, drainUntil, sleep, AGENT_PATH} from "./helpers.ts";
import {HsrDriver} from "../src/driver.ts";
import {stubAdapter} from "../../adapters/src/index.ts";

for (const executionMatch of [false, true]) test(`legacy HSR birth requires authenticated CAS even with executionHost match=${executionMatch}`, {timeout: 15000}, async () => {
  const h = harness(), store = h.open(), rig = makeRig({runtimeIdentity: store.runtimeIdentityHooks()});
  let successor: HsrDriver | null = null;
  try {
    const {bee} = makeBee(store), generation = store.currentRuntime(bee.id)!.generation;
    rig.driver.start(bee.id, generation);
    await drainUntil(rig.driver, rows => rows.some(row => row.kind === "booted"));
    const proc = rig.driver.procOf(bee.id, generation)!;
    store.recordRuntimeProc(bee.id, generation, proc);
    assert.equal(store.runtimeProcessIdentity(bee.id, generation).kind, "bound");
    (store as unknown as {db: DatabaseSync}).db.prepare("UPDATE runtimes SET process_identity=NULL WHERE bee_id=?").run(bee.id);
    rig.driver.detachAll();
    const execution = {intentId: "legacy-test", beeId: bee.id, runtimeGeneration: generation, claim: {}} as import("../../core/src/executionStart.ts").ExecutionStart;
    if (executionMatch) {
      const paths = (rig.driver as unknown as {runnerPaths(id: string, generation: number): {status: string}}).runnerPaths(bee.id, generation);
      const status = JSON.parse(readFileSync(paths.status, "utf8"));
      writeFileSync(paths.status, JSON.stringify({...status, hostBirth: exactProcessBirth(proc.pid), executionIntentId: execution.intentId, executionDigest: canonicalDigest(execution as unknown as JsonValue)}));
    }
    successor = new HsrDriver({...(executionMatch ? {execution: {} as import("../../core/src/executionStart.ts").ExecutionRuntimeHooks, executionStartFor: () => execution, executionHostFor: () => ({pid: proc.pid, birth: exactProcessBirth(proc.pid)!}), resolveExecutionAdapter: () => stubAdapter} : {}), runtimeIdentity: store.runtimeIdentityHooks(), sessionLogDir: join(rig.dir, "logs"), resolve: () => ({adapter: stubAdapter, command: process.execPath, args: [AGENT_PATH], cwd: rig.dir})});
    assert.equal(successor.adopt(bee.id, generation, proc.pid, proc.pidStartedAt), true);
    assert.equal(successor.procOf(bee.id, generation)?.processIdentity, undefined);
    assert.equal(store.runtimeProcessIdentity(bee.id, generation).kind, "legacy");
    const deadline = Date.now() + 4000;
    while (store.runtimeProcessIdentity(bee.id, generation).kind !== "bound" && Date.now() < deadline) { successor.observe(); await sleep(10); }
    const binding = store.runtimeProcessIdentity(bee.id, generation); assert.equal(binding.kind, "bound");
    if (binding.kind !== "bound") throw new Error("Legacy binding missing");
    assert.equal(store.runtimeIdentityHooks().bindLegacy(bee.id, generation, proc.pidStartedAt, binding.identity, "authenticated-host-generation"), false);
    if (executionMatch) {
      successor.detachAll();
      successor = new HsrDriver({runtimeIdentity: store.runtimeIdentityHooks(), sessionLogDir: join(rig.dir, "logs"), resolve: () => ({adapter: stubAdapter, command: process.execPath, args: [AGENT_PATH], cwd: rig.dir})});
      assert.equal(successor.adopt(bee.id, generation, proc.pid, proc.pidStartedAt), true);
    }
    successor.stop(bee.id, generation, "stopped_by_user");
    await drainUntil(successor, rows => rows.some(row => row.kind === "exited"));
  } finally {successor?.disposeAll(); rig.cleanup(); store.close(); h.cleanup();}
});

test("execution host PID and ticks cannot override a bound token from another boot", () => {
  const rig = makeRig();
  try {
    const current = inspectProcess(process.pid);
    assert.equal(current.kind, "present");
    if (current.kind !== "present") throw new Error("Own identity unavailable");
    const contradictory = {pid: current.pid, birth: current.birth, bootId: current.bootId === "" ? "different" : "00000000-0000-4000-8000-000000000000"};
    const driver = new HsrDriver({
      runtimeIdentity: {read: () => ({kind: "bound", identity: contradictory, pidStartedAt: 1}), bindLegacy: () => {throw new Error("Bound identity cannot rebind");}},
      execution: {} as import("../../core/src/executionStart.ts").ExecutionRuntimeHooks,
      executionStartFor: () => ({}) as import("../../core/src/executionStart.ts").ExecutionStart,
      resolveExecutionAdapter: () => stubAdapter,
      executionHostFor: () => ({pid: process.pid, birth: exactProcessBirth(process.pid)!}),
      sessionLogDir: join(rig.dir, "logs"),
      resolve: () => ({adapter: stubAdapter, command: process.execPath, args: [AGENT_PATH], cwd: rig.dir}),
    });
    const paths = (driver as unknown as {runnerPaths(id: string, generation: number): {status: string}}).runnerPaths("contradictory", 1);
    mkdirSync(dirname(paths.status), {recursive: true});
    writeFileSync(paths.status, JSON.stringify({hostPid: process.pid, hostBirth: exactProcessBirth(process.pid), executionDigest: canonicalDigest({}), exited: false, at: Date.now()}));
    assert.equal(driver.adopt("contradictory", 1, process.pid, 1), false);
    assert.equal(driver.hasProcess("contradictory", 1), false);
    assert.equal(driver.procOf("contradictory", 1), null);
    driver.disposeAll();
  } finally {rig.cleanup();}
});

import {mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {canonicalDigest, type JsonValue} from "../../../src/comb/canonical.ts";

import {dirname} from "node:path";
