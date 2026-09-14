import { test } from "node:test";
import assert from "node:assert/strict";
import { runV2Cli, type CliIo } from "../src/main.ts";
import { makeDaemonDir, startDaemon } from "../../daemon/tests/helpers.ts";
import type { SetParentResult, SpawnResult } from "../../daemon/src/protocol.ts";

test("CLI detach and set-parent resolve local handles, preserve keys, support external IDs and never write offline", async () => {
  const rig = makeDaemonDir(); const daemon = await startDaemon(rig.dir);
  const out: string[] = []; const err: string[] = [];
  const io: CliIo = { out: s => out.push(s), err: s => err.push(s) };
  const run = async (...args: string[]) => { out.length = 0; err.length = 0; return runV2Cli([...args, "--data-dir", rig.dir, "--json"], io); };
  try {
    const client = await daemon.client();
    const parent = await client.request<SpawnResult>("spawn", { name: "parent", agent: "stub", cwd: "/tmp" });
    await client.request("spawn", { name: "child", agent: "stub", cwd: "/tmp", parentId: parent.beeId });
    assert.equal(await run("bee", "detach", "child", "--idempotency-key", "detach"), 0, err.join("\n"));
    const detached = JSON.parse(out.join("\n")) as SetParentResult;
    assert.equal(detached.bee.parentId, null); assert.equal(detached.bee.createdById, parent.beeId);
    assert.equal(await run("bee", "detach", "child", "--idempotency-key", "detach"), 0);
    assert.equal((JSON.parse(out.join("\n")) as SetParentResult).deduped, true);
    assert.equal(await run("bee", "set-parent", "child", "parent"), 0);
    assert.equal((JSON.parse(out.join("\n")) as SetParentResult).bee.parentId, parent.beeId);
    assert.equal(await run("bee", "set-parent", "child", "remote-parent", "--external"), 0);
    assert.equal((JSON.parse(out.join("\n")) as SetParentResult).bee.parentExternal, true);
    client.close(); await daemon.stop();
    assert.equal(await run("bee", "detach", "child"), 1);
  } finally { await daemon.stop(); rig.cleanup(); }
});
