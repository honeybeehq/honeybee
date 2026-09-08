import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localRepoIdentity } from "../../driver-cell/src/git.ts";
import { makeOrigin } from "../../driver-cell/tests/helpers.ts";
import { makeDaemonDir, startDaemon, waitFor } from "../../daemon/tests/helpers.ts";
import type { BeeMoveResult, SpawnResult, ViewResult } from "../../daemon/src/protocol.ts";
import { runV2Cli } from "../src/main.ts";

test("documented cell move CLI infers placement, preserves explicit CAS and reads receipts", { timeout: 120_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hb-cell-move-cli-"));
  const origin = makeOrigin(root);
  const rig = makeDaemonDir({ cells: { root: join(root, "cells"), allowStubMove: true } });
  const daemon = await startDaemon(rig.dir);
  const client = await daemon.client();
  t.after(async () => { client.close(); await daemon.stop(); rig.cleanup(); rmSync(root, { recursive: true, force: true }); });
  const spawned = await client.request<SpawnResult>("spawn", { name: "cli-move", agent: "stub", substrate: "cell", cell: { originRepo: origin.repo } });
  const view = () => client.request<ViewResult>("view", { beeId: spawned.beeId });
  const before = await waitFor(async () => {
    const value = await view();
    return value.view.runtimeState === "idle" && value.cell ? value : null;
  }, "source ready", 60_000);
  assert.ok(before.cell);
  const run = async (args: string[]) => {
    const out: string[] = []; const err: string[] = [];
    const code = await runV2Cli([...args, "--data-dir", rig.dir, "--json"], { out: (line) => out.push(line), err: (line) => err.push(line) });
    return { code, out, err };
  };
  const stale = await run(["cell", "move", spawned.beeId, "--cwd", origin.repo, "--expected-version", "9", "--idempotency-key", "stale"]);
  assert.equal(stale.code, 1);
  assert.match(stale.err.join("\n"), /stale_placement/);
  assert.equal((await view()).runtime?.generation, 1);
  const identity = localRepoIdentity(origin.repo);
  assert.ok(identity);
  const moved = await run(["cell", "move", spawned.beeId, "--cwd", origin.repo,
    "--expected-version", "0", "--cell-id", before.cell.id, "--observed-head", origin.sha,
    "--git-common-dir", identity.gitCommonDirRealpath, "--object-format", identity.objectFormat, "--idempotency-key", "move"]);
  assert.equal(moved.code, 0, moved.err.join("\n"));
  const receipt: unknown = JSON.parse(moved.out[0] ?? "null");
  assert.ok(typeof receipt === "object" && receipt !== null && "id" in receipt && typeof receipt.id === "string");
  const moveId = receipt.id;
  await client.request("send", { beeId: spawned.beeId, body: "continue", idempotencyKey: "task" });
  await waitFor(async () => (await client.request<BeeMoveResult>("bee.move.get", { moveId })).phase === "complete", "move complete", 60_000);
  const invalidExecOut: string[] = [];
  const invalidExecErr: string[] = [];
  const invalidExec = await runV2Cli([
    "cell", "exec", before.cell.id,
    "--timeout", "wat",
    "--data-dir", rig.dir,
    "--json",
    "--", process.execPath, "-e", "process.exit(0)",
  ], { out: (line) => invalidExecOut.push(line), err: (line) => invalidExecErr.push(line) });
  assert.equal(invalidExec, 1);
  assert.match(invalidExecErr.join("\n"), /--timeout must be a finite number/);
  const get = await run(["cell", "move-get", moveId]);
  assert.equal(get.code, 0, get.err.join("\n"));
  assert.equal(JSON.parse(get.out[0] ?? "{}").phase, "complete");
  const replay = await run(["cell", "move", spawned.beeId, "--cwd", origin.repo, "--idempotency-key", "move"]);
  assert.equal(replay.code, 0, replay.err.join("\n"));
  assert.equal(JSON.parse(replay.out[0] ?? "{}").id, moveId);
  assert.equal(JSON.parse(replay.out[0] ?? "{}").deduped, true);
  const invalid = await run(["cell", "move", spawned.beeId, "--cwd", origin.repo, "--expected-version", "wat"]);
  assert.equal(invalid.code, 1);
  assert.match(invalid.err.join("\n"), /non-negative integer/);
});
