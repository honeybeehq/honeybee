/** Local placement and retained operations over real disposable daemons. */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pidAlive } from "../../driver-hsr/src/psutil.ts";
import { fingerprintOrigin, g, makeOrigin } from "../../driver-cell/tests/helpers.ts";
import { claudeProjectKey } from "../../driver-tmux/src/index.ts";
import type { BeeMoveResult, CellExecResult, CellRetainedRemoveResult, MailboxResult, SendRpcResult, SpawnResult, ViewResult } from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, waitFor } from "./helpers.ts";

const cellAgent = fileURLToPath(new URL("../../driver-cell/test-agent/agent.mjs", import.meta.url));
const SESSION_ID = "move-fixture-conversation";

async function fixture(t: TestContext, opts: { agent?: "stub" | "claude" | "codex" } = {}) {
  const agent = opts.agent ?? "stub";
  const root = mkdtempSync(join(tmpdir(), "hb-cell-move-rpc-"));
  const origin = makeOrigin(root);
  const cellsRoot = join(root, "cells");
  mkdirSync(cellsRoot);
  const claudeHome = join(root, "claude-home");
  mkdirSync(claudeHome);
  const agentSpec = { command: process.execPath, args: [cellAgent], adapter: "stub" as const, env: { STUB_SESSION_ID: SESSION_ID } };
  const rig = makeDaemonDir({
    cells: { root: cellsRoot, allowStubMove: true },
    agents: { stub: agentSpec, claude: agentSpec, codex: agentSpec },
  });
  let daemon = await startDaemon(rig.dir);
  let client = await daemon.client();
  t.after(async () => {
    client.close();
    await daemon.stop();
    rig.cleanup();
    rmSync(root, { recursive: true, force: true });
  });
  const spawned = await client.request<SpawnResult>("spawn", {
    name: "move-fixture",
    agent,
    substrate: "cell",
    cell: { originRepo: origin.repo },
    ...(agent === "claude" ? { env: { CLAUDE_CONFIG_DIR: claudeHome } } : {}),
  });
  const view = () => client.request<ViewResult>("view", { beeId: spawned.beeId });
  const before = await waitFor(async () => {
    const result = await view();
    return result.view.runtimeState === "idle" ? result : null;
  }, "source Cell idle", 60_000);
  assert.ok(before.bee && before.cell && before.runtime);
  const bee = before.bee;
  const cell = before.cell;
  const runtime = before.runtime;
  const request = {
    beeId: bee.id, idempotencyKey: "move",
    expected: { placementVersion: bee.placementVersion, cellId: cell.id },
    destination: {
      kind: "local_checkout", cwd: origin.repo,
      repository: {
        version: 1,
        gitCommonDirRealpath: realpathSync(g(origin.repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])),
        objectFormat: g(origin.repo, ["rev-parse", "--show-object-format"]),
      },
      observedHead: origin.sha,
    },
  };
  const requestRpc = <T>(verb: Parameters<typeof client.request>[0], params: Record<string, unknown>) => client.request<T>(verb, params, 30_000);
  const restart = async () => {
    await daemon.kill();
    const sourceAlive = runtime.pid != null && pidAlive(runtime.pid);
    client.close();
    daemon = await startDaemon(rig.dir);
    client = await daemon.client();
    return sourceAlive;
  };
  const finishMove = async (move: BeeMoveResult) => {
    const sent = await requestRpc<SendRpcResult>("send", { beeId: bee.id, body: "post-placement task", idempotencyKey: "move-mail" });
    await waitFor(async () => {
      const receipt = await requestRpc<BeeMoveResult>("bee.move.get", { moveId: move.id });
      assert.notEqual(receipt.phase, "failed", JSON.stringify(receipt.failure));
      return receipt.phase === "complete";
    }, "move complete", 60_000);
    await waitFor(async () => {
      const mailbox = await requestRpc<MailboxResult>("mailbox", { beeId: bee.id });
      const message = mailbox.messages.find((row) => row.id === sent.messageId);
      assert.equal(message?.body, "post-placement task");
      return message?.deliveredAt != null;
    }, "mail delivered after placement", 20_000);
    const after = await waitFor(async () => {
      const result = await view();
      if (!result.bee?.sessionLogPath || !existsSync(result.bee.sessionLogPath)) return null;
      const entries: unknown[] = readFileSync(result.bee.sessionLogPath, "utf8").trim().split("\n").flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
      const delivered = entries.find((entry) => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "message" && "id" in entry && entry.id === sent.messageId);
      if (typeof delivered !== "object" || delivered === null || !("body" in delivered) || typeof delivered.body !== "string") return null;
      assert.ok(delivered.body.startsWith("[Hive placement context."));
      assert.ok(delivered.body.endsWith("post-placement task"));
      return result;
    }, "placement prefix in dest session log", 20_000);
    return after;
  };
  const finishMoveNoMail = async (move: BeeMoveResult) => {
    await waitFor(async () => {
      const receipt = await requestRpc<BeeMoveResult>("bee.move.get", { moveId: move.id });
      assert.notEqual(receipt.phase, "failed", JSON.stringify(receipt.failure));
      return receipt.phase === "complete";
    }, "move complete without mail", 60_000);
    const mailbox = await requestRpc<MailboxResult>("mailbox", { beeId: bee.id });
    assert.equal(mailbox.messages.length, 0);
    return view();
  };
  if (agent === "claude") {
    assert.equal(bee.providerSessionId, SESSION_ID);
    const fromKey = claudeProjectKey(cell.spaceDir);
    mkdirSync(join(claudeHome, "projects", fromKey), { recursive: true });
    writeFileSync(join(claudeHome, "projects", fromKey, `${SESSION_ID}.jsonl`), "src-transcript\n");
  }
  return { root, origin, before, bee, cell, runtime, request, requestRpc, restart, finishMove, finishMoveNoMail, view, claudeHome };
}

