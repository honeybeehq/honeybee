/**
 * `hive action …` over a real disposable daemon (stub-backed agent): enqueue,
 * list/get, the bee-side `report` with HIVE_BEE_ID + the delivered token,
 * pause/resume, cancel and retry. Usage errors exit 1 with the usage text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "../../daemon/tests/helpers.ts";
import { runV2Cli, type CliIo } from "../src/main.ts";
import { stripAnsi } from "../src/style.ts";
import type { ActionCompleteResult, ActionEnqueueResult, ActionGetResult, ActionListResult, ActionReportResult, MailboxResult, ViewResult } from "../../daemon/src/protocol.ts";

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(stripAnsi(l)), err: (l) => err.push(stripAnsi(l)) }, out, err };
}

test("cli.action rejects conflicting result flags before contacting a daemon", async () => {
  const { dir, cleanup } = makeDaemonDir();
  try {
    for (const flags of [
      ["--succeeded", "--failed"],
      ["--succeeded", "--uncertain"],
      ["--failed", "--uncertain"],
      ["--succeeded", "--failed", "--uncertain"],
    ]) {
      const result = capture();
      const code = await runV2Cli([
        "action", "report", "action-id", "--attempt", "1", "--token", "test-token",
        ...flags, "--data-dir", dir,
      ], result.io);
      assert.equal(code, 1);
      assert.match(result.err.join("\n"), /exactly one of/);
      assert.equal(result.out.length, 0);
    }
  } finally { cleanup(); }
});

test("cli.action: enqueue → list/get → report from inside the bee (HIVE_BEE_ID + token) → pause/resume/cancel/retry", { timeout: 120_000 }, async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  const savedBee = process.env.HIVE_BEE_ID;
  try {
    daemon = await startDaemon(dir);
    const s = capture();
    assert.equal(await runV2Cli(["spawn", "worker", "stub", "--cwd", "/tmp", "--data-dir", dir, "--json"], s.io), 0);
    const { beeId } = JSON.parse(s.out[0] ?? "{}") as { beeId: string };
    await waitFor(async () => {
      const v = capture();
      await runV2Cli(["view", beeId, "--data-dir", dir, "--json"], v.io);
      return (JSON.parse(v.out[0] ?? "{}") as ViewResult).view.runtimeState === "idle";
    }, "bee idle", 60_000);
    const usage = capture();
    assert.equal(await runV2Cli(["action", "--data-dir", dir], usage.io), 1);
    assert.ok(usage.err[0]?.includes("usage: hive action"), usage.err[0]);
    // Enqueue a commit then a free-form instruction that requires an output.
    const e = capture();
    assert.equal(await runV2Cli(["action", "enqueue", "worker", "commit", "--input", "message=cli commit", "--idempotency-key", "cli-c1", "--data-dir", dir, "--json"], e.io), 0);
    const enq = JSON.parse(e.out[0] ?? "{}") as ActionEnqueueResult;
    assert.equal(enq.actions[0]?.kind, "commit");
    assert.equal(enq.actions[0]?.inputs.message, "cli commit");
    const e2 = capture();
    assert.equal(await runV2Cli(["action", "enqueue", "worker", "instruction", "--input", "instruction=say hello", "--input", 'outputs:=["greeting"]', "--title", "Greet", "--data-dir", dir, "--json"], e2.io), 0);
    const greet = (JSON.parse(e2.out[0] ?? "{}") as ActionEnqueueResult).actions[0]!;
    assert.equal(greet.title, "Greet");
    assert.deepEqual(greet.inputs.outputs, ["greeting"]);
    const commitId = enq.actions[0]!.id;
    // The commit dispatches and is delivered to the stub; read the token from the mailbox as the bee would from its prompt.
    const body = await waitFor(async () => {
      const g = capture();
      await runV2Cli(["action", "get", commitId, "--data-dir", dir, "--json"], g.io);
      const a = (JSON.parse(g.out[0] ?? "{}") as ActionGetResult).action;
      if (a.dispatch?.deliveredAt == null) return null;
      const m = capture();
      await runV2Cli(["mailbox", beeId, "--data-dir", dir, "--json"], m.io);
      return (JSON.parse(m.out[0] ?? "{}") as MailboxResult).messages.find((x) => x.id === a.dispatch!.messageId)?.body ?? null;
    }, "commit instruction delivered", 60_000);
    const tok = /--attempt (\d+) --token ([0-9a-f]+)/.exec(body)!;
    // Report from "inside the bee": HIVE_BEE_ID binds the reporter; a missing outcome flag is a usage error.
    process.env.HIVE_BEE_ID = beeId;
    const bad = capture();
    assert.equal(await runV2Cli(["action", "report", commitId, "--attempt", tok[1]!, "--token", tok[2]!, "--data-dir", dir], bad.io), 1);
    assert.ok(bad.err[0]?.includes("exactly one of"), bad.err[0]);
    const p = capture();
    assert.equal(await runV2Cli(["action", "report", commitId, "--attempt", tok[1]!, "--token", tok[2]!, "--progress", "staging files", "--data-dir", dir], p.io), 0);
    assert.ok(p.out[0]?.includes("progress noted"), p.out[0]);
    const r = capture();
    assert.equal(await runV2Cli(["action", "report", commitId, "--attempt", tok[1]!, "--token", tok[2]!, "--succeeded", "--output", "commitSha=abcdef1234567", "--data-dir", dir, "--json"], r.io), 0);
    const reported = JSON.parse(r.out[0] ?? "{}") as ActionReportResult;
    assert.equal(reported.action.status, "succeeded");
    assert.equal(reported.action.result?.outputs.commitSha, "abcdef1234567");
    // A wrong token from the right bee is a typed refusal.
    const wrong = capture();
    assert.equal(await runV2Cli(["action", "report", commitId, "--attempt", tok[1]!, "--token", "00000000000000000000", "--succeeded", "--output", "commitSha=abcdef1234567", "--data-dir", dir], wrong.io), 1);
    assert.ok(wrong.err[0]?.includes("action_unauthorized"), wrong.err[0]);
    delete process.env.HIVE_BEE_ID;
    // Greet dispatches next; pause, then the queue view shows paused; cancel greet (force: it is delivered) then resume.
    await waitFor(async () => {
      const g = capture();
      await runV2Cli(["action", "get", greet.id, "--data-dir", dir, "--json"], g.io);
      return (JSON.parse(g.out[0] ?? "{}") as ActionGetResult).action.status === "running";
    }, "greet running", 60_000);
    const pause = capture();
    assert.equal(await runV2Cli(["action", "pause", "worker", "--data-dir", dir], pause.io), 0);
    assert.ok(pause.out[0]?.includes("queue paused"), pause.out[0]);
    const c = capture();
    assert.equal(await runV2Cli(["action", "cancel", greet.id, "--force", "--data-dir", dir, "--json"], c.io), 0);
    const l = capture();
    assert.equal(await runV2Cli(["action", "list", "--bee", "worker", "--data-dir", dir, "--json"], l.io), 0);
    const list = JSON.parse(l.out[0] ?? "{}") as ActionListResult;
    assert.deepEqual(list.actions.map((a) => a.status), ["succeeded", "cancelled"]);
    const rt = capture();
    assert.equal(await runV2Cli(["action", "retry", greet.id, "--data-dir", dir], rt.io), 1, "cancelled is terminal");
    assert.ok(rt.err[0]?.includes("action_refused"), rt.err[0]);
    const resume = capture();
    assert.equal(await runV2Cli(["action", "resume", "worker", "--data-dir", dir], resume.io), 0);
    // Operator completion: the usage lists it; /tmp has no readable HEAD, so a commit needs --output commitSha.
    assert.ok(usage.err[0]?.includes("hive action complete <actionId> [--output k=v]... [--detail d]"), usage.err[0]);
    const e3 = capture();
    assert.equal(await runV2Cli(["action", "enqueue", "worker", "commit", "--data-dir", dir, "--json"], e3.io), 0);
    const silent = (JSON.parse(e3.out[0] ?? "{}") as ActionEnqueueResult).actions[0]!;
    await waitFor(async () => {
      const g = capture();
      await runV2Cli(["action", "get", silent.id, "--data-dir", dir, "--json"], g.io);
      return (JSON.parse(g.out[0] ?? "{}") as ActionGetResult).action.status === "running";
    }, "silent commit running", 60_000);
    const noHead = capture();
    assert.equal(await runV2Cli(["action", "complete", silent.id, "--data-dir", dir], noHead.io), 1);
    assert.ok(noHead.err[0]?.includes("invalid_request") && noHead.err[0]?.includes("pass outputs.commitSha"), noHead.err[0]);
    const comp = capture();
    assert.equal(await runV2Cli(["action", "complete", silent.id, "--output", "commitSha=abcdef1234567", "--detail", "agent ignored it", "--idempotency-key", "cli-complete-1", "--data-dir", dir, "--json"], comp.io), 0);
    const completed = JSON.parse(comp.out[0] ?? "{}") as ActionCompleteResult;
    assert.equal(completed.action.status, "succeeded");
    assert.deepEqual(completed.action.result?.receipt, { completedBy: "operator" });
    assert.equal(completed.action.result?.detail, "agent ignored it");
    const again = capture();
    assert.equal(await runV2Cli(["action", "complete", silent.id, "--output", "commitSha=abcdef1234567", "--data-dir", dir], again.io), 0);
    assert.ok(again.out[0]?.includes("already closed"), again.out[0]);
    const defs = capture();
    assert.equal(await runV2Cli(["action", "definitions", "--data-dir", dir], defs.io), 0);
    assert.ok(defs.out.some((line) => line.startsWith("land@1")), defs.out.join("\n"));
  } finally {
    if (savedBee === undefined) delete process.env.HIVE_BEE_ID;
    else process.env.HIVE_BEE_ID = savedBee;
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});
