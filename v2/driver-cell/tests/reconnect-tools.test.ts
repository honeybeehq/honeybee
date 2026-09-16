import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { CellDriver } from "../src/driver.ts";
import { codexAdapter } from "../../adapters/src/index.ts";
import { makeRig } from "./helpers.ts";
import { waitFor } from "../../daemon/tests/helpers.ts";

test("detached Cell owner reconnects and re-adopts without reprovisioning or changing generation", { timeout: 90_000 }, async t => {
  const rig = makeRig();
  const make = () => new CellDriver({
    cellsRoot: rig.cellsRoot, nodeKind: "workstation", disableCow: true,
    resolveHarness: () => ({ adapter: codexAdapter({ cwd: rig.root }), command: process.execPath, args: [new URL("../../driver-hsr/test-agent/fake-codex.mjs", import.meta.url).pathname], env: { ...process.env, CODEX_HOME: join(rig.root, "native") } }),
    resolveCell: beeId => ({ provision: { beeId, originRepo: rig.origin.repo, sha: rig.origin.sha, wrapper: beeId, repoName: "fixture", cellId: "c0ffee" }, sandbox: false }),
    hsr: { sessionLogDir: join(rig.root, "logs"), stopKillGraceMs: 400 },
  });
  const driver = make();
  let adopted: CellDriver | null = null;
  t.after(() => { adopted?.disposeAll(); driver.disposeAll(); rig.cleanup(); });
  driver.start("bee-reconnect", 1);
  await waitFor(() => driver.observe().some(e => e.kind === "turn_ended"), "cell native idle", 60_000);
  const identity = driver.procOf("bee-reconnect", 1)!;
  const cell = driver.cellOf("bee-reconnect")!;
  assert.equal(driver.reconnectToolsSupport("bee-reconnect", 1).supported, true);
  const receipt = await driver.reconnectTools("bee-reconnect", 1, 5, async (apply, home) => {
    assert.equal(home, join(rig.root, "native"));
    await apply(["apiary"]);
  });
  driver.observe();
  const cursor = driver.observeRecoveryCursors().at(-1)?.cursor ?? 0;
  driver.detachAll();
  adopted = make();
  assert.equal(adopted.adopt("bee-reconnect", 1, identity.pid, identity.pidStartedAt, "idle", cursor, receipt.threadId), true);
  const successor = adopted;
  const replay = await waitFor(async () => {
    try { return await successor.reconnectTools("bee-reconnect", 1, 5, async () => assert.fail("replayed receipt must not repeat native writes")); }
    catch (error) { if ((error as { code?: string }).code === "not_ready") return null; throw error; }
  }, "cell reconnect receipt recovery", 60_000);
  assert.equal(replay.threadId, receipt.threadId);
  assert.equal(successor.procOf("bee-reconnect", 1)?.pid, identity.pid);
  assert.equal(driver.cellOf("bee-reconnect")?.paths.spaceDir, cell.paths.spaceDir);
});