test("cell move RPC preserves conversation, source work, mail and retained operations", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.cell.spaceDir, "retained-work.txt"), "retained\n");
  writeFileSync(join(f.origin.repo, "checkout-work.txt"), "checkout\n");
  const original = fingerprintOrigin(f.origin.repo);
  await assert.rejects(f.requestRpc("bee.move", { ...f.request, node: "remote", idempotencyKey: "remote" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "remote_move_unsupported");
  assert.equal((await f.view()).runtime?.generation, f.runtime.generation);
  const move = await f.requestRpc<BeeMoveResult>("bee.move", f.request);
  const after = await f.finishMove(move);
  assert.equal(after.bee?.id, f.bee.id);
  assert.equal(after.bee?.cwd, f.origin.repo);
  assert.equal(after.bee?.substrate, "hsr");
  assert.equal(after.bee?.placementVersion, f.bee.placementVersion + 1);
  assert.ok(f.bee.providerSessionId);
  assert.equal(after.bee?.providerSessionId, f.bee.providerSessionId);
  assert.equal(after.runtime?.generation, f.runtime.generation + 1);
  assert.equal(after.cell?.id, f.cell.id);
  assert.equal(after.cell?.state, "retained");
  assert.deepEqual(fingerprintOrigin(f.origin.repo), original);
  assert.equal(existsSync(join(f.origin.repo, "retained-work.txt")), false);
  assert.equal(readFileSync(join(f.cell.spaceDir, "retained-work.txt"), "utf8"), "retained\n");
  assert.equal((await f.requestRpc<BeeMoveResult>("bee.move", f.request)).id, move.id);
  await assert.rejects(f.requestRpc("bee.move", { ...f.request, destination: { ...f.request.destination, observedHead: "0".repeat(40) } }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "idempotency_conflict");
  const exec = { cellId: f.cell.id, idempotencyKey: "exec", argv: [process.execPath, "-e", "require('node:fs').appendFileSync('count.txt','once\\n'); console.log(process.cwd())"] };
  const result = await f.requestRpc<CellExecResult>("cell.exec", exec);
  assert.equal(result.status, "done");
  assert.equal(realpathSync(result.stdout.trim()), realpathSync(f.cell.spaceDir));
  assert.equal((await f.requestRpc<CellExecResult>("cell.exec", exec)).id, result.id);
  assert.equal(readFileSync(join(f.cell.spaceDir, "count.txt"), "utf8"), "once\n");
  const removed = await f.requestRpc<CellRetainedRemoveResult>("cell.retained.remove", { cellId: f.cell.id, idempotencyKey: "remove", force: true });
  assert.equal(removed.status, "deleted");
  const survivor = await f.view();
  assert.equal(survivor.bee?.id, f.bee.id);
  assert.notEqual(survivor.bee?.lifecycle, "deleted");
  assert.equal(survivor.bee?.cellId, null);
  assert.equal(survivor.runtime?.generation, after.runtime?.generation);
});

test("cell move survives daemon loss after durable admission", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t);
  const move = await f.requestRpc<BeeMoveResult>("bee.move", f.request);
  await f.restart();
  const after = await f.finishMove(move);
  assert.equal(after.bee?.placementVersion, f.bee.placementVersion + 1);
  assert.equal(after.runtime?.generation, f.runtime.generation + 1);
  assert.equal(after.bee?.providerSessionId, f.bee.providerSessionId);
  assert.equal(after.move?.id, move.id);
  assert.equal(after.move?.phase, "complete");
});

