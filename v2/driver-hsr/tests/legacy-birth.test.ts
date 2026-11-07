import {inspectProcess, exactProcessBirth} from "../../harness/src/processIdentity.ts";
import assert from "node:assert/strict";
import {test} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {join} from "node:path";
import {harness, makeBee} from "../../core/tests/helpers.ts";
import {makeRig, drainUntil, sleep, AGENT_PATH} from "./helpers.ts";
import {RuntimeHost} from "../src/driver.ts";
import {stubAdapter} from "../../adapters/src/index.ts";

for (const executionMatch of [false, true]) test(`legacy HSR birth requires authenticated CAS even with executionHost match=${executionMatch}`, {timeout: 15000}, async () => {
  const h = harness(), store = h.open(), rig = makeRig({runtimeIdentity: store.runtimeIdentityHooks()});
  let successor: RuntimeHost | null = null;
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
    successor = new RuntimeHost({...(executionMatch ? {execution: {} as import("../../core/src/executionStart.ts").ExecutionRuntimeHooks, executionStartFor: () => execution, executionHostFor: () => ({pid: proc.pid, birth: exactProcessBirth(proc.pid)!}), resolveExecutionAdapter: () => stubAdapter} : {}), runtimeIdentity: store.runtimeIdentityHooks(), sessionLogDir: join(rig.dir, "logs"), resolve: () => ({adapter: stubAdapter, command: process.execPath, args: [AGENT_PATH], cwd: rig.dir})});
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
      successor = new RuntimeHost({runtimeIdentity: store.runtimeIdentityHooks(), sessionLogDir: join(rig.dir, "logs"), resolve: () => ({adapter: stubAdapter, command: process.execPath, args: [AGENT_PATH], cwd: rig.dir})});
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
    const driver = new RuntimeHost({
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
import {canonicalDigest, type JsonValue} from "../../core/src/canonical.ts";

import {dirname} from "node:path";

for (const lost of [false, true]) test(`legacy archived runtime recovers authenticated birth with ${lost ? "lost" : "empty"} status`, {skip: process.platform !== "linux", timeout: 15000}, async () => {
  const h = harness(), store = h.open(), rig = makeRig({runtimeIdentity: store.runtimeIdentityHooks()});
  let successor: RuntimeHost | null = null;
  try {
    const {bee} = makeBee(store), generation = store.currentRuntime(bee.id)!.generation;
    rig.driver.start(bee.id, generation);
    await drainUntil(rig.driver, rows => rows.some(row => row.kind === "booted"));
    const proc = rig.driver.procOf(bee.id, generation)!;
    store.recordRuntimeProc(bee.id, generation, proc);
    store.updateRuntimeState(bee.id, generation, "running");
    store.updateRuntimeState(bee.id, generation, "idle"); store.archiveBee(bee.id);
    const paths = (rig.driver as unknown as {runnerPaths(id: string, generation: number): {status: string}}).runnerPaths(bee.id, generation);
    rig.driver.detachAll();
    if (lost) renameSync(paths.status, `${paths.status}.saved`); else writeFileSync(paths.status, "");
    (store as unknown as {db: DatabaseSync}).db.prepare("UPDATE runtimes SET process_identity=NULL WHERE bee_id=?").run(bee.id);
    assert.equal(legacyRunnerCommandProof(proc.processIdentity!, proc.pidStartedAt, join(rig.dir, "runners", `${bee.id}.${generation}.json`), paths.status), true);
    assert.equal(legacyRunnerCommandProof(proc.processIdentity!, proc.pidStartedAt, join(rig.dir, "runners", `${bee.id}.${generation + 1}.json`), paths.status), false);
    writeFileSync(paths.status, "{corrupt");
    assert.equal(legacyRunnerCommandProof(proc.processIdentity!, proc.pidStartedAt, join(rig.dir, "runners", `${bee.id}.${generation}.json`), paths.status), false);
    writeFileSync(paths.status, "");
    if (lost) renameSync(paths.status, `${paths.status}.checked`);
    successor = new RuntimeHost({runtimeIdentity: store.runtimeIdentityHooks(), sessionLogDir: join(rig.dir, "logs"), resolve: () => ({adapter: stubAdapter, command: process.execPath, args: [AGENT_PATH], cwd: rig.dir})});
    const db = (store as unknown as {db: DatabaseSync}).db;
    db.prepare("UPDATE runtimes SET process_identity=? WHERE bee_id=?").run("{corrupt", bee.id);
    assert.equal(successor.adopt(bee.id, generation, proc.pid, proc.pidStartedAt, "idle"), false, "corrupt token never replaced");
    db.prepare("UPDATE runtimes SET process_identity=NULL WHERE bee_id=?").run(bee.id);
    assert.equal(successor.adopt(bee.id, generation, proc.pid, proc.pidStartedAt - 10000, "idle"), false);
    assert.equal(successor.adopt(bee.id, generation, proc.pid, proc.pidStartedAt, "idle"), true);
    const deadline = Date.now() + 2000;
    while (store.runtimeProcessIdentity(bee.id, generation).kind !== "bound" && Date.now() < deadline) { successor.observe(); await sleep(10); }
    assert.equal(store.runtimeProcessIdentity(bee.id, generation).kind, "bound");
    assert.equal(successor.isDegraded(bee.id, generation), true, "lost observation evidence stays degraded");
    successor.stop(bee.id, generation, "stopped_by_user");
    await drainUntil(successor, rows => rows.some(row => row.kind === "exited"));
    assert.equal(store.getBee(bee.id)!.lifecycle, "archived");
  } finally {successor?.disposeAll(); rig.cleanup(); store.close(); h.cleanup();}
});
import {renameSync} from "node:fs";
import {legacyRunnerCommandProof} from "../src/legacyRunnerProof.ts";
