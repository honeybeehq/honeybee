/**
 * `hive handoff` over a real disposable daemon (stub-backed "claude"/"codex").
 * The CLI infers the CAS inputs (generation, agent), builds target args from
 * --model, and can block on completion with --wait.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDaemonDir, startDaemon, waitFor, AGENT_PATH, type DaemonHandle } from "../../daemon/tests/helpers.ts";
import { runV2Cli, type CliIo } from "../src/main.ts";
import { stripAnsi } from "../src/style.ts";
import type { BeeHandoffResult, ViewResult } from "../../daemon/src/protocol.ts";

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(stripAnsi(l)), err: (l) => err.push(stripAnsi(l)) }, out, err };
}

test("cli.handoff: --to with --model builds target args, --wait blocks to completion, get/status read the receipt, replays dedupe", { timeout: 120_000 }, async () => {
  const stub = (sessionId: string) => ({ command: process.execPath, args: [AGENT_PATH], adapter: "stub" as const, env: { STUB_SESSION_ID: sessionId, STUB_TURN_MS: "10" } });
  const { dir, cleanup } = makeDaemonDir({ agents: { stub: stub("stub-session"), claude: stub("claude-session"), codex: stub("codex-session") } });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const s = capture();
    assert.equal(await runV2Cli(["spawn", "worker", "codex", "--cwd", "/tmp", "--data-dir", dir, "--json"], s.io), 0);
    const spawned = JSON.parse(s.out[0] ?? "{}") as { beeId: string };
    await waitFor(async () => {
      const v = capture();
      await runV2Cli(["view", spawned.beeId, "--data-dir", dir, "--json"], v.io);
      return (JSON.parse(v.out[0] ?? "{}") as ViewResult).view.runtimeState === "idle";
    }, "source idle", 60_000);
    const usage = capture();
    assert.equal(await runV2Cli(["handoff", "worker", "--data-dir", dir], usage.io), 1);
    assert.ok(usage.err[0]?.includes("usage: hive handoff"), usage.err[0]);
    const h = capture();
    assert.equal(
      await runV2Cli(["handoff", "worker", "--to", "claude", "--model", "opus", "-p", "continue on claude", "--idempotency-key", "cli-1", "--wait", "--data-dir", dir, "--json"], h.io),
      0,
    );
    const done = JSON.parse(h.out[0] ?? "{}") as BeeHandoffResult;
    assert.equal(done.phase, "complete");
    assert.equal(done.from.agent, "codex");
    assert.equal(done.to.agent, "claude");
    assert.deepEqual(done.to.args, ["--model", "opus"]);
    assert.equal(done.instruction, "continue on claude");
    const status = capture();
    assert.equal(await runV2Cli(["handoff", "status", "worker", "--data-dir", dir], status.io), 0);
    assert.ok(status.out[0]?.includes("handoff complete"), status.out[0]);
    assert.ok(status.out[0]?.includes("codex → claude"), status.out[0]);
    const get = capture();
    assert.equal(await runV2Cli(["handoff", "get", done.id, "--data-dir", dir, "--json"], get.io), 0);
    assert.equal((JSON.parse(get.out[0] ?? "{}") as BeeHandoffResult).id, done.id);
    const replay = capture();
    assert.equal(await runV2Cli(["handoff", "worker", "--to", "claude", "--model", "opus", "-p", "continue on claude", "--idempotency-key", "cli-1", "--data-dir", dir], replay.io), 1, "the CLI re-infers the CAS inputs after the generation moved: the same key now names a different request");
    assert.ok(replay.err[0]?.includes("idempotency_conflict"), replay.err[0]);
    const v = capture();
    await runV2Cli(["view", "worker", "--data-dir", dir, "--json"], v.io);
    const view = JSON.parse(v.out[0] ?? "{}") as ViewResult;
    assert.equal(view.bee?.agent, "claude");
    assert.deepEqual(view.bee?.args, ["--model", "opus"]);
    assert.equal(view.handoff?.id, done.id);
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});
