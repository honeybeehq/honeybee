import assert from "node:assert/strict";
import {test} from "node:test";
import {writeFileSync} from "node:fs";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {openCoreStore} from "../../core/src/index.ts";
import {RuntimeHost} from "../../driver-hsr/src/driver.ts";
import {stubAdapter} from "../../adapters/src/index.ts";
import {drainUntil} from "../../driver-hsr/tests/helpers.ts";
import {inspectProcess, sameProcess} from "../../harness/src/processIdentity.ts";
import {makeDaemonDir, startDaemon, waitFor, AGENT_PATH, type DaemonHandle} from "./helpers.ts";
import type {HealthResult, ViewResult, CommandsResult, MutationResult} from "../src/protocol.ts";

for (const prequeued of [false, true]) test(`fixture daemon recovers archived legacy host with empty status and completes ${prequeued ? "previously queued" : "new"} stop`, {skip: process.platform !== "linux", timeout: 30000}, async () => {
  const rig = makeDaemonDir();
  const store = openCoreStore(join(rig.dir, "core.sqlite3"), {ephemeral: true});
  const driver = new RuntimeHost({runtimeIdentity: store.runtimeIdentityHooks(), sessionLogDir: join(rig.dir, "session-logs"), resolve: () => ({adapter: stubAdapter, command: process.execPath, args: [AGENT_PATH], cwd: rig.dir})});
  let daemon: DaemonHandle | null = null;
  let storeClosed = false;
  try {
    const {bee, runtime} = store.createBee({name: "legacy-archived", agent: "stub", substrate: "hsr", cwd: rig.dir});
    const generation = runtime.generation;
    driver.start(bee.id, generation);
    await drainUntil(driver, rows => rows.some(row => row.kind === "booted"));
    const proc = driver.procOf(bee.id, generation)!;
    store.recordRuntimeProc(bee.id, generation, proc);
    store.updateRuntimeState(bee.id, generation, "running");
    store.updateRuntimeState(bee.id, generation, "idle"); store.archiveBee(bee.id);
    const db = (store as unknown as {db: DatabaseSync}).db;
    db.prepare("UPDATE runtimes SET process_identity=NULL WHERE bee_id=?").run(bee.id);
    const pending = prequeued ? store.enqueueCommand("stop", bee.id, {cause: "stopped_by_user"}, {idempotencyKey: "unresolved-stop"}) : null;
    driver.detachAll();
    writeFileSync(join(rig.dir, "runners", `${bee.id}.${generation}.status.json`), "");
    store.close(); storeClosed = true;
    daemon = await startDaemon(rig.dir);
    let client = await daemon.client();
    await waitFor(async () => !(await client.request<ViewResult>("view", {beeId: bee.id})).identityDiagnostic, "identity warning cleared");
    assert.equal((await client.request<HealthResult>("health")).identityDiagnostic, undefined);
    if (!prequeued) {
      client.close(); await daemon.kill(); daemon = null;
      // Fixture store only, while its sole writer is stopped.
      const ro = new DatabaseSync(join(rig.dir, "core.sqlite3"), {readOnly: true});
      const binding = JSON.parse(String(ro.prepare("SELECT process_identity FROM runtimes WHERE bee_id=? AND generation=?").get(bee.id, generation)?.process_identity));
      ro.close();
      assert.equal(sameProcess(binding, inspectProcess(proc.pid)), true);
      daemon = await startDaemon(rig.dir); client = await daemon.client();
      const preserved = await client.request<ViewResult>("view", {beeId: bee.id});
      assert.equal(preserved.runtime?.pid, proc.pid);
      assert.equal(preserved.runtime?.generation, generation);
      assert.equal(sameProcess(binding, inspectProcess(proc.pid)), true);
      assert.equal(preserved.identityDiagnostic, undefined);
    }
    const stopped = pending ? {commandId: pending.id} : await client.request<MutationResult>("stop", {beeId: bee.id});
    await waitFor(async () => {
      const {commands} = await client.request<CommandsResult>("commands", {beeId: bee.id});
      return commands.find(row => row.id === stopped.commandId)?.status === "done";
    }, "supported stop settles");
    await waitFor(async () => (await client.request<ViewResult>("view", {beeId: bee.id})).runtime?.state === "stopped", "runtime stopped");
    const final = await client.request<ViewResult>("view", {beeId: bee.id});
    assert.equal(final.view.lifecycle, "archived");
    assert.equal(final.runtime?.state, "stopped");
    assert.equal(final.runtime?.exitCause, "stopped_by_user");
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    driver.disposeAll(); if (!storeClosed) store.close(); rig.cleanup();
  }
});
