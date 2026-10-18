import assert from "node:assert/strict";
import {test} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {join} from "node:path";
import {harness, makeBee} from "../../core/tests/helpers.ts";
import {makeRig, drainUntil, sleep, AGENT_PATH} from "./helpers.ts";
import {HsrDriver} from "../src/driver.ts";
import {stubAdapter} from "../../adapters/src/index.ts";

test("legacy HSR birth binds once only after kernel-authenticated host and generation proof", {timeout: 15000}, async () => {
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
    successor = new HsrDriver({runtimeIdentity: store.runtimeIdentityHooks(), sessionLogDir: join(rig.dir, "logs"), resolve: () => ({adapter: stubAdapter, command: process.execPath, args: [AGENT_PATH], cwd: rig.dir})});
    assert.equal(successor.adopt(bee.id, generation, proc.pid, proc.pidStartedAt), true);
    const deadline = Date.now() + 4000;
    while (store.runtimeProcessIdentity(bee.id, generation).kind !== "bound" && Date.now() < deadline) { successor.observe(); await sleep(10); }
    const binding = store.runtimeProcessIdentity(bee.id, generation); assert.equal(binding.kind, "bound");
    if (binding.kind !== "bound") throw new Error("Legacy binding missing");
    assert.equal(store.runtimeIdentityHooks().bindLegacy(bee.id, generation, proc.pidStartedAt, binding.identity, "authenticated-host-generation"), false);
    successor.stop(bee.id, generation, "stopped_by_user");
    await drainUntil(successor, rows => rows.some(row => row.kind === "exited"));
  } finally {successor?.disposeAll(); rig.cleanup(); store.close(); h.cleanup();}
});
