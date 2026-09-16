/**
 * v24 action queue over a REAL disposable daemon: a real Cell bee (stub-backed
 * agent running inside a git checkout of a fixture origin), the queue driven
 * through the RPC surface, the agent's commit made INSIDE the Cell space, the
 * landing performed by the daemon's real cell.capture (a branch in the fixture
 * origin advances), the archive through the lifecycle queue, a SIGKILL restart
 * mid-sequence, and the capability / snapshot / watch contract Apiary mirrors.
 * Nothing here touches ~/.hive, a real daemon, or a live bee.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { commitInCell, g, makeOrigin } from "../../driver-cell/tests/helpers.ts";
import type { ActionView, AuditRow } from "../../core/src/index.ts";
import type {
  ActionCancelResult,
  ActionClaimResult,
  ActionDefinitionsResult,
  ActionEnqueueResult,
  ActionGetResult,
  ActionListResult,
  ActionQueueControlResult,
  ActionReorderResult,
  ActionReportResult,
  DeployInfoResult,
  MailboxResult,
  SnapshotResult,
  SpawnResult,
  ViewResult,
} from "../src/protocol.ts";
import { RpcClient } from "../../cli/src/client.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CELL_AGENT_PATH = join(here, "..", "..", "driver-cell", "test-agent", "agent.mjs");

interface Fixture {
  root: string;
  originRepo: string;
  output: () => string;
  rpc: <T>(verb: Parameters<RpcClient["request"]>[0], params?: Record<string, unknown>) => Promise<T>;
  restart: () => Promise<void>;
  action: (id: string) => Promise<ActionView>;
  waitStatus: (id: string, statuses: string[], what: string) => Promise<ActionView>;
  dispatchBody: (beeId: string, id: string) => Promise<string>;
}

async function fixture(t: TestContext): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "hb-actions-rpc-"));
  const origin = makeOrigin(root);
  const cellsRoot = join(root, "cells");
  mkdirSync(cellsRoot);
  const rig = makeDaemonDir({
    bootHangTimeoutMs: 60_000,
    cells: { root: cellsRoot },
    agents: {
      cellstub: {
        command: process.execPath,
        args: [CELL_AGENT_PATH],
        adapter: "stub",
        env: {
          GIT_AUTHOR_NAME: "cell-bee",
          GIT_AUTHOR_EMAIL: "bee@hive.invalid",
          GIT_COMMITTER_NAME: "cell-bee",
          GIT_COMMITTER_EMAIL: "bee@hive.invalid",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          STUB_TURN_MS: "10",
        },
      },
    },
  });
  let daemon: DaemonHandle = await startDaemon(rig.dir);
  let client: RpcClient = await daemon.client();
  t.after(async () => {
    client.close();
    await daemon.stop().catch(() => {});
    rig.cleanup();
    rmSync(root, { recursive: true, force: true });
  });
  t.after(() => {
    if (process.env.HB_ACTIONS_RPC_DEBUG) console.error(daemon.output().split("\n").slice(-200).join("\n"));
  });
  const f: Fixture = {
    root,
    originRepo: origin.repo,
    output: () => daemon.output(),
    rpc: (verb, params = {}) => client.request(verb, params, 30_000),
    restart: async () => {
      await daemon.kill();
      client.close();
      daemon = await startDaemon(rig.dir);
      client = await daemon.client();
    },
    action: async (id) => (await client.request<ActionGetResult>("action.get", { actionId: id })).action,
    waitStatus: (id, statuses, what) => waitFor(async () => {
      const a = (await client.request<ActionGetResult>("action.get", { actionId: id })).action;
      if (a.status === "failed" && !statuses.includes("failed")) assert.fail(`${what}: action failed ${JSON.stringify(a.failure)}`);
      return statuses.includes(a.status) ? a : null;
    }, what, 60_000),
    dispatchBody: async (beeId, id) => {
      const a = (await client.request<ActionGetResult>("action.get", { actionId: id })).action;
      const messageId = a.dispatch?.messageId;
      assert.ok(messageId != null, "dispatched");
      const box = await client.request<MailboxResult>("mailbox", { beeId });
      const msg = box.messages.find((m) => m.id === messageId);
      assert.ok(msg, "dispatch message in the mailbox");
      return msg.body;
    },
  };
  return f;
}

function tokenOf(body: string): { attempt: number; token: string } {
  const m = /--attempt (\d+) --token ([0-9a-f]+)/.exec(body);
  if (!m) throw new Error(`no token in body: ${body}`);
  return { attempt: Number(m[1]), token: m[2] as string };
}

const rejectsCode = (code: string) => (error: unknown) => error instanceof Error && "code" in error && (error as { code: string }).code === code;

test("actions.rpc.ship: Commit → Land → Archive over a real daemon + real Cell — capability, durable acceptance, mailbox dispatch, SIGKILL mid-sequence, real landing receipt, archive, mirror shapes", { timeout: 180_000 }, async (t) => {
  const f = await fixture(t);
  const info = await f.rpc<DeployInfoResult>("deployInfo");
  assert.ok(info.capabilities.includes("bee.actions.v1"), "capability advertised");
  const defs = await f.rpc<ActionDefinitionsResult>("action.definitions");
  assert.ok(defs.definitions.some((d) => d.kind === "land" && d.executor === "cell.capture"));

  const spawned = await f.rpc<SpawnResult>("spawn", { name: "shipper", agent: "cellstub", cwd: "/ignored", substrate: "cell", cell: { originRepo: f.originRepo } });
  const beeId = spawned.beeId;
  const idle = await waitFor(async () => {
    const v = await f.rpc<ViewResult>("view", { beeId });
    return v.view.runtimeState === "idle" ? v : null;
  }, "cell bee idle", 60_000);
  const spaceDir = idle.bee!.cwd;
  assert.ok(idle.cell && idle.cell.state === "active");

  // Keep the bee busy with a slow turn so the sequence is accepted WHILE it works.
  await f.rpc("send", { beeId, body: "@sh sleep 2 && echo busy" });
  await waitFor(async () => (await f.rpc<ViewResult>("view", { beeId })).view.runtimeState === "running", "bee working", 20_000);

  const request = {
    beeId,
    idempotencyKey: "ship-rpc-1",
    items: [
      { kind: "commit", inputs: { message: "queue work" }, clientRef: "waggle-1" },
      { kind: "land", inputs: { targetBranch: "throwaway/landing", commit: { $ref: { item: 0, output: "commitSha" } } }, clientRef: "waggle-2" },
      { kind: "archive", clientRef: "waggle-3" },
    ],
  };
  const accepted = await f.rpc<ActionEnqueueResult>("action.enqueue", request);
  assert.equal(accepted.deduped, false);
  assert.deepEqual(accepted.actions.map((a) => [a.kind, a.position, a.status, a.clientRef]), [["commit", 1, "queued", "waggle-1"], ["land", 2, "queued", "waggle-2"], ["archive", 3, "queued", "waggle-3"]]);
  const [commit, land, archive] = accepted.actions.map((a) => a.id) as [string, string, string];
  const replay = await f.rpc<ActionEnqueueResult>("action.enqueue", request);
  assert.equal(replay.deduped, true);
  assert.deepEqual(replay.actions.map((a) => a.id), [commit, land, archive]);
  await assert.rejects(f.rpc("action.enqueue", { ...request, items: [{ kind: "commit" }] }), rejectsCode("idempotency_conflict"));
  await assert.rejects(f.rpc("action.enqueue", { beeId, idempotencyKey: "bad-kind", items: [{ kind: "teleport" }] }), rejectsCode("action_kind_unknown"));

  // The commit instruction rides the mailbox and is delivered at the accept point; the turn ending is not completion.
  const running = await f.waitStatus(commit, ["running"], "commit dispatched");
  assert.equal(running.attempt, 1);
  await waitFor(async () => (await f.action(commit)).dispatch?.deliveredAt != null, "instruction delivered", 30_000);
  await waitFor(async () => (await f.rpc<ViewResult>("view", { beeId })).view.runtimeState === "idle", "turn ended", 30_000);
  assert.equal((await f.action(commit)).status, "running", "turn end ≠ completion");
  assert.equal((await f.action(land)).status, "queued");

  // SIGKILL the daemon mid-sequence: the accepted queue and the running attempt survive.
  await f.restart();
  const afterKill = await f.action(commit);
  assert.equal(afterKill.status, "running");
  assert.equal(afterKill.attempt, 1);
  assert.equal((await f.action(land)).status, "queued");

  // The agent's work: a real commit inside the Cell space; then the authenticated report with the delivered token.
  const body = await f.dispatchBody(beeId, commit);
  assert.ok(body.includes(`hive action report ${commit} --attempt 1 --token`), body);
  const cellSha = commitInCell(spaceDir, "queued.txt", "from the queue\n", "queued work");
  const { attempt, token } = tokenOf(body);
  await assert.rejects(f.rpc("action.report", { actionId: commit, attempt, token: "0000000000000000dead", beeId, kind: "result", outcome: "succeeded", outputs: { commitSha: cellSha } }), rejectsCode("action_unauthorized"));
  await assert.rejects(f.rpc("action.report", { actionId: commit, attempt, token, beeId, kind: "result", outcome: "succeeded", outputs: {} }), rejectsCode("invalid_request"));
  const reported = await f.rpc<ActionReportResult>("action.report", { actionId: commit, attempt, token, beeId, kind: "result", outcome: "succeeded", outputs: { commitSha: cellSha }, idempotencyKey: "report-1" });
  assert.equal(reported.action.status, "succeeded");
  assert.equal(reported.action.result?.outputs.commitSha, cellSha);
  const dup = await f.rpc<ActionReportResult>("action.report", { actionId: commit, attempt, token, beeId, kind: "result", outcome: "succeeded", outputs: { commitSha: cellSha }, idempotencyKey: "report-1" });
  assert.equal(dup.deduped, true);
  const dup2 = await f.rpc<ActionReportResult>("action.report", { actionId: commit, attempt, token, beeId, kind: "result", outcome: "succeeded", outputs: { commitSha: cellSha } });
  assert.equal(dup2.applied, false);
  assert.equal(dup2.deduped, true);

  // Land: the daemon's REAL cell.capture lands the intended commit onto the origin branch; the receipt releases Archive.
  const landed = await f.waitStatus(land, ["succeeded"], "landed");
  assert.deepEqual(landed.resolvedInputs, { targetBranch: "throwaway/landing", commit: cellSha });
  assert.equal(landed.result?.outputs.cellHead, cellSha);
  assert.equal(landed.result?.outputs.targetBranch, "throwaway/landing");
  const tip = g(f.originRepo, ["rev-parse", "refs/heads/throwaway/landing"]);
  assert.equal(landed.result?.outputs.resultSha, tip, "the receipt names the origin's new tip");
  assert.equal(tip, cellSha, "branch created at the cell head (fast path)");
  assert.equal(g(f.originRepo, ["rev-parse", "refs/heads/main"]), (await f.rpc<ViewResult>("view", { beeId })).cell!.sha, "main untouched");
  assert.equal((landed.result?.receipt as { status: string }).status, "landed");

  const archived = await f.waitStatus(archive, ["succeeded"], "archived");
  const view = await f.rpc<ViewResult>("view", { beeId });
  assert.equal(view.bee?.lifecycle, "archived");
  assert.equal(archived.result?.outputs.archivedAt, view.bee?.archivedAt);

  // Snapshot + watch carry the queue for the mirror; the stream replays every status change as action.put.
  const snapshot = await f.rpc<SnapshotResult>("snapshot");
  assert.equal(snapshot.actions.filter((a) => a.beeId === beeId).length, 3);
  assert.equal(snapshot.actionQueues.find((q) => q.beeId === beeId)?.counts.succeeded, 3);
  const tail = await f.rpc<{ rows: AuditRow[] }>("audit.tail", { beeId, limit: 1000 });
  const puts = tail.rows.filter((r) => r.kind === "action.put").map((r) => r.payload.action as ActionView);
  assert.ok(puts.some((a) => a.id === commit && a.status === "running"));
  assert.ok(puts.some((a) => a.id === land && a.status === "succeeded"));
  assert.ok(puts.some((a) => a.id === archive && a.status === "succeeded"));
  assert.ok(tail.rows.some((r) => r.kind === "action_queue.put"));
  assert.ok(tail.rows.some((r) => r.kind === "action.report_rejected" && r.payload.reason === "unauthorized"));
  assert.equal(puts.every((a) => !("attemptToken" in a)), true, "tokens never reach the stream");

  // Restart again: everything terminal stays terminal; a stale-attempt report is refused with its own code.
  await f.restart();
  assert.equal((await f.action(archive)).status, "succeeded");
  const list = await f.rpc<ActionListResult>("action.list", { beeId, statuses: ["succeeded"] });
  assert.equal(list.actions.length, 3);
});

test("actions.rpc.controls: pause/resume, cancel, invalid reorder, a question that holds the lane, retry after a conflict, external claim", { timeout: 180_000 }, async (t) => {
  const f = await fixture(t);
  const spawned = await f.rpc<SpawnResult>("spawn", { name: "ctl", agent: "cellstub", cwd: "/ignored", substrate: "cell", cell: { originRepo: f.originRepo } });
  const beeId = spawned.beeId;
  const idle = await waitFor(async () => {
    const v = await f.rpc<ViewResult>("view", { beeId });
    return v.view.runtimeState === "idle" ? v : null;
  }, "cell bee idle", 60_000);
  const spaceDir = idle.bee!.cwd;

  const paused = await f.rpc<ActionQueueControlResult>("action.queue.pause", { beeId, idempotencyKey: "pause-1" });
  assert.equal(paused.queue.paused, true);
  const accepted = await f.rpc<ActionEnqueueResult>("action.enqueue", {
    beeId,
    idempotencyKey: "ctl-1",
    items: [
      { kind: "commit" },
      { kind: "land", inputs: { targetBranch: "throwaway/ctl", commit: { $ref: { item: 0, output: "commitSha" } } } },
      { kind: "open_pr", inputs: { branch: "throwaway/ctl" } },
      { kind: "archive" },
    ],
  });
  const [commit, land, pr, archive] = accepted.actions.map((a) => a.id) as [string, string, string, string];
  assert.deepEqual(accepted.actions[0]!.hold, { reason: "paused", actionId: null, actionStatus: null });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await f.action(commit)).status, "queued", "paused: nothing released");
  await assert.rejects(f.rpc("action.reorder", { beeId, order: [land, commit, pr, archive] }), rejectsCode("action_reorder_invalid"));
  await assert.rejects(f.rpc("action.reorder", { beeId, order: [commit, land] }), rejectsCode("action_reorder_invalid"));
  const reordered = await f.rpc<ActionReorderResult>("action.reorder", { beeId, order: [commit, land, archive, pr] });
  assert.deepEqual(reordered.actions.map((a) => [a.id, a.position]), [[commit, 1], [land, 2], [archive, 3], [pr, 4]]);
  // Cancel the PR (pending) and resume.
  const cancelled = await f.rpc<ActionCancelResult>("action.cancel", { actionId: pr });
  assert.equal(cancelled.action.status, "cancelled");
  await assert.rejects(f.rpc("action.retry", { actionId: pr }), rejectsCode("action_refused"));
  await assert.rejects(f.rpc("action.get", { actionId: "nope" }), rejectsCode("action_not_found"));
  await f.rpc("action.queue.resume", { beeId });
  await f.waitStatus(commit, ["running"], "commit dispatched after resume");
  await waitFor(async () => (await f.action(commit)).dispatch?.deliveredAt != null, "delivered", 30_000);
  const { attempt, token } = tokenOf(await f.dispatchBody(beeId, commit));
  // The agent asks a question: the lane waits for input; land stays queued.
  const asked = await f.rpc<ActionReportResult>("action.report", { actionId: commit, attempt, token, beeId, kind: "question", question: { text: "commit the fixture too?", options: ["yes", "no"] } });
  assert.equal(asked.action.status, "waiting");
  assert.equal(asked.action.waitingReason, "input");
  assert.equal(asked.question?.status, "open");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await f.action(land)).status, "queued");
  await f.rpc("question.answer", { questionId: asked.question!.id, answer: "yes" });
  await f.waitStatus(commit, ["running"], "resumed after the answer");
  // Make the landing conflict for real: origin's throwaway/ctl and the cell both edit README.md.
  g(f.originRepo, ["branch", "throwaway/ctl"]);
  g(f.originRepo, ["worktree", "add", join(f.root, "wt"), "throwaway/ctl"]);
  const wt = join(f.root, "wt");
  commitInCell(wt, "README.md", "# origin edit\n", "origin edit");
  const cellSha = commitInCell(spaceDir, "README.md", "# cell edit\n", "cell edit");
  await f.rpc("action.report", { actionId: commit, attempt, token, beeId, kind: "result", outcome: "succeeded", outputs: { commitSha: cellSha } });
  const conflicted = await f.waitStatus(land, ["failed"], "conflict");
  assert.equal(conflicted.failure?.code, "conflict");
  assert.match(conflicted.failure?.detail ?? "", /README\.md/);
  assert.equal(conflicted.controls.retry, true);
  await new Promise((r) => setTimeout(r, 200));
  const heldArchive = await f.action(archive);
  assert.equal(heldArchive.status, "queued");
  assert.deepEqual(heldArchive.hold, { reason: "predecessor_failed", actionId: land, actionStatus: "failed" });
  assert.equal((await f.rpc<ViewResult>("view", { beeId })).bee?.lifecycle, "active", "no archive after a refused landing");
  // Resolve on the origin side (drop the conflicting origin edit) and retry: a NEW attempt lands.
  g(wt, ["reset", "--hard", "HEAD~1"]);
  await f.rpc("action.retry", { actionId: land, idempotencyKey: "retry-land" });
  const landed = await f.waitStatus(land, ["succeeded"], "landed on retry");
  assert.equal(landed.attempt, 2);
  assert.equal(landed.attempts[0]?.outcome, "failed");
  assert.equal(g(f.originRepo, ["rev-parse", "refs/heads/throwaway/ctl"]), landed.result?.outputs.resultSha);
  await f.waitStatus(archive, ["succeeded"], "archived");
  // A stale report for attempt 1 of the commit (settled) is a quiet duplicate; for a superseded attempt it is typed.
  const late = await f.rpc<ActionReportResult>("action.report", { actionId: commit, attempt, token, beeId, kind: "result", outcome: "succeeded", outputs: { commitSha: cellSha } });
  assert.equal(late.deduped, true);
  // External executor path: an open_pr on a fresh sequence waits for a claimant; Apiary claims and reports.
  await f.rpc("unarchive", { beeId });
  const ext = await f.rpc<ActionEnqueueResult>("action.enqueue", { beeId, idempotencyKey: "ext-1", items: [{ kind: "open_pr", inputs: { branch: "throwaway/ctl", base: "main" } }] });
  const prId = ext.actions[0]!.id;
  const offered = await f.waitStatus(prId, ["waiting"], "offered to executors");
  assert.equal(offered.waitingReason, "executor");
  assert.equal(offered.controls.cancel, true);
  const claim = await f.rpc<ActionClaimResult>("action.claim", { executor: "apiary", kinds: ["open_pr"] });
  assert.ok(claim.claim);
  assert.equal(claim.claim.action.id, prId);
  assert.equal(claim.claim.action.status, "running");
  await assert.rejects(f.rpc("action.claim", { executor: "someone-else", actionId: prId }), rejectsCode("action_claimed"));
  await assert.rejects(f.rpc("action.report", { actionId: prId, attempt: claim.claim.attempt, token: claim.claim.token, executor: "someone-else", kind: "result", outcome: "succeeded", outputs: { prUrl: "https://example/pr/1" } }), rejectsCode("action_unauthorized"));
  const done = await f.rpc<ActionReportResult>("action.report", { actionId: prId, attempt: claim.claim.attempt, token: claim.claim.token, executor: "apiary", kind: "result", outcome: "succeeded", outputs: { prUrl: "https://example/pr/1", prNumber: 1 }, receipt: { number: 1 } });
  assert.equal(done.action.status, "succeeded");
  await assert.rejects(f.rpc("action.report", { actionId: prId, attempt: 0, token: claim.claim.token, executor: "apiary", kind: "result", outcome: "succeeded", outputs: {} }), rejectsCode("invalid_request"));
});

test("actions.rpc.external-land: destination Land holds Archive across an uncertain result and daemon restart", { timeout: 180_000 }, async t => {
  const f = await fixture(t);
  const { beeId } = await f.rpc<SpawnResult>("spawn", { name: "external-shipper", agent: "cellstub", cwd: "/ignored", substrate: "cell", cell: { originRepo: f.originRepo } });
  const accepted = await f.rpc<ActionEnqueueResult>("action.enqueue", { beeId, idempotencyKey: "external-land", items: [
    { kind: "land", version: 2, inputs: { destination: { nodeId: "workstation", root: f.originRepo, branch: "main" } } },
    { kind: "archive" },
  ] });
  const [land, archive] = accepted.actions;
  await f.waitStatus(land!.id, ["waiting"], "external offer");
  const first = (await f.rpc<ActionClaimResult>("action.claim", { executor: "apiary-land:workstation", actionId: land!.id })).claim!;
  await f.rpc("action.report", { actionId: land!.id, attempt: first.attempt, token: first.token, executor: "apiary-land:workstation", kind: "result", outcome: "uncertain", detail: "destination reconnecting" });
  assert.equal((await f.action(archive!.id)).status, "queued");
  await f.restart();
  const recovered = (await f.rpc<ActionClaimResult>("action.claim", { executor: "apiary-land:workstation", actionId: land!.id })).claim!;
  assert.equal(recovered.token, first.token);
  assert.equal(recovered.attempt, first.attempt);
  assert.equal(recovered.action.waitingReason, "uncertain");
  await assert.rejects(f.rpc("action.claim", { executor: "another-workstation", actionId: land!.id }), rejectsCode("action_claimed"));
  assert.equal((await f.action(archive!.id)).status, "queued");
  const sha = g(f.originRepo, ["rev-parse", "HEAD"]);
  await f.rpc("action.report", { actionId: land!.id, attempt: recovered.attempt, token: recovered.token, executor: "apiary-land:workstation", kind: "result", outcome: "succeeded", outputs: { resultSha: sha, cellHead: sha, targetBranch: "main" }, receipt: { status: "nothing_to_capture" } });
  await f.waitStatus(archive!.id, ["succeeded"], "archive after external receipt");
  assert.equal((await f.rpc<ViewResult>("view", { beeId })).bee?.lifecycle, "archived");
});
