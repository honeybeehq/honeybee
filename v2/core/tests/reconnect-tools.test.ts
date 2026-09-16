import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openCoreStore, replayAudit } from "../src/index.ts";
import { reconnectToolsResult } from "../src/reconnectTools.ts";

function rig(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "hb-reconnect-core-"));
  const store = openCoreStore(join(dir, "store.sqlite3"));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.createBee({ id: "bee", name: "bee", agent: "codex", substrate: "hsr", cwd: dir });
  const runtime = store.currentRuntime("bee")!;
  store.updateRuntimeState("bee", runtime.generation, "running");
  return { store, generation: runtime.generation };
}

test("reconnect waits for turn end, deduplicates, persists receipt and replays audit", t => {
  const { store, generation } = rig(t);
  const command = store.enqueueCommand("reconnect_tools", "bee", {}, { idempotencyKey: "reconnect-1" });
  assert.equal(command.targetGeneration, generation);
  assert.equal(store.claimNextCommand(), null);
  assert.equal(store.enqueueCommand("reconnect_tools", "bee", {}, { idempotencyKey: "reconnect-1" }).id, command.id);
  store.updateRuntimeState("bee", generation, "idle");
  assert.equal(store.claimNextCommand()?.id, command.id);
  const second = store.enqueueCommand("reconnect_tools", "bee");
  assert.equal(store.claimNextCommand(), null, "one reconnect owner per bee");
  store.setReconnectTargets(command.id, ["apiary"]);
  store.settleReconnect(command.id, { outcome: "reloaded", threadId: "native-thread", targets: [], modelTools: "refresh_pending_next_turn" }, null);
  const result = reconnectToolsResult(store.getCommand(command.id)!);
  assert.equal(result.state, "done");
  assert.deepEqual(result.receipt?.targets, ["apiary"]);
  assert.equal(store.currentRuntime("bee")?.generation, generation);
  assert.equal(store.currentRuntime("bee")?.state, "idle");
  assert.equal(store.claimNextCommand()?.id, second.id);
  store.settleReconnect(second.id, null, { code: "reload_rejected", message: "unsupported native request" });
  assert.equal(reconnectToolsResult(store.getCommand(second.id)!).error?.code, "reload_rejected");
  assert.deepEqual(replayAudit(store.auditRows()).commands, store.dumpState().commands);
});

test("stale generation reconnect settles as an explicit no-op", t => {
  const { store, generation } = rig(t);
  const command = store.enqueueCommand("reconnect_tools", "bee");
  store.updateRuntimeState("bee", generation, "stopped", { exitCause: "clean" });
  const successor = store.reviveBee("bee");
  assert.equal(store.claimNextCommand(), null);
  const result = reconnectToolsResult(store.getCommand(command.id)!);
  assert.equal(result.state, "done");
  assert.equal(result.receipt?.outcome, "stale_generation");
  assert.equal(result.receipt?.modelTools, "not_refreshed");
  assert.equal(store.currentRuntime("bee")?.generation, successor.generation);
});

test("interrupted reconnect claims replay after boot without creating a generation", t => {
  const { store, generation } = rig(t);
  store.updateRuntimeState("bee", generation, "idle");
  const command = store.enqueueCommand("reconnect_tools", "bee");
  store.claimNextCommand();
  const path = store.path;
  store.close();
  const recovered = openCoreStore(path);
  t.after(() => recovered.close());
  assert.equal(recovered.getCommand(command.id)?.status, "queued");
  assert.equal(recovered.currentRuntime("bee")?.generation, generation);
});

test("v25 migration retains existing commands and adds the fenced reconnect verb", t => {
  const { store } = rig(t);
  const prior = store.enqueueCommand("archive", "bee", {}, { idempotencyKey: "existing-key" });
  const path = store.path;
  store.close();
  const old = new DatabaseSync(path);
  const ddl = String((old.prepare("SELECT sql FROM sqlite_master WHERE name = 'commands'").get() as { sql: string }).sql);
  old.exec("ALTER TABLE commands RENAME TO current_commands");
  old.exec(ddl.replace(",'reconnect_tools'", ""));
  old.exec("INSERT INTO commands SELECT * FROM current_commands");
  old.exec("DROP TABLE current_commands");
  old.prepare("UPDATE meta SET value = '25' WHERE key = 'schema_version'").run();
  old.prepare("UPDATE sqlite_sequence SET seq = 9000 WHERE name = 'commands'").run();
  old.close();
  const migrated = openCoreStore(path);
  t.after(() => migrated.close());
  assert.equal(migrated.getCommandByIdempotencyKey("existing-key")?.id, prior.id);
  const reconnect = migrated.enqueueCommand("reconnect_tools", "bee");
  assert.equal(reconnect.targetGeneration, 1);
  assert.ok(reconnect.id > 9000, "migration must not reuse historical command IDs");
  assert.equal(migrated.claimNextCommand()?.id, prior.id);
});
