/**
 * v23 session handoff over REAL disposable daemons (stub-backed "claude" /
 * "codex" agents, real runner hosts, real session-log files). Covers the
 * RPC contract (validation, idempotency, typed refusals), same- and
 * cross-family handoffs of idle/working/stopped sources, Cell sources with
 * dirty files, unavailable target accounts, disconnect after acceptance,
 * daemon SIGKILL during stopping and starting, queued-mail ordering, and
 * transcript reconstruction from published segments.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pidAlive } from "../../driver-hsr/src/psutil.ts";
import { makeOrigin } from "../../driver-cell/tests/helpers.ts";
import { renderTranscriptLines } from "../../driver-tmux/src/index.ts";
import { HANDOFF_SEED_MARKER } from "../../core/src/index.ts";
import type {
  AccountAddResult,
  BeeHandoffGetResult,
  BeeHandoffResult,
  DeployInfoResult,
  MailboxResult,
  SendRpcResult,
  SnapshotResult,
  SpawnResult,
  ViewResult,
} from "../src/protocol.ts";
import { RpcClient } from "../../cli/src/client.ts";
import { AGENT_PATH, makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const cellAgent = fileURLToPath(new URL("../../driver-cell/test-agent/agent.mjs", import.meta.url));

interface Fixture {
  root: string;
  daemon: DaemonHandle;
  client: RpcClient;
  rpc: <T>(verb: Parameters<RpcClient["request"]>[0], params: Record<string, unknown>) => Promise<T>;
  restart: () => Promise<void>;
  spawnIdle: (name: string, agent: string, extra?: Record<string, unknown>) => Promise<ViewResult>;
  view: (beeId: string) => Promise<ViewResult>;
  waitPhase: (handoffId: string, phases: string[], what: string) => Promise<BeeHandoffGetResult>;
  sessionLines: (path: string | null) => Array<Record<string, unknown>>;
}

async function fixture(t: TestContext, opts: { cells?: boolean; stubEnv?: Record<string, string> } = {}): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "hb-handoff-rpc-"));
  const stubSpec = (sessionId: string, agentPath = AGENT_PATH) => ({
    command: process.execPath,
    args: [agentPath],
    adapter: "stub" as const,
    env: { STUB_SESSION_ID: sessionId, STUB_TURN_MS: "10", ...(opts.stubEnv ?? {}) },
  });
  const cellsRoot = join(root, "cells");
  mkdirSync(cellsRoot);
  const rig = makeDaemonDir({
    ...(opts.cells ? { cells: { root: cellsRoot } } : {}),
    agents: {
      stub: stubSpec("stub-session"),
      claude: stubSpec("claude-session", opts.cells ? cellAgent : AGENT_PATH),
      codex: stubSpec("codex-session", opts.cells ? cellAgent : AGENT_PATH),
    },
  });
  let daemon = await startDaemon(rig.dir);
  let client = await daemon.client();
  t.after(async () => {
    client.close();
    await daemon.stop();
    rig.cleanup();
    rmSync(root, { recursive: true, force: true });
  });
  const f: Fixture = {
    root,
    get daemon() { return daemon; },
    get client() { return client; },
    rpc: (verb, params) => client.request(verb, params, 30_000),
    restart: async () => {
      await daemon.kill();
      client.close();
      daemon = await startDaemon(rig.dir);
      client = await daemon.client();
    },
    spawnIdle: async (name, agent, extra = {}) => {
      const spawned = await client.request<SpawnResult>("spawn", { name, agent, cwd: root, ...extra });
      return waitFor(async () => {
        const v = await client.request<ViewResult>("view", { beeId: spawned.beeId });
        return v.view.runtimeState === "idle" ? v : null;
      }, `${name} idle`, 60_000);
    },
    view: (beeId) => client.request<ViewResult>("view", { beeId }),
    waitPhase: (handoffId, phases, what) => waitFor(async () => {
      const r = await client.request<BeeHandoffGetResult>("bee.handoff.get", { handoffId });
      if (r.phase === "failed" && !phases.includes("failed")) assert.fail(`${what}: handoff failed ${JSON.stringify(r.failure)}`);
      return phases.includes(r.phase) ? r : null;
    }, what, 60_000),
    sessionLines: (path) => {
      if (!path || !existsSync(path)) return [];
      return readFileSync(path, "utf8").split("\n").flatMap((line) => {
        try { return line ? [JSON.parse(line) as Record<string, unknown>] : []; } catch { return []; }
      });
    },
  };
  return f;
}

function handoffRequest(v: ViewResult, target: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    beeId: v.bee!.id,
    idempotencyKey: (extra.idempotencyKey as string | undefined) ?? `h-${v.bee!.id}`,
    expected: { generation: v.runtime!.generation, agent: v.bee!.agent },
    target,
    ...extra,
  };
}

const rejectsCode = (code: string) => (error: unknown) => error instanceof Error && "code" in error && (error as { code: string }).code === code;

test("handoff.rpc.replay-defaults: omitted target defaults stay bound to the original source after later switches", { timeout: 180_000 }, async (t) => {
  const f = await fixture(t);
  const account = await f.rpc<AccountAddResult>("account.add", { harness: "codex", label: "replay", idempotencyKey: "replay-account" });
  mkdirSync(account.account.homePath, { recursive: true });
  writeFileSync(join(account.account.homePath, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture", refresh_token: "fixture" } }));
  const before = await f.spawnIdle("replay", "claude", { args: ["--model", "opus"] });
  const request = handoffRequest(before, { agent: "codex" }, { idempotencyKey: "replay-defaults" });
  const first = await f.rpc<BeeHandoffResult>("bee.handoff", request);
  assert.equal(first.to.account, account.account.id);
  await f.waitPhase(first.id, ["complete"], "first handoff complete");
  const replay = await f.rpc<BeeHandoffResult>("bee.handoff", request);
  assert.equal(replay.id, first.id);
  assert.equal(replay.deduped, true);

  const current = await f.view(before.bee!.id);
  const next = await f.rpc<BeeHandoffResult>("bee.handoff", handoffRequest(current,
    { agent: "claude", args: ["--model", "sonnet"], account: null },
    { idempotencyKey: "later-switch" }));
  await f.waitPhase(next.id, ["complete"], "later handoff complete");
  const afterLaterSwitch = await f.rpc<BeeHandoffResult>("bee.handoff", request);
  assert.equal(afterLaterSwitch.id, first.id);
  assert.equal(afterLaterSwitch.deduped, true);
  await assert.rejects(f.rpc("bee.handoff", { ...request, instruction: "different request" }), rejectsCode("idempotency_conflict"));
  await assert.rejects(f.rpc("bee.handoff", { ...request, expected: { generation: 99 } }), rejectsCode("idempotency_conflict"));
});

test("handoff.rpc: capability, validation, idempotency, typed refusals, and unavailable target accounts", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t);
  const info = await f.rpc<DeployInfoResult>("deployInfo", {});
  assert.ok(info.capabilities.includes("bee.handoff.v1"));
  const v = await f.spawnIdle("val", "claude");
  await assert.rejects(f.rpc("bee.handoff", { ...handoffRequest(v, { agent: "codex" }), idempotencyKey: undefined }), rejectsCode("invalid_request"));
  await assert.rejects(f.rpc("bee.handoff", handoffRequest(v, { agent: "nope" })), rejectsCode("invalid_request"));
  await assert.rejects(f.rpc("bee.handoff", handoffRequest(v, { agent: "codex", args: "x" })), rejectsCode("invalid_request"));
  await assert.rejects(f.rpc("bee.handoff", handoffRequest(v, { agent: "codex" }, { stopAt: "later" })), rejectsCode("invalid_request"));
  await assert.rejects(f.rpc("bee.handoff", { ...handoffRequest(v, { agent: "codex" }), expected: { generation: 9 } }), rejectsCode("stale_generation"));
  await assert.rejects(f.rpc("bee.handoff", { ...handoffRequest(v, { agent: "codex" }), expected: { generation: 1, agent: "codex" } }), rejectsCode("stale_generation"));
  await assert.rejects(f.rpc("bee.handoff", { ...handoffRequest(v, { agent: "codex" }), beeId: "missing" }), rejectsCode("bee_not_found"));
  await assert.rejects(f.rpc("bee.handoff.get", { handoffId: "nope" }), rejectsCode("handoff_not_found"));
  // Unavailable target account: the only codex account is paused → auto has nothing; explicit is refused as paused.
  const paused = await f.rpc<AccountAddResult>("account.add", { harness: "codex", label: "paused", idempotencyKey: "acct" });
  await f.rpc("account.pause", { id: paused.account.id });
  await assert.rejects(f.rpc("bee.handoff", handoffRequest(v, { agent: "codex" })), rejectsCode("account_unavailable"));
  await assert.rejects(f.rpc("bee.handoff", handoffRequest(v, { agent: "codex", account: paused.account.id })), rejectsCode("account_paused"));
  await assert.rejects(f.rpc("bee.handoff", handoffRequest(v, { agent: "codex", account: "missing-account" })), rejectsCode("account_not_found"));
  // Every refusal above left the source untouched: still claude, same generation, no receipt.
  const untouched = await f.view(v.bee!.id);
  assert.equal(untouched.bee?.agent, "claude");
  assert.equal(untouched.bee?.activeHandoffId, null);
  assert.equal(untouched.handoff, null);
  assert.equal(untouched.runtime?.generation, v.runtime?.generation);
  // Unbound target account is an explicit choice.
  const admitted = await f.rpc<BeeHandoffResult>("bee.handoff", handoffRequest(v, { agent: "codex", account: null }, { instruction: "carry on" }));
  assert.equal(admitted.phase, "stopping");
  assert.equal(admitted.to.account, null);
  const replay = await f.rpc<BeeHandoffResult>("bee.handoff", handoffRequest(v, { agent: "codex", account: null }, { instruction: "carry on" }));
  assert.equal(replay.id, admitted.id);
  assert.equal(replay.deduped, true);
  await assert.rejects(f.rpc("bee.handoff", handoffRequest(v, { agent: "codex", account: null }, { instruction: "different" })), rejectsCode("idempotency_conflict"));
  await assert.rejects(f.rpc("bee.handoff", handoffRequest(v, { agent: "codex", account: null }, { idempotencyKey: "second" })), rejectsCode("handoff_in_progress"));
  const done = await f.waitPhase(admitted.id, ["complete"], "unbound cross-family handoff");
  assert.equal(done.to.account, null);
  assert.equal((await f.view(v.bee!.id)).bee?.account, null);
});

test("handoff.rpc.cross-family: claude → codex on an idle hsr bee keeps identity, mailbox order, and publishes parseable segments", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t);
  const codexAccount = await f.rpc<AccountAddResult>("account.add", { harness: "codex", label: "main", idempotencyKey: "codex-acct" });
  const v = await f.spawnIdle("xf", "claude", { args: ["--model", "opus"], tags: ["apiary:workspace=w1"], env: { CLAUDE_CONFIG_DIR: join(f.root, "claude-home") } });
  assert.equal(v.bee?.providerSessionId, "claude-session");
  const hello = await f.rpc<SendRpcResult>("send", { beeId: v.bee!.id, body: "hello source" });
  await waitFor(async () => (await f.rpc<MailboxResult>("mailbox", { beeId: v.bee!.id })).messages.find((m) => m.id === hello.messageId)?.deliveredAt != null, "hello delivered");
  const releaseFile = join(f.root, "release-source");
  const held = await f.rpc<SendRpcResult>("send", { beeId: v.bee!.id, body: `@wait-file:${releaseFile}` });
  await waitFor(async () => (await f.rpc<MailboxResult>("mailbox", { beeId: v.bee!.id })).messages.find((m) => m.id === held.messageId)?.deliveredAt != null, "held source turn delivered");
  await waitFor(async () => (await f.view(v.bee!.id)).view.working, "source held before handoff");
  const segment0Path = (await f.view(v.bee!.id)).bee!.sessionLogPath!;
  const admitted = await f.rpc<BeeHandoffResult>("bee.handoff", handoffRequest(v, { agent: "codex", account: codexAccount.account.id }, { instruction: "switch to codex and continue" }));
  const q1 = await f.rpc<SendRpcResult>("send", { beeId: v.bee!.id, body: "queued A", idempotencyKey: "qa" });
  const q2 = await f.rpc<SendRpcResult>("send", { beeId: v.bee!.id, body: "queued B", urgency: "now", idempotencyKey: "qb" });
  // Hold the source until both messages exist, so the context snapshot must
  // contain both regardless of RPC scheduling or host load.
  writeFileSync(releaseFile, "release");
  const done = await f.waitPhase(admitted.id, ["complete"], "cross-family handoff");
  const after = await f.view(v.bee!.id);
  // Identity + placement preserved; execution ownership moved.
  assert.equal(after.bee?.id, v.bee?.id);
  assert.equal(after.bee?.handle, v.bee?.handle);
  assert.equal(after.bee?.name, "xf");
  assert.deepEqual(after.bee?.tags, ["apiary:workspace=w1"]);
  assert.equal(after.bee?.cwd, v.bee?.cwd);
  assert.equal(after.bee?.agent, "codex");
  assert.equal(after.bee?.args, null, "cross-family: source-harness args are dropped unless given");
  assert.equal(after.bee?.account, codexAccount.account.id, "bound to the explicit TARGET-harness account");
  assert.equal(done.to.account, codexAccount.account.id);
  assert.equal(after.bee?.env.CLAUDE_CONFIG_DIR, undefined, "the source harness home does not leak into the target env");
  assert.equal(after.bee?.env.CODEX_HOME, codexAccount.account.homePath, "the target account home is installed");
  assert.equal(after.bee?.providerSessionId, "codex-session", "the target reported its OWN thread");
  assert.equal(after.runtime?.generation, v.runtime!.generation + 1);
  assert.equal(after.runtime?.state, "idle");
  assert.equal(after.handoff?.id, done.id);
  assert.equal(after.handoff?.phase, "complete");
  assert.deepEqual(done.context?.mailbox.queuedMessageIds, [q1.messageId, q2.messageId]);
  assert.ok(done.context?.mailbox.summarizedMessageIds.includes(hello.messageId));
  // Mailbox: seed delivered first on the target generation, then the queued mail in enqueue order.
  const mailbox = await f.rpc<MailboxResult>("mailbox", { beeId: v.bee!.id });
  await waitFor(async () => (await f.rpc<MailboxResult>("mailbox", { beeId: v.bee!.id })).messages.filter((m) => m.deliveredAt == null).length === 0, "all mail delivered");
  const delivered = (await f.rpc<MailboxResult>("mailbox", { beeId: v.bee!.id })).messages
    .filter((m) => m.deliveredGeneration === after.runtime!.generation)
    .sort((a, b) => a.deliveredAt! - b.deliveredAt! || a.id - b.id)
    .map((m) => m.id);
  assert.deepEqual(delivered, [done.seedMessageId, q1.messageId, q2.messageId]);
  assert.equal(mailbox.messages.find((m) => m.id === hello.messageId)?.deliveredGeneration, v.runtime?.generation);
  // Segments: one per harness, each with its own file, thread, generation range, and stable ordinal.
  const snapshot = await f.rpc<SnapshotResult>("snapshot", {});
  const segments = snapshot.transcriptSegments.filter((s) => s.beeId === v.bee!.id).sort((a, b) => a.ordinal - b.ordinal);
  assert.deepEqual(
    segments.map((s) => [s.ordinal, s.harness, s.providerSessionId, s.fromGeneration, s.toGeneration, s.handoffId]),
    [[0, "claude", "claude-session", v.runtime!.generation, v.runtime!.generation, null], [1, "codex", "codex-session", v.runtime!.generation + 1, null, done.id]],
  );
  assert.equal(segments[0]!.path, segment0Path);
  assert.equal(after.bee?.sessionLogPath, segments[1]!.path);
  assert.notEqual(segments[1]!.path, segments[0]!.path);
  assert.ok(snapshot.beeHandoffs.some((h) => h.id === done.id));
  // Transcript reconstruction: parse each segment with ITS harness, in ordinal order.
  const seg0 = f.sessionLines(segments[0]!.path);
  const seg1 = f.sessionLines(segments[1]!.path);
  assert.ok(seg0.some((e) => e.type === "message" && e.id === hello.messageId), "source segment holds the pre-handoff delivery");
  assert.equal(seg0.some((e) => e.type === "message" && e.id === done.seedMessageId), false, "the seed never lands in the source harness's log");
  const seedLine = seg1.find((e) => e.type === "message" && e.id === done.seedMessageId) as { body: string } | undefined;
  assert.ok(seedLine?.body.startsWith(HANDOFF_SEED_MARKER));
  assert.ok(seedLine?.body.includes("switch to codex and continue"));
  assert.ok(seedLine?.body.includes("hello source"), "delivered source mail is part of the summarized context");
  assert.deepEqual(seg1.filter((e) => e.type === "message").map((e) => e.id), [done.seedMessageId, q1.messageId, q2.messageId]);
  const rendered = [...segments].flatMap((s) => renderTranscriptLines(s.harness === "codex" || s.harness === "claude" ? "stub" : s.harness, readFileSync(s.path!, "utf8").split("\n")));
  assert.ok(rendered.some((turn) => turn.role === "assistant" && turn.text === "echo:hello source"));
  assert.ok(rendered.some((turn) => turn.role === "assistant" && turn.text.startsWith(`echo:${HANDOFF_SEED_MARKER}`)));
  assert.ok(rendered.findIndex((turn) => turn.text === "echo:hello source") < rendered.findIndex((turn) => turn.text === "echo:queued A"));
});

test("handoff.rpc.same-family: a context reset keeps args unless replaced, opens a fresh thread, and stays on the account", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t);
  const account = await f.rpc<AccountAddResult>("account.add", { harness: "claude", label: "main", idempotencyKey: "acct" });
  const v = await f.spawnIdle("same", "claude", { args: ["--model", "opus"], account: account.account.id });
  assert.equal(v.bee?.account, account.account.id);
  const admitted = await f.rpc<BeeHandoffResult>("bee.handoff", handoffRequest(v, { agent: "claude" }));
  assert.deepEqual(admitted.to.args, ["--model", "opus"]);
  assert.equal(admitted.to.account, account.account.id);
  const done = await f.waitPhase(admitted.id, ["complete"], "same-family reset");
  const after = await f.view(v.bee!.id);
  assert.equal(after.bee?.agent, "claude");
  assert.deepEqual(after.bee?.args, ["--model", "opus"]);
  assert.equal(after.bee?.account, account.account.id);
  assert.equal(after.runtime?.generation, v.runtime!.generation + 1);
  assert.equal(done.from.providerSessionId, "claude-session");
  // Replacement args on a second reset.
  const again = await f.rpc<BeeHandoffResult>("bee.handoff", handoffRequest(after, { agent: "claude", args: ["--model", "sonnet"] }, { idempotencyKey: "second" }));
  await f.waitPhase(again.id, ["complete"], "second reset");
  assert.deepEqual((await f.view(v.bee!.id)).bee?.args, ["--model", "sonnet"]);
  assert.equal((await f.rpc<SnapshotResult>("snapshot", {})).transcriptSegments.filter((s) => s.beeId === v.bee!.id).length, 3);
});

test("handoff.rpc.working+stopped: stopAt=idle waits for the running turn, stopAt=now stops a hung turn, a stopped source hands off", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t);
  const busy = await f.spawnIdle("busy", "claude");
  await f.rpc("send", { beeId: busy.bee!.id, body: "@slow:2500" });
  await waitFor(async () => (await f.view(busy.bee!.id)).view.working, "source turn running");
  const admitted = await f.rpc<BeeHandoffResult>("bee.handoff", handoffRequest(busy, { agent: "codex" }));
  const mid = await f.rpc<BeeHandoffGetResult>("bee.handoff.get", { handoffId: admitted.id });
  assert.equal(mid.phase, "stopping");
  assert.equal((await f.view(busy.bee!.id)).view.working, true, "the running turn is not cut short");
  const done = await f.waitPhase(admitted.id, ["complete"], "idle-boundary handoff of a working source");
  assert.equal(done.to.agent, "codex");
  assert.equal((await f.view(busy.bee!.id)).bee?.agent, "codex");

  const hung = await f.spawnIdle("hung", "claude");
  await f.rpc("send", { beeId: hung.bee!.id, body: "@hang" });
  await waitFor(async () => (await f.view(hung.bee!.id)).view.working, "hung turn running");
  const now = await f.rpc<BeeHandoffResult>("bee.handoff", handoffRequest(hung, { agent: "codex" }, { stopAt: "now" }));
  const doneNow = await f.waitPhase(now.id, ["complete"], "immediate handoff of a hung source");
  assert.equal(doneNow.stopAt, "now");
  assert.equal((await f.view(hung.bee!.id)).bee?.agent, "codex");

  const stopped = await f.spawnIdle("stopped", "codex");
  await f.rpc("stop", { beeId: stopped.bee!.id });
  const off = await waitFor(async () => {
    const view = await f.view(stopped.bee!.id);
    return view.runtime?.state === "stopped" ? view : null;
  }, "source stopped");
  const fromStopped = await f.rpc<BeeHandoffResult>("bee.handoff", handoffRequest(off, { agent: "claude" }));
  await f.waitPhase(fromStopped.id, ["complete"], "handoff of a stopped source");
  const revived = await f.view(stopped.bee!.id);
  assert.equal(revived.bee?.agent, "claude");
  assert.equal(revived.runtime?.generation, off.runtime!.generation + 1);
  assert.equal(revived.runtime?.state, "idle");
});

test("handoff.rpc.disconnect+crash: a lost response replays to the same operation; SIGKILL during stopping and starting resumes", { timeout: 180_000 }, async (t) => {
  const f = await fixture(t, { stubEnv: { STUB_SURVIVE_STDIN_CLOSE: "1" } });
  const v = await f.spawnIdle("dc", "claude");
  const releaseFile = join(f.root, "release-after-restart");
  await f.rpc("send", { beeId: v.bee!.id, body: `@wait-file:${releaseFile}` });
  await waitFor(async () => (await f.view(v.bee!.id)).view.working, "source turn running");
  const sourcePid = (await f.view(v.bee!.id)).runtime!.pid!;
  // Disconnect right after sending the request (before the response).
  const lost = await f.daemon.client();
  const request = handoffRequest(v, { agent: "codex" }, { idempotencyKey: "lost-response" });
  const pending = lost.request<BeeHandoffResult>("bee.handoff", request).catch(() => null);
  lost.close();
  await pending;
  const replay = await waitFor(async () => {
    try {
      return await f.rpc<BeeHandoffResult>("bee.handoff", request);
    } catch (error) {
      if (rejectsCode("handoff_in_progress")(error)) return null;
      throw error;
    }
  }, "replay after disconnect");
  assert.equal(replay.phase, "stopping");
  // Crash the daemon while the source turn is still running (stopping): the detached source survives and is re-adopted.
  await f.restart();
  assert.ok(pidAlive(sourcePid), "source runner host survived the daemon");
  const afterBoot = await f.rpc<BeeHandoffResult>("bee.handoff", request);
  assert.equal(afterBoot.id, replay.id);
  assert.equal(afterBoot.deduped, true);
  writeFileSync(releaseFile, "release");
  const starting = await f.waitPhase(replay.id, ["starting", "complete"], "switch after restart");
  // Crash again during starting.
  await f.restart();
  const done = await f.waitPhase(replay.id, ["complete"], "completion after second restart");
  assert.equal(done.id, starting.id);
  const after = await f.view(v.bee!.id);
  assert.equal(after.bee?.agent, "codex");
  assert.equal(after.runtime?.state, "idle");
  await waitFor(() => !pidAlive(sourcePid), "source process gone", 20_000);
  assert.equal((await f.rpc<BeeHandoffResult>("bee.handoff", request)).deduped, true);
});

test("handoff.rpc.cell: a Cell bee hands off in place — same Cell, cwd, dirty files, one runtime in the checkout", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t, { cells: true });
  const origin = makeOrigin(f.root);
  const spawned = await f.rpc<SpawnResult>("spawn", { name: "cellbee", agent: "claude", substrate: "cell", cell: { originRepo: origin.repo } });
  const v = await waitFor(async () => {
    const view = await f.view(spawned.beeId);
    return view.view.runtimeState === "idle" ? view : null;
  }, "cell bee idle", 60_000);
  assert.equal(v.bee?.substrate, "cell");
  assert.ok(v.cell && v.cell.state === "active");
  writeFileSync(join(v.cell.spaceDir, "dirty.txt"), "uncommitted work\n");
  const before = await f.rpc<SendRpcResult>("send", { beeId: v.bee!.id, body: "@sh echo pre > pre.txt" });
  await waitFor(async () => existsSync(join(v.cell!.spaceDir, "pre.txt")), "source wrote in the cell");
  const admitted = await f.rpc<BeeHandoffResult>("bee.handoff", handoffRequest(v, { agent: "codex" }));
  const post = await f.rpc<SendRpcResult>("send", { beeId: v.bee!.id, body: "@sh pwd > where.txt" });
  const done = await f.waitPhase(admitted.id, ["complete"], "cell handoff");
  await waitFor(async () => existsSync(join(v.cell!.spaceDir, "where.txt")), "target wrote in the same cell");
  const after = await f.view(v.bee!.id);
  assert.equal(after.bee?.substrate, "cell");
  assert.equal(after.bee?.cwd, v.bee?.cwd);
  assert.equal(after.bee?.cellId, v.bee?.cellId);
  assert.equal(after.cell?.state, "active");
  assert.equal(after.bee?.placementVersion, v.bee?.placementVersion);
  assert.equal(after.bee?.agent, "codex");
  assert.equal(readFileSync(join(v.cell!.spaceDir, "dirty.txt"), "utf8"), "uncommitted work\n");
  assert.equal(readFileSync(join(v.cell!.spaceDir, "pre.txt"), "utf8").trim(), "pre");
  assert.equal(readFileSync(join(v.cell!.spaceDir, "where.txt"), "utf8").trim().endsWith(v.cell!.spaceName), true, "target runtime runs inside the Cell checkout");
  const mailbox = await f.rpc<MailboxResult>("mailbox", { beeId: v.bee!.id });
  assert.equal(mailbox.messages.find((m) => m.id === before.messageId)?.deliveredGeneration, v.runtime?.generation);
  assert.equal(mailbox.messages.find((m) => m.id === post.messageId)?.deliveredGeneration, after.runtime?.generation);
  assert.equal(mailbox.messages.find((m) => m.id === done.seedMessageId)?.deliveredGeneration, after.runtime?.generation);
});