test("retained exec after daemon loss never replays and releases its gate after process absence", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t);
  const move = await f.requestRpc<BeeMoveResult>("bee.move", f.request);
  await f.finishMove(move);
  const exec = {
    cellId: f.cell.id, idempotencyKey: "interrupted-exec", timeoutMs: 10_000,
    argv: [process.execPath, "-e", "const fs=require('node:fs'); fs.appendFileSync('crash-count.txt','once\\n'); fs.writeFileSync('exec-pid.txt',String(process.pid)); setTimeout(()=>{},3000)"],
  };
  const pending = f.requestRpc<CellExecResult>("cell.exec", exec).catch(() => null);
  await waitFor(() => existsSync(join(f.cell.spaceDir, "exec-pid.txt")), "exec has started", 10_000);
  const execPid = Number(readFileSync(join(f.cell.spaceDir, "exec-pid.txt"), "utf8"));
  await f.restart();
  await pending;
  await waitFor(() => !pidAlive(execPid), "orphan exec absent", 15_000);
  // A new operation must not require the caller to replay the old key first.
  const next = await f.requestRpc<CellExecResult>("cell.exec", { cellId: f.cell.id, idempotencyKey: "next-exec", argv: [process.execPath, "-e", "console.log('next')"] });
  assert.equal(next.status, "done", JSON.stringify(next));
  const old = await f.requestRpc<CellExecResult>("cell.exec", exec);
  assert.equal(old.status, "outcome_unknown");
  assert.equal(old.deduped, true);
  assert.equal(readFileSync(join(f.cell.spaceDir, "crash-count.txt"), "utf8"), "once\n");
});

test("cell move completes on dest idle with no mail for Codex", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t, { agent: "codex" });
  const move = await f.requestRpc<BeeMoveResult>("bee.move", f.request);
  const after = await f.finishMoveNoMail(move);
  assert.equal(after.bee?.id, f.bee.id);
  assert.equal(after.bee?.cwd, f.origin.repo);
  assert.equal(after.bee?.substrate, "hsr");
  assert.equal(after.runtime?.generation, f.runtime.generation + 1);
  assert.equal(after.move?.phase, "complete");
  assert.equal(after.bee?.providerSessionId, f.bee.providerSessionId);
});

test("cell move carries Claude transcript and completes with no mail", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t, { agent: "claude" });
  const move = await f.requestRpc<BeeMoveResult>("bee.move", f.request);
  const after = await f.finishMoveNoMail(move);
  assert.equal(after.move?.phase, "complete");
  assert.equal(after.bee?.cwd, f.origin.repo);
  assert.equal(after.runtime?.generation, f.runtime.generation + 1);
  const dest = join(f.claudeHome, "projects", claudeProjectKey(f.origin.repo), `${SESSION_ID}.jsonl`);
  assert.equal(readFileSync(dest, "utf8"), "src-transcript\n");
  assert.ok(existsSync(join(f.claudeHome, "projects", claudeProjectKey(f.origin.repo), `.hive-move-${move.id}`)));
});
