/**
 * Spec 08 at the RPC tier — a REAL daemon process over a temp socket:
 *  - account CRUD verbs + typed errors (account_not_found, account_referenced,
 *    account_paused, harness_mismatch, account_unavailable); one-key
 *    idempotency on account.add/account.capture; explicit recovery capture
 *    validates the current credential and snapshots it into the vault;
 *    snapshot/watch carry accounts + limits
 *  - spawn {account}: explicit → bees.account + home env in the runtime's
 *    env; paused / mismatch refused; 'auto' resolves BEFORE createBee (never
 *    stored) and short-circuits a lone candidate; null = unbound
 *  - bee.swapAccount (fake-claude): stop → rebind → revive with resume; the
 *    conversation resumes under a NEW session id (--fork-session); the next
 *    message is delivered on the new generation in the new home; cross-harness
 *    refused; a stopped bee is rebound only
 *  - automatic rotation on exhaustion (fake-claude @ratelimit): resource_blocked
 *    → selection excludes the current account → swap → the next turn continues
 *    on the new account; `autoswap=false` opt-out honored; no candidate → flagged,
 *    no loop; auth_needed evidence → account status + bee flag
 * SAFETY: temp dirs only (vault/homes inside the daemon dir); never ~/.hive,
 * never a real harness; HIVE_NO_KEYCHAIN in the daemon env.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcError, type ListResult, type MailboxResult, type SendRpcResult, type SnapshotResult, type SpawnResult, type ViewResult, type WatchFrame } from "../src/protocol.ts";
import type {
  AccountAddResult,
  AccountBackfillResult,
  AccountCaptureResult,
  AccountGetResult,
  AccountLimitsResult,
  AccountResetLimitsResult,
  AccountListResult,
  AccountLoginStartResult,
  AccountRemoveResult,
  AccountUpdateResult,
  AccountVerifyResult,
  AccountAdmissionAcquireResult,
  AccountAdmissionConfirmResult,
  AccountActivityResult,
  SwapAccountResult,
} from "../src/protocol.ts";
import { openCoreStore, type MirrorAccountRow } from "../../core/src/index.ts";
import type { RpcClient } from "../../cli/src/client.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";
import { claudeProjectKey } from "../../driver-tmux/src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(here, "..", "..", "driver-hsr", "test-agent", "fake-claude.mjs");

function jsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as T);
}

async function rejects(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof RpcError, `expected RpcError, got ${String(err)}`);
    assert.equal(err.code, code, err.message);
    return;
  }
  assert.fail(`expected ${code}`);
}

async function waitState(client: RpcClient, beeId: string, state: string, what: string): Promise<ViewResult> {
  return waitFor(async () => {
    const v = await client.request<ViewResult>("view", { beeId });
    return v.view.runtimeState === state ? v : null;
  }, what, 12_000);
}

async function waitDelivered(client: RpcClient, beeId: string, messageId: number, what: string): Promise<number> {
  return (await waitFor(async () => {
    const { messages } = await client.request<MailboxResult>("mailbox", { beeId });
    const m = messages.find((x) => x.id === messageId);
    return m?.deliveredAt != null ? m.deliveredGeneration : null;
  }, what, 12_000)) as number;
}

/** Seed a vault entry so the account counts as credentialed. */
function seedVault(dir: string, harness: string, id: string, file: string, content = "{}"): void {
  const d = join(dir, "vault", harness, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, file), content);
}

test("rpc.accounts.1: CRUD verbs, typed errors, idempotent add, spawn binding (explicit / paused / mismatch / auto / unbound), snapshot + watch carry accounts", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const watch = await daemon.client();
    const frames: WatchFrame[] = [];
    watch.onEvent = (f: WatchFrame) => frames.push(f);
    await watch.request("watch");

    // add (default id + home), get, list, idempotent replay
    const added = await client.request<AccountAddResult>("account.add", { harness: "stub", label: "Alpha One", idempotencyKey: "acct-add-1" });
    assert.equal(added.account.id, "stub-alpha-one");
    assert.equal(added.account.homePath, join(dir, "homes", "stub-alpha-one"));
    assert.equal(added.account.status, "ok");
    const replay = await client.request<AccountAddResult>("account.add", { harness: "stub", label: "Alpha One", idempotencyKey: "acct-add-1" });
    assert.equal(replay.deduped, true);
    assert.equal(replay.account.id, "stub-alpha-one");
    await rejects(() => client.request("account.add", { harness: "stub", label: "Alpha One" }), "invalid_request");
    const two = await client.request<AccountAddResult>("account.add", { harness: "stub", label: "two", penalty: 10, homePath: join(dir, "custom-home") });
    assert.equal(two.account.penalty, 10);
    assert.equal(two.account.homePath, join(dir, "custom-home"));
    const codex = await client.request<AccountAddResult>("account.add", { harness: "codex", label: "cx" });
    mkdirSync(codex.account.homePath, { recursive: true });
    const currentCredential = '{"tokens":{"access_token":"fresh"}}';
    writeFileSync(join(codex.account.homePath, "auth.json"), currentCredential);
    const captured = await client.request<AccountCaptureResult>("account.capture", { id: "codex-cx", idempotencyKey: "acct-capture-1" });
    assert.equal(captured.source, "home");
    assert.deepEqual(captured.captured, ["auth.json"]);
    assert.equal(captured.account.status, "ok");
    assert.ok(captured.account.lastLoginAt !== null);
    assert.equal(readFileSync(join(dir, "vault", "codex", "codex-cx", "auth.json"), "utf8"), currentCredential);
    const captureReplay = await client.request<AccountCaptureResult>("account.capture", { id: "codex-cx", idempotencyKey: "acct-capture-1" });
    assert.equal(captureReplay.deduped, true);
    assert.equal(captureReplay.at, captured.at);
    const list = await client.request<AccountListResult>("account.list");
    assert.deepEqual(list.accounts.map((a) => a.id).sort(), ["codex-cx", "stub-alpha-one", "stub-two"]);
    assert.deepEqual((await client.request<AccountListResult>("account.list", { harness: "stub" })).accounts.map((a) => a.id).sort(), ["stub-alpha-one", "stub-two"]);
    await rejects(() => client.request("account.get", { id: "nope" }), "account_not_found");
    const got = await client.request<AccountGetResult>("account.get", { id: "stub-two" });
    assert.equal(got.credentialed, true, "the stub harness has no recipe: always credentialed");
    assert.equal(got.loginFlow, null);
    assert.deepEqual(got.bees, []);

    // pause / unpause / penalty
    const paused = await client.request<AccountUpdateResult>("account.pause", { id: "stub-two" });
    assert.equal(paused.account.status, "paused");
    assert.equal((await client.request<AccountUpdateResult>("account.pause", { id: "stub-two" })).applied, false);
    const pen = await client.request<AccountUpdateResult>("account.setPenalty", { id: "stub-two", penalty: 33 });
    assert.equal(pen.account.penalty, 33);
    await rejects(() => client.request("account.setPenalty", { id: "stub-two", penalty: 101 }), "invalid_request");

    // spawn: explicit paused → refused; mismatch → refused; unknown → not found
    await rejects(() => client.request("spawn", { name: "p", agent: "stub", cwd: dir, account: "stub-two" }), "account_paused");
    await rejects(() => client.request("spawn", { name: "p", agent: "stub", cwd: dir, account: "codex-cx" }), "harness_mismatch");
    await rejects(() => client.request("spawn", { name: "p", agent: "stub", cwd: dir, account: "nope" }), "account_not_found");
    assert.equal((await client.request<ListResult>("list")).views.length, 0, "refusals mint no bee");
    // explicit ok → bees.account + home env (stub has no home env var: env stays empty, binding recorded)
    const explicit = await client.request<SpawnResult>("spawn", { name: "e", agent: "stub", cwd: dir, account: "stub-alpha-one" });
    assert.equal(explicit.account, "stub-alpha-one");
    const ev = await client.request<ViewResult>("view", { beeId: explicit.beeId });
    assert.equal(ev.bee?.account, "stub-alpha-one");
    // auto (default): stub-two is paused → the lone candidate is alpha-one; never 'auto' in the row
    const auto = await client.request<SpawnResult>("spawn", { name: "a", agent: "stub", cwd: dir });
    assert.equal(auto.account, "stub-alpha-one");
    assert.match(auto.accountReason ?? "", /only stub account with credentials/);
    assert.equal((await client.request<ViewResult>("view", { beeId: auto.beeId })).bee?.account, "stub-alpha-one");
    // null → unbound
    const unbound = await client.request<SpawnResult>("spawn", { name: "u", agent: "stub", cwd: dir, account: null });
    assert.equal(unbound.account, null);
    // all paused → auto refuses (typed), explicit-null still spawns
    await client.request("account.pause", { id: "stub-alpha-one" });
    await rejects(() => client.request("spawn", { name: "x", agent: "stub", cwd: dir }), "account_unavailable");
    await client.request("account.unpause", { id: "stub-alpha-one" });
    // remove refused while referenced; ok after the bees are deleted
    await rejects(() => client.request("account.remove", { id: "stub-alpha-one" }), "account_referenced");
    const gotRef = await client.request<AccountGetResult>("account.get", { id: "stub-alpha-one" });
    assert.deepEqual(gotRef.bees.sort(), [explicit.beeId, auto.beeId].sort());
    const removed = await client.request<AccountRemoveResult>("account.remove", { id: "stub-two" });
    assert.equal(removed.account.id, "stub-two");
    await rejects(() => client.request("account.remove", { id: "stub-two" }), "account_not_found");
    // backfill verb round-trips (nothing to bind here)
    const bf = await client.request<AccountBackfillResult>("account.backfill", { dryRun: true });
    assert.deepEqual(bf.bound, []);
    // snapshot + watch
    const snap = await client.request<SnapshotResult>("snapshot");
    assert.deepEqual(snap.accounts.map((a) => a.id).sort(), ["codex-cx", "stub-alpha-one"]);
    assert.deepEqual(snap.accountLimits, []);
    await waitFor(() => frames.some((f) => f.type === "delta" && f.events.some((e) => e.kind === "account.put")), "account.put in the watch stream");
    await waitFor(() => frames.some((f) => f.type === "delta" && f.events.some((e) => e.kind === "account.removed")), "account.removed in the watch stream");
    watch.close();
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    cleanup();
  }
});

test("rpc.accounts.fuzzy: one selector works across account verbs, spawn agent shorthand, explicit override, and swap", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    await client.request("account.add", { harness: "stub", label: "owner@gmail.com", id: "stub-personal" });
    await client.request("account.add", { harness: "stub", label: "owner@company.com", id: "stub-work" });
    await client.request("account.add", { harness: "stub", label: "remove-me", id: "stub-archive" });
    await client.request("account.add", { harness: "codex", label: "coder@gmail.com", id: "codex-personal" });

    const got = await client.request<AccountGetResult>("account.get", { id: "stub-gmail" });
    assert.equal(got.account.id, "stub-personal");

    assert.equal((await client.request<AccountUpdateResult>("account.pause", { id: "COMPANY" })).account.id, "stub-work");
    assert.equal((await client.request<AccountUpdateResult>("account.unpause", { id: "stub-company" })).account.id, "stub-work");
    const penalty = await client.request<AccountUpdateResult>("account.setPenalty", { id: "company", penalty: 17 });
    assert.equal(penalty.account.id, "stub-work");
    assert.equal(penalty.account.penalty, 17);
    const limits = await client.request<AccountLimitsResult>("account.limits", { id: "company" });
    assert.deepEqual(limits.limits.map((row) => row.account), ["stub-work"]);
    // Stub intentionally has no login recipe. `invalid_request` (instead of
    // account_not_found) proves the fuzzy selector reached that harness gate.
    // v16: a harness without a login recipe gets a flow row carrying the typed
    // refusal (never an RPC error, never a terminal); capture still refuses.
    const refused = await client.request<AccountLoginStartResult>("account.login", { id: "stub-company" });
    assert.equal(refused.flow.phase, "failed");
    assert.equal(refused.flow.error?.code, "unsupported_method");
    await rejects(() => client.request("account.capture", { id: "stub-company" }), "invalid_request");

    // Embedded selector: the daemon normalizes the concrete agent and binds
    // the fuzzy account before creating the bee row.
    const embedded = await client.request<SpawnResult>("spawn", { name: "fuzzy", agent: "stub-gmail", cwd: dir });
    assert.equal(embedded.agent, "stub");
    assert.equal(embedded.account, "stub-personal");
    const embeddedView = await client.request<ViewResult>("view", { beeId: embedded.beeId });
    assert.equal(embeddedView.bee?.agent, "stub");
    assert.equal(embeddedView.bee?.account, "stub-personal");

    // Explicit account selection still wins over the account embedded in the
    // agent token, while the harness portion is normalized consistently.
    const overridden = await client.request<SpawnResult>("spawn", {
      name: "override",
      agent: "stub-gmail",
      account: "company",
      cwd: dir,
    });
    assert.equal(overridden.agent, "stub");
    assert.equal(overridden.account, "stub-work");

    const swap = await client.request<SwapAccountResult>("bee.swapAccount", { beeId: embedded.beeId, account: "stub-company" });
    assert.equal(swap.to, "stub-work");
    const removed = await client.request<AccountRemoveResult>("account.remove", { id: "REMOVE" });
    assert.equal(removed.account.id, "stub-archive");

    await rejects(() => client.request("account.get", { id: "gmail" }), "invalid_request");
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    cleanup();
  }
});

test("rpc account.resetLimits: duplicate keys return one effect; uncertain and wrong-harness failures stay typed", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    const stub = join(dir, "codex-reset-stub");
    const calls = join(dir, "reset-calls.jsonl");
    writeFileSync(stub, [
      "#!/usr/bin/env node",
      "const fs = require('node:fs'); const readline = require('node:readline');",
      `const calls = ${JSON.stringify(calls)};`,
      "readline.createInterface({input:process.stdin}).on('line', line => { const m=JSON.parse(line); if(m.id===1) console.log(JSON.stringify({id:1,result:{}})); if(m.id===2){ fs.appendFileSync(calls, JSON.stringify(m.params)+'\\n'); console.log(JSON.stringify({id:2,result:{outcome:'reset'}})); } if(m.id===3) console.log(JSON.stringify({id:3,result:{rateLimits:{primary:{usedPercent:0,windowDurationMins:300}},rateLimitResetCredits:{availableCount:0,credits:[]}}})); });",
    ].join("\n"));
    chmodSync(stub, 0o700);
    const configPath = join(dir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    config.agents = { ...(config.agents as object), codex: { command: stub, adapter: "codex" } };
    writeFileSync(configPath, JSON.stringify(config));

    daemon = await startDaemon(dir);
    const client = await daemon.client();
    await client.request("account.add", { harness: "codex", label: "reset", id: "codex-reset" });
    await client.request("account.add", { harness: "stub", label: "wrong", id: "stub-wrong" });
    const first = await client.request<AccountResetLimitsResult>("account.resetLimits", { id: "codex-reset", creditId: "credit-1", idempotencyKey: "reset-key" });
    const duplicate = await client.request<AccountResetLimitsResult>("account.resetLimits", { id: "codex-reset", creditId: "credit-1", idempotencyKey: "reset-key" });
    assert.equal(first.outcome, "reset");
    assert.equal(duplicate.deduped, true);
    assert.deepEqual(first.limits.rateLimitResetCredits, { availableCount: 0, credits: [] });
    assert.deepEqual(jsonl<{ idempotencyKey: string; creditId: string }>(calls), [{ idempotencyKey: "reset-key", creditId: "credit-1" }]);
    await rejects(() => client.request("account.resetLimits", { id: "stub-wrong", idempotencyKey: "wrong-key" }), "harness_mismatch");
    await rejects(() => client.request("account.resetLimits", { id: "codex-reset" }), "invalid_request");
    writeFileSync(stub, readFileSync(stub, "utf8").replace("outcome:'reset'", "outcome:'futureOutcome'"));
    await rejects(() => client.request("account.resetLimits", { id: "codex-reset", idempotencyKey: "retry-key" }), "provider_outcome_uncertain");
    await rejects(() => client.request("account.resetLimits", { id: "codex-reset", idempotencyKey: "retry-key" }), "provider_outcome_uncertain");
    assert.deepEqual(jsonl<{ idempotencyKey: string }>(calls).map((call) => call.idempotencyKey), ["reset-key", "retry-key", "retry-key"], "uncertain failures are not stored as successful dedup results");
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    cleanup();
  }
});

test("rpc.accounts.2: bee.swapAccount (fake-claude) — same-harness stop → rebind → revive with resume under a NEW session id in the new home; cross-harness refused; stopped bee rebound only", async () => {
  const argvLog = join(makeDaemonDir().dir, "argv.jsonl");
  const { dir, cleanup } = makeDaemonDir({
    agents: {
      claude: {
        command: process.execPath,
        args: [FAKE_CLAUDE, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
        adapter: "claude",
        env: { FAKE_CLAUDE_ARGV_LOG: argvLog },
      },
    },
  });
  let daemon: DaemonHandle | null = null;
  try {
    // two claude accounts with vault credentials (activation copies them into the empty homes)
    seedVault(dir, "claude", "claude-a", ".credentials.json", '{"claudeAiOauth":{"accessToken":"a","expiresAt":1}}');
    seedVault(dir, "claude", "claude-b", ".credentials.json", '{"claudeAiOauth":{"accessToken":"b","expiresAt":1}}');
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    // Pre-seeded vaults = existing credentials: adoption is explicit (F2).
    await client.request("account.add", { harness: "claude", label: "a", importExisting: true });
    await client.request("account.add", { harness: "claude", label: "b", importExisting: true });
    await client.request("account.add", { harness: "codex", label: "c" });
    const homeA = join(dir, "homes", "claude-a");
    const homeB = join(dir, "homes", "claude-b");

    const spawned = await client.request<SpawnResult>("spawn", { name: "mover", agent: "claude", cwd: dir, account: "claude-a" });
    const first = await client.request<SendRpcResult>("send", { beeId: spawned.beeId, body: "hello" });
    await waitDelivered(client, spawned.beeId, first.messageId, "first delivered");
    await waitState(client, spawned.beeId, "idle", "idle after hello");
    const sid1 = (await client.request<ViewResult>("view", { beeId: spawned.beeId })).bee?.providerSessionId;
    assert.ok(sid1, "session id recorded");
    // activation happened into home A (empty → vault copy + defaults); the runtime saw CLAUDE_CONFIG_DIR = home A
    assert.equal(readFileSync(join(homeA, ".credentials.json"), "utf8"), '{"claudeAiOauth":{"accessToken":"a","expiresAt":1}}');
    assert.ok(existsSync(join(homeA, "settings.json")));
    const boots1 = jsonl<{ env: { CLAUDE_CONFIG_DIR: string | null }; resumed: string | null; forked: boolean; sessionId: string }>(argvLog);
    assert.equal(boots1.length, 1);
    assert.equal(boots1[0]?.env.CLAUDE_CONFIG_DIR, homeA);

    // cross-harness refused, typed; paused refused
    await rejects(() => client.request("bee.swapAccount", { beeId: spawned.beeId, account: "codex-c" }), "harness_mismatch");
    await client.request("account.pause", { id: "claude-b" });
    await rejects(() => client.request("bee.swapAccount", { beeId: spawned.beeId, account: "claude-b" }), "account_paused");
    await client.request("account.unpause", { id: "claude-b" });
    await rejects(() => client.request("bee.swapAccount", { beeId: spawned.beeId, account: "nope" }), "account_not_found");

    // the swap: stop → rebind (+ rekey for claude) → revive with --resume <sid1> --fork-session
    const swap = await client.request<SwapAccountResult>("bee.swapAccount", { beeId: spawned.beeId, account: "claude-b", idempotencyKey: "swap-1" });
    assert.equal(swap.action, "stop_then_revive");
    assert.equal(swap.from, "claude-a");
    assert.equal(swap.to, "claude-b");
    assert.equal(swap.rekeyed, true);
    assert.ok(swap.commandId);
    // The CLI resolves the resume seed inside ITS config dir only: the
    // conversation is carried into home B before generation 2 forks it
    // (without this, gen 2 dies on "No conversation found with session ID").
    assert.equal(swap.transcript, "copied");
    const projectKey = claudeProjectKey(dir);
    assert.ok(existsSync(join(homeA, "projects", projectKey, `${sid1}.jsonl`)), "fake-claude wrote the source transcript on the first turn");
    assert.ok(existsSync(join(homeB, "projects", projectKey, `${sid1}.jsonl`)), "the transcript was carried into home B");
    const replay = await client.request<SwapAccountResult>("bee.swapAccount", { beeId: spawned.beeId, account: "claude-b", idempotencyKey: "swap-1" });
    assert.equal(replay.deduped, true);
    // the operator continues the conversation: the message rides the swap and
    // is delivered to generation 2, which boots in home B and reports a NEW
    // session id (claude stream-json emits its init only on the first message)
    const second = await client.request<SendRpcResult>("send", { beeId: spawned.beeId, body: "again" });
    assert.equal(await waitDelivered(client, spawned.beeId, second.messageId, "second delivered"), 2);
    const gen2 = await waitFor(async () => {
      const v = await client.request<ViewResult>("view", { beeId: spawned.beeId });
      return v.view.generation === 2 && v.view.runtimeState !== "stopped" && v.bee?.providerSessionId && v.bee.providerSessionId !== sid1 ? v : null;
    }, "generation 2 with a fresh session id", 15_000);
    assert.equal(gen2.bee?.account, "claude-b");
    assert.equal(gen2.bee?.env.CLAUDE_CONFIG_DIR, homeB);
    assert.equal(gen2.bee?.forkSeed, null, "seed consumed once the fork's own id is known");
    await waitState(client, spawned.beeId, "idle", "idle on generation 2");
    const boots2 = jsonl<{ env: { CLAUDE_CONFIG_DIR: string | null }; resumed: string | null; forked: boolean; sessionId: string }>(argvLog);
    assert.equal(boots2.length, 2);
    assert.equal(boots2[1]?.env.CLAUDE_CONFIG_DIR, homeB);
    assert.equal(boots2[1]?.resumed, sid1, "resumes the source conversation");
    assert.equal(boots2[1]?.forked, true, "…under a new session (--fork-session)");
    assert.equal(readFileSync(join(homeB, ".credentials.json"), "utf8"), '{"claudeAiOauth":{"accessToken":"b","expiresAt":1}}', "home B activated from ITS vault entry");
    // swapping to the same account is a no-op
    const noop = await client.request<SwapAccountResult>("bee.swapAccount", { beeId: spawned.beeId, account: "claude-b" });
    assert.equal(noop.action, "noop");
    // a stopped bee is only rebound; its next wake runs on the new account
    await client.request("stop", { beeId: spawned.beeId });
    await waitState(client, spawned.beeId, "stopped", "stopped");
    const back = await client.request<SwapAccountResult>("bee.swapAccount", { beeId: spawned.beeId, account: "claude-a" });
    assert.equal(back.action, "rebind_only");
    assert.equal(back.commandId, null);
    const rebound = await client.request<ViewResult>("view", { beeId: spawned.beeId });
    assert.equal(rebound.bee?.account, "claude-a");
    assert.equal(rebound.bee?.env.CLAUDE_CONFIG_DIR, homeA);
    assert.equal(rebound.view.runtimeState, "stopped");
    // rebind_only carries the conversation too — the next wake forks it in home A
    const sid2 = gen2.bee?.providerSessionId as string;
    assert.equal(back.transcript, "copied");
    assert.ok(existsSync(join(homeA, "projects", projectKey, `${sid2}.jsonl`)));
    assert.equal(rebound.bee?.forkSeed, sid2, "rekeyed: the next wake forks sid2");
    // a seed with no transcript anywhere refuses the swap, typed, and leaves the bee untouched
    rmSync(join(homeA, "projects", projectKey, `${sid2}.jsonl`));
    rmSync(join(homeB, "projects", projectKey, `${sid2}.jsonl`));
    await rejects(() => client.request("bee.swapAccount", { beeId: spawned.beeId, account: "claude-b" }), "transcript_unavailable");
    const untouched = await client.request<ViewResult>("view", { beeId: spawned.beeId });
    assert.equal(untouched.bee?.account, "claude-a");
    assert.equal(untouched.bee?.env.CLAUDE_CONFIG_DIR, homeA);
    assert.equal(untouched.bee?.forkSeed, sid2, "no rekey, no rebind");
    client.close();
  } finally {
    if (process.env.HB_DEBUG && existsSync(join(dir, "hived.log"))) process.stderr.write(readFileSync(join(dir, "hived.log"), "utf8"));
    if (daemon) await daemon.stop();
    cleanup();
  }
});

test("rpc allocation owner: acquire is authoritative, claim swap is atomic, and all-protected returns account_wait", async () => {
  const seed = (dir: string, targetUsed: number) => {
    const now = Date.now();
    const store = openCoreStore(join(dir, "core.sqlite3"), { ephemeral: true });
    for (const [id, used] of [["stub-source", 5], ["stub-target", targetUsed]] as const) {
      store.createAccount({ id, harness: "stub", homePath: join(dir, "homes", id), label: id });
      store.putAccountLimits(id, {
        readable: true,
        fetchedAt: now,
        fiveHour: { usedPercent: used, resetsAt: now + 4 * 60 * 60_000, windowMinutes: 300 },
        weekly: { usedPercent: used, resetsAt: now + 6 * 24 * 60 * 60_000, windowMinutes: 10_080 },
      });
    }
    store.close();
  };

  const successRig = makeDaemonDir({ accounts: { allocationMode: "active", allocationNodeId: "worker-1", allocationOwner: { node: "worker-1", epoch: "owner-v1" } } });
  let successDaemon: DaemonHandle | null = null;
  try {
    seed(successRig.dir, 5);
    successDaemon = await startDaemon(successRig.dir);
    const client = await successDaemon.client();
    const spawned = await client.request<SpawnResult>("spawn", { name: "owner-swap", agent: "stub", cwd: successRig.dir, account: "stub-source" });
    const context = { version: 1, authority: { node: "worker-1", epoch: "owner-v1" }, scope: "stub:provider-accounts", revision: "fleet-1", observedAt: Date.now(), complete: true, accounts: [] };
    await assert.rejects(
      client.request("bee.swapAccount", {
        beeId: spawned.beeId, account: "auto", allocationContext: context, idempotencyKey: "direct-auto-is-not-shared",
      }),
      (error: unknown) => error instanceof RpcError && error.code === "account_wait"
        && (error.details?.allocation as { reason?: string } | undefined)?.reason === "allocation_owner_required",
    );
    const current = await client.request<ViewResult>("view", { beeId: spawned.beeId });
    const acquired = await client.request<AccountAdmissionAcquireResult>("account.admission.acquire", {
      harness: "stub",
      operation: "swap",
      target: { node: "worker-1", workId: spawned.beeId, expectedGeneration: current.runtime?.generation ?? 0 },
      sourceAccount: "stub-source",
      allocationContext: context,
      idempotencyKey: "owner-acquire-swap-1",
    });
    assert.equal(acquired.authoritative, true);
    assert.equal(acquired.claim?.account, "stub-target");
    assert.equal(acquired.claim?.target.workId, spawned.beeId);
    const swapped = await client.request<SwapAccountResult>("bee.swapAccount", {
      beeId: spawned.beeId, account: "auto", allocationClaim: acquired.claim, idempotencyKey: "worker-apply-swap-1",
    });
    assert.equal(swapped.to, "stub-target");
    assert.equal(swapped.allocation?.mode, "active");
    assert.equal(swapped.allocationClaimId, acquired.claim?.id);
    await assert.rejects(
      client.request("account.admission.release", {
        claimId: acquired.claim?.id, reason: "lost apply reply", idempotencyKey: "cannot-release-applied-swap",
      }),
      (error: unknown) => error instanceof RpcError && error.code === "account_claim_refused",
    );
    const confirmed = await client.request<AccountAdmissionConfirmResult>("account.admission.confirm", {
      claimId: acquired.claim?.id,
      target: { node: "worker-1", workId: spawned.beeId },
      idempotencyKey: "owner-confirm-swap-1",
    });
    assert.equal(confirmed.status, "confirmed");
    const snapshot = await client.request<SnapshotResult>("snapshot");
    assert.equal(snapshot.accountAdmissions.length, 1);
    assert.ok(snapshot.accountAdmissions[0]?.confirmedAt);
    const replay = await client.request<SwapAccountResult>("bee.swapAccount", {
      beeId: spawned.beeId, account: "auto", allocationClaim: acquired.claim, idempotencyKey: "worker-apply-swap-1",
    });
    assert.equal(replay.deduped, true);
    assert.equal(replay.to, swapped.to);
    client.close();
  } finally {
    await successDaemon?.stop();
    successRig.cleanup();
  }

  const waitRig = makeDaemonDir({ accounts: { allocationMode: "active", allocationNodeId: "owner-wait", allocationOwner: { node: "owner-wait", epoch: "owner-v1" } } });
  let waitDaemon: DaemonHandle | null = null;
  try {
    seed(waitRig.dir, 95);
    waitDaemon = await startDaemon(waitRig.dir);
    const client = await waitDaemon.client();
    const spawned = await client.request<SpawnResult>("spawn", { name: "owner-wait", agent: "stub", cwd: waitRig.dir, account: "stub-source" });
    const context = { version: 1, authority: { node: "owner-wait", epoch: "owner-v1" }, scope: "stub:provider-accounts", revision: "fleet-2", observedAt: Date.now(), complete: true, accounts: [] };
    await assert.rejects(
      client.request("account.admission.acquire", {
        harness: "stub", operation: "swap", target: { node: "worker-2", workId: spawned.beeId, expectedGeneration: 0 },
        sourceAccount: "stub-source", excludeAccountIds: ["stub-source"], allocationContext: context,
        idempotencyKey: "owner-auto-wait-1",
      }),
      (error: unknown) => error instanceof RpcError
        && error.code === "account_wait"
        && (error.details?.allocation as { reason?: string } | undefined)?.reason === "completion_reserve",
    );
    assert.equal((await client.request<SnapshotResult>("snapshot")).accountAdmissions.length, 0, "a wait never reserves or rebinds");

    const protectedExplicit = await client.request<SpawnResult>("spawn", {
      name: "protected-explicit", agent: "stub", cwd: waitRig.dir, account: "stub-target",
    });
    await client.request("stop", { beeId: protectedExplicit.beeId });
    await waitState(client, protectedExplicit.beeId, "stopped", "explicit protected bee stops");
    await client.request("revive", { beeId: protectedExplicit.beeId });
    const resumed = await waitState(client, protectedExplicit.beeId, "idle", "existing protected bee resumes");
    assert.equal(resumed.bee?.account, "stub-target", "continuations on an existing identity bypass new-work admission");
    await rejects(() => client.request("revive", { beeId: "forged-continuation" }), "bee_not_found");
    client.close();
  } finally {
    await waitDaemon?.stop();
    waitRig.cleanup();
  }
});

test("rpc allocation owner serializes concurrent node admissions and a remote node consumes one claim once", async () => {
  const ownerRig = makeDaemonDir({ accounts: { allocationMode: "active", allocationNodeId: "owner-node", allocationOwner: { node: "owner-node", epoch: "owner-v1" } } });
  const workerRig = makeDaemonDir({ accounts: { allocationMode: "active", allocationNodeId: "worker-real", allocationOwner: { node: "owner-node", epoch: "owner-v1" } } });
  let ownerDaemon: DaemonHandle | null = null;
  let workerDaemon: DaemonHandle | null = null;
  const seed = (dir: string) => {
    const now = Date.now();
    const store = openCoreStore(join(dir, "core.sqlite3"), { ephemeral: true });
    for (const [id, used] of [["stub-source", 5], ["stub-target", 88]] as const) {
      store.createAccount({ id, harness: "stub", homePath: join(dir, "homes", id), label: id });
      store.putAccountLimits(id, {
        readable: true,
        fetchedAt: now,
        fiveHour: { usedPercent: 5, resetsAt: now + 4 * 60 * 60_000, windowMinutes: 300 },
        weekly: { usedPercent: used, resetsAt: now + 24 * 60 * 60_000, windowMinutes: 10_080 },
      });
    }
    store.close();
  };
  try {
    seed(ownerRig.dir);
    seed(workerRig.dir);
    ownerDaemon = await startDaemon(ownerRig.dir);
    workerDaemon = await startDaemon(workerRig.dir);
    let owner = await ownerDaemon.client();
    const worker = await workerDaemon.client();
    const spawned = await worker.request<SpawnResult>("spawn", {
      name: "remote-worker", agent: "stub", cwd: workerRig.dir, account: "stub-source",
    });
    const view = await worker.request<ViewResult>("view", { beeId: spawned.beeId });
    const generation = view.runtime?.generation ?? 0;
    const context = { version: 1, authority: { node: "owner-node", epoch: "owner-v1" }, scope: "stub:provider-accounts", revision: "two-workers-same-owner", observedAt: Date.now(), complete: true, accounts: [
      { account: "stub-source", active: 1, recent: 0, pending: 0, ongoingUnits: 1 },
    ] };
    await assert.rejects(
      worker.request("account.admission.acquire", {
        harness: "stub", operation: "swap", target: { node: "wrong-owner", workId: spawned.beeId, expectedGeneration: generation },
        sourceAccount: "stub-source", allocationContext: context, idempotencyKey: "consumer-cannot-acquire",
      }),
      (error: unknown) => error instanceof RpcError && error.code === "account_wait"
        && (error.details?.allocation as { reason?: string } | undefined)?.reason === "allocation_owner_required",
    );
    const requests = ["node-a", "node-b"].map((node, index) => owner.request<AccountAdmissionAcquireResult>("account.admission.acquire", {
      harness: "stub", operation: "swap", target: { node, workId: `${spawned.beeId}-${index}`, expectedGeneration: generation },
      sourceAccount: "stub-source", excludeAccountIds: ["stub-source"], allocationContext: context,
      idempotencyKey: `concurrent-owner-${index}`,
    }));
    const outcomes = await Promise.allSettled(requests);
    const granted = outcomes.filter((result): result is PromiseFulfilledResult<AccountAdmissionAcquireResult> => result.status === "fulfilled");
    const waited = outcomes.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.equal(granted.length, 1, "one SQLite owner serializes competing node reservations");
    assert.equal(waited.length, 1);
    assert.ok(waited[0]?.reason instanceof RpcError && waited[0].reason.code === "account_wait");

    const claim = granted[0]!.value.claim!;
    // Re-acquire for the real worker identity after releasing the deliberately
    // losing-race fixture claim.
    await owner.request("account.admission.release", {
      claimId: claim.id, reason: "test target identity was synthetic", idempotencyKey: "release-synthetic-claim",
    });
    const realAcquireParams = {
      harness: "stub", operation: "swap", target: { node: "worker-real", workId: spawned.beeId, expectedGeneration: generation },
      sourceAccount: "stub-source", excludeAccountIds: ["stub-source"], allocationContext: context,
      idempotencyKey: "remote-real-acquire",
    };
    const acquired = await owner.request<AccountAdmissionAcquireResult>("account.admission.acquire", realAcquireParams);
    owner.close();
    await ownerDaemon.stop();
    ownerDaemon = await startDaemon(ownerRig.dir);
    owner = await ownerDaemon.client();
    const replayedAcquire = await owner.request<AccountAdmissionAcquireResult>("account.admission.acquire", realAcquireParams);
    assert.equal(replayedAcquire.deduped, true);
    assert.equal(replayedAcquire.claim?.id, acquired.claim?.id, "the owner claim survives daemon restart and a lost reply");
    const swapped = await worker.request<SwapAccountResult>("bee.swapAccount", {
      beeId: spawned.beeId, account: "auto", allocationClaim: acquired.claim, idempotencyKey: "remote-real-apply",
    });
    assert.equal(swapped.to, "stub-target");
    await assert.rejects(
      worker.request("bee.swapAccount", {
        beeId: spawned.beeId, account: "auto", allocationClaim: acquired.claim, idempotencyKey: "remote-real-apply-again",
      }),
      (error: unknown) => error instanceof RpcError && error.code === "account_claim_refused",
    );
    const confirmed = await owner.request<AccountAdmissionConfirmResult>("account.admission.confirm", {
      claimId: acquired.claim!.id, target: { node: "worker-real", workId: spawned.beeId }, idempotencyKey: "remote-real-confirm",
    });
    assert.equal(confirmed.status, "confirmed");
    owner.close();
    worker.close();
  } finally {
    await workerDaemon?.stop();
    await ownerDaemon?.stop();
    workerRig.cleanup();
    ownerRig.cleanup();
  }
});

test("rpc allocation owner claim gates active automatic spawn while shadow acquisition remains observational", async () => {
  const activeRig = makeDaemonDir({ accounts: { allocationMode: "active", allocationNodeId: "active-node", allocationOwner: { node: "active-node", epoch: "owner-v1" } } });
  const shadowRig = makeDaemonDir();
  let activeDaemon: DaemonHandle | null = null;
  let shadowDaemon: DaemonHandle | null = null;
  const seed = (dir: string) => {
    const now = Date.now();
    const store = openCoreStore(join(dir, "core.sqlite3"), { ephemeral: true });
    store.createAccount({ id: "stub-only", harness: "stub", homePath: join(dir, "homes", "stub-only"), label: "only" });
    store.putAccountLimits("stub-only", {
      readable: true, fetchedAt: now,
      fiveHour: { usedPercent: 5, resetsAt: now + 4 * 60 * 60_000, windowMinutes: 300 },
      weekly: { usedPercent: 5, resetsAt: now + 6 * 24 * 60 * 60_000, windowMinutes: 10_080 },
    });
    store.close();
  };
  try {
    seed(activeRig.dir);
    seed(shadowRig.dir);
    activeDaemon = await startDaemon(activeRig.dir);
    shadowDaemon = await startDaemon(shadowRig.dir);
    const active = await activeDaemon.client();
    const shadow = await shadowDaemon.client();
    const targetId = "claimed-spawn-id";
    const activeContext = { version: 1, authority: { node: "active-node", epoch: "owner-v1" }, scope: "stub:provider-accounts", revision: "active-spawn", observedAt: Date.now(), complete: true, accounts: [] };
    await assert.rejects(
      active.request("spawn", { id: "unclaimed-spawn", name: "unclaimed", agent: "stub", cwd: activeRig.dir, account: "auto", allocationContext: activeContext }),
      (error: unknown) => error instanceof RpcError && error.code === "account_wait",
    );
    const acquired = await active.request<AccountAdmissionAcquireResult>("account.admission.acquire", {
      harness: "stub", operation: "spawn", target: { node: "active-node", workId: targetId, expectedGeneration: 0 },
      allocationContext: activeContext, idempotencyKey: "claimed-spawn-acquire",
    });
    await assert.rejects(
      active.request("spawn", {
        id: targetId, name: "wrong-owner", agent: "stub", cwd: activeRig.dir, account: "auto",
        allocationClaim: { ...acquired.claim!, authority: { node: "active-node", epoch: "old-owner" } },
        idempotencyKey: "claimed-spawn-wrong-owner",
      }),
      (error: unknown) => error instanceof RpcError && error.code === "account_claim_refused",
    );
    await assert.rejects(
      active.request("spawn", {
        id: targetId, name: "wrong-target", agent: "stub", cwd: activeRig.dir, account: "auto",
        allocationClaim: { ...acquired.claim!, target: { ...acquired.claim!.target, node: "other-node" } },
        idempotencyKey: "claimed-spawn-wrong-target",
      }),
      (error: unknown) => error instanceof RpcError && error.code === "account_claim_refused",
    );
    await assert.rejects(
      active.request("spawn", {
        id: targetId, name: "keyless-claim", agent: "stub", cwd: activeRig.dir, account: "auto",
        allocationClaim: acquired.claim,
      }),
      (error: unknown) => error instanceof RpcError && error.code === "invalid_request",
    );
    await assert.rejects(
      active.request("spawn", {
        id: targetId, name: "wrong-model", agent: "stub", cwd: activeRig.dir, account: "auto",
        args: ["--model", "Fable"], allocationClaim: acquired.claim, idempotencyKey: "claimed-spawn-wrong-model",
      }),
      (error: unknown) => error instanceof RpcError && error.code === "account_claim_refused",
    );
    const spawned = await active.request<SpawnResult>("spawn", {
      id: targetId, name: "claimed", agent: "stub", cwd: activeRig.dir, account: "auto",
      allocationClaim: acquired.claim, idempotencyKey: "claimed-spawn-apply",
    });
    assert.equal(spawned.account, "stub-only");
    assert.equal(spawned.allocationClaimId, acquired.claim?.id);
    const activity = await active.request<AccountActivityResult>("account.activity", { harness: "stub" });
    assert.equal(activity.node, "active-node");
    assert.deepEqual(activity.authority, { node: "active-node", epoch: "owner-v1" });
    assert.equal(activity.scope, "stub:provider-accounts");
    assert.ok(activity.freshUntil > activity.observedAt);
    assert.ok(activity.accounts[0]?.observedClaimIds?.includes(acquired.claim!.id));

    const shadowContext = { ...activeContext, revision: "shadow-spawn", observedAt: Date.now() };
    const observed = await shadow.request<AccountAdmissionAcquireResult>("account.admission.acquire", {
      harness: "stub", operation: "spawn", target: { node: "shadow-node", workId: "shadow-id", expectedGeneration: 0 },
      allocationContext: shadowContext, idempotencyKey: "shadow-observation",
    });
    assert.equal(observed.authoritative, false);
    assert.equal(observed.claim, null);
    assert.equal((await shadow.request<SnapshotResult>("snapshot")).accountAdmissions.length, 0);
    active.close();
    shadow.close();
  } finally {
    await shadowDaemon?.stop();
    await activeDaemon?.stop();
    shadowRig.cleanup();
    activeRig.cleanup();
  }
});

test("rpc.accounts.2b: bee.swapAccount clears stale auth_needed before the replacement generation presents as working", async () => {
  const { dir, cleanup } = makeDaemonDir({
    agents: {
      claude: {
        command: process.execPath,
        args: [FAKE_CLAUDE, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
        adapter: "claude",
      },
    },
  });
  let daemon: DaemonHandle | null = null;
  try {
    seedVault(dir, "claude", "claude-a", ".credentials.json", '{"claudeAiOauth":{"accessToken":"a","expiresAt":1}}');
    seedVault(dir, "claude", "claude-b", ".credentials.json", '{"claudeAiOauth":{"accessToken":"b","expiresAt":1}}');
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    await client.request("account.add", { harness: "claude", label: "a", importExisting: true });
    await client.request("account.add", { harness: "claude", label: "b", importExisting: true });

    const spawned = await client.request<SpawnResult>("spawn", {
      name: "auth-rotated",
      agent: "claude",
      cwd: dir,
      account: "claude-a",
      tags: ["autoswap=false"],
    });
    const first = await client.request<SendRpcResult>("send", { beeId: spawned.beeId, body: "establish transcript" });
    await waitDelivered(client, spawned.beeId, first.messageId, "first delivered");
    await waitState(client, spawned.beeId, "idle", "idle after first turn");

    const limited = await client.request<SendRpcResult>("send", { beeId: spawned.beeId, body: "@ratelimit preserve this flag" });
    await waitDelivered(client, spawned.beeId, limited.messageId, "rate-limit turn delivered");
    await waitFor(async () => {
      const v = await client.request<ViewResult>("view", { beeId: spawned.beeId });
      return v.view.flags.includes("resource_blocked") ? true : null;
    }, "resource_blocked set");

    const auth = await client.request<SendRpcResult>("send", { beeId: spawned.beeId, body: "@authfail" });
    await waitDelivered(client, spawned.beeId, auth.messageId, "authfail turn delivered");
    await waitFor(async () => {
      const account = await client.request<AccountGetResult>("account.get", { id: "claude-a" });
      return account.account.status === "auth_needed" ? true : null;
    }, "source account auth_needed");
    const before = await client.request<ViewResult>("view", { beeId: spawned.beeId });
    assert.deepEqual([...before.view.flags].sort(), ["auth_needed", "resource_blocked"]);

    const swap = await client.request<SwapAccountResult>("bee.swapAccount", {
      beeId: spawned.beeId,
      account: "claude-b",
      idempotencyKey: "swap-clears-auth",
    });
    assert.equal(swap.action, "stop_then_revive");
    assert.equal(swap.to, "claude-b");
    const replay = await client.request<SwapAccountResult>("bee.swapAccount", {
      beeId: spawned.beeId,
      account: "claude-b",
      idempotencyKey: "swap-clears-auth",
    });
    assert.equal(replay.deduped, true);

    const working = await waitFor(async () => {
      const v = await client.request<ViewResult>("view", { beeId: spawned.beeId });
      return v.view.generation === 2 && v.view.working ? v : null;
    }, "replacement generation working", 15_000);
    assert.equal(working.bee?.account, "claude-b");
    assert.deepEqual(working.view.flags, ["resource_blocked"]);
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    cleanup();
  }
});

test("rpc.accounts.3: automatic rotation on exhaustion (fake-claude @ratelimit) — swap to the untried account, the next turn continues there; opt-out honored; no candidate = flagged, no loop; auth_needed evidence → account status", async () => {
  const argvLog = join(makeDaemonDir().dir, "argv.jsonl");
  const { dir, cleanup } = makeDaemonDir({
    agents: {
      claude: {
        command: process.execPath,
        args: [FAKE_CLAUDE, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
        adapter: "claude",
        env: { FAKE_CLAUDE_ARGV_LOG: argvLog },
      },
    },
  });
  let daemon: DaemonHandle | null = null;
  try {
    seedVault(dir, "claude", "claude-a", ".credentials.json", '{"claudeAiOauth":{"accessToken":"a","expiresAt":1}}');
    seedVault(dir, "claude", "claude-b", ".credentials.json", '{"claudeAiOauth":{"accessToken":"b","expiresAt":1}}');
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    await client.request("account.add", { harness: "claude", label: "a", importExisting: true });
    await client.request("account.add", { harness: "claude", label: "b", importExisting: true });
    const homeB = join(dir, "homes", "claude-b");

    // 1) rotation: a bee on A hits the wall → swapped to B → next turn on B
    const bee = await client.request<SpawnResult>("spawn", { name: "rot", agent: "claude", cwd: dir, account: "claude-a" });
    const m1 = await client.request<SendRpcResult>("send", { beeId: bee.beeId, body: "warm up" });
    await waitDelivered(client, bee.beeId, m1.messageId, "warm up delivered");
    await waitState(client, bee.beeId, "idle", "idle");
    const m2 = await client.request<SendRpcResult>("send", { beeId: bee.beeId, body: "@ratelimit please" });
    await waitDelivered(client, bee.beeId, m2.messageId, "ratelimit delivered");
    const swapped = await waitFor(async () => {
      const v = await client.request<ViewResult>("view", { beeId: bee.beeId });
      return v.bee?.account === "claude-b" && v.view.generation === 2 && v.view.runtimeState !== "stopped" ? v : null;
    }, "rotated to claude-b on generation 2", 15_000);
    assert.equal(swapped.bee?.env.CLAUDE_CONFIG_DIR, homeB);
    // the exhausted account carries the evidence; the bee's flag was set by the adapter evidence
    const acctA = await client.request<AccountGetResult>("account.get", { id: "claude-a" });
    assert.ok(acctA.account.exhaustedAt, "exhaustion evidence recorded on the account");
    const m3 = await client.request<SendRpcResult>("send", { beeId: bee.beeId, body: "continue" });
    assert.equal(await waitDelivered(client, bee.beeId, m3.messageId, "continue delivered on gen 2"), 2);
    // a successful turn on B clears resource_blocked (contrary evidence)
    await waitFor(async () => {
      const v = await client.request<ViewResult>("view", { beeId: bee.beeId });
      return !v.view.flags.includes("resource_blocked") ? true : null;
    }, "resource_blocked cleared by the served turn");
    const boots = jsonl<{ env: { CLAUDE_CONFIG_DIR: string | null }; forked: boolean }>(argvLog);
    assert.equal(boots.length, 2);
    assert.equal(boots[1]?.env.CLAUDE_CONFIG_DIR, homeB);
    assert.equal(boots[1]?.forked, true);

    // 2) no candidate: B is now the only non-exhausted account for THIS bee… exhaust it too:
    //    A is inside its exhaustion cool-off → no candidate → the bee stays flagged on B, no loop
    const m4 = await client.request<SendRpcResult>("send", { beeId: bee.beeId, body: "@ratelimit again" });
    await waitDelivered(client, bee.beeId, m4.messageId, "second ratelimit delivered");
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId: bee.beeId })).view.flags.includes("resource_blocked") ? true : null, "flagged again");
    await new Promise((r) => setTimeout(r, 200));
    const stuck = await client.request<ViewResult>("view", { beeId: bee.beeId });
    assert.equal(stuck.bee?.account, "claude-b", "no rotation back onto the recently exhausted account");
    assert.equal(stuck.view.generation, 2);
    assert.ok(stuck.view.flags.includes("resource_blocked"), "stays visibly flagged");
    assert.match(daemon.output() + readFileSync(join(dir, "hived.log"), "utf8"), /account\.rotate bee=\S+ account=claude-b skipped=no_candidate/);

    // 3) opt-out: a bee tagged autoswap=false is never rotated
    const opt = await client.request<SpawnResult>("spawn", { name: "opt", agent: "claude", cwd: dir, account: "claude-a", tags: ["autoswap=false"] });
    const o1 = await client.request<SendRpcResult>("send", { beeId: opt.beeId, body: "@ratelimit" });
    await waitDelivered(client, opt.beeId, o1.messageId, "opt-out ratelimit delivered");
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId: opt.beeId })).view.flags.includes("resource_blocked") ? true : null, "opt-out flagged");
    await new Promise((r) => setTimeout(r, 150));
    const optView = await client.request<ViewResult>("view", { beeId: opt.beeId });
    assert.equal(optView.bee?.account, "claude-a");
    assert.equal(optView.view.generation, 1);
    assert.match(readFileSync(join(dir, "hived.log"), "utf8"), /account\.rotate bee=\S+ account=claude-a skipped=autoswap_disabled/);

    // 4) auth_needed evidence → account status + bee flag; a successful turn clears both
    const au = await client.request<SpawnResult>("spawn", { name: "au", agent: "claude", cwd: dir, account: "claude-b" });
    const a1 = await client.request<SendRpcResult>("send", { beeId: au.beeId, body: "@authfail" });
    await waitDelivered(client, au.beeId, a1.messageId, "authfail delivered");
    await waitFor(async () => (await client.request<AccountGetResult>("account.get", { id: "claude-b" })).account.status === "auth_needed" ? true : null, "account auth_needed");
    assert.ok((await client.request<ViewResult>("view", { beeId: au.beeId })).view.flags.includes("auth_needed"));
    const a2 = await client.request<SendRpcResult>("send", { beeId: au.beeId, body: "fine now" });
    await waitDelivered(client, au.beeId, a2.messageId, "authenticated turn delivered");
    await waitFor(async () => (await client.request<AccountGetResult>("account.get", { id: "claude-b" })).account.status === "ok" ? true : null, "account back to ok");
    await waitFor(async () => !(await client.request<ViewResult>("view", { beeId: au.beeId })).view.flags.includes("auth_needed") ? true : null, "bee flag cleared");
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    cleanup();
  }
});

test("rpc.accounts.f2: add refuses pre-existing credentials by default; importExisting adopts as unverified; health is validation evidence, never file-existence; a fresh add is auth_needed, never ok", async () => {
  // v18: the daemon's Codex probe must never reach a real `codex`; point it
  // at nothing so the scheduled verification fails typed (provider_error).
  const { dir, cleanup } = makeDaemonDir({ agents: { codex: { command: join("/nonexistent", "hive-test-codex") } } });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir, { env: { HOME: join(dir, "machine-home") } });
    const client = await daemon.client();

    // The F2 shape: a machine home that already holds harness credentials
    // (the wizard handing in ~/.codex). Default add must refuse — a fresh
    // account starts logged out, and adopting a stale login is a choice.
    const machineHome = join(dir, "machine-codex-home");
    mkdirSync(machineHome, { recursive: true });
    writeFileSync(join(machineHome, "auth.json"), '{"tokens":{"access_token":"stale-april"}}');
    await rejects(
      () => client.request("account.add", { harness: "codex", label: "adopt", homePath: machineHome }),
      "account_home_populated",
    );

    // A leftover vault entry for the id is the same silent import.
    seedVault(dir, "codex", "codex-ghost", "auth.json");
    await rejects(() => client.request("account.add", { harness: "codex", label: "ghost" }), "account_home_populated");

    // Explicit opt-in adopts — and the credential is UNVERIFIED, not ok-shaped.
    const adopted = await client.request<AccountAddResult>("account.add", {
      harness: "codex",
      label: "adopt",
      homePath: machineHome,
      importExisting: true,
    });
    assert.equal(adopted.credentialHealth, "unverified");
    assert.equal(adopted.account.credentialHealth, "unverified", "v18: the mirror row carries the derived health");
    assert.deepEqual(adopted.imported, { source: "home", from: machineHome, files: ["auth.json"] });
    assert.equal(adopted.verification, "limits");
    assert.equal(adopted.account.status, "ok", "a credential exists and nothing contradicts it yet");
    assert.equal(readFileSync(join(dir, "vault", "codex", "codex-adopt", "auth.json"), "utf8"), '{"tokens":{"access_token":"stale-april"}}', "the handed-in home is captured into the vault");
    const got = await client.request<AccountGetResult>("account.get", { id: adopted.account.id });
    assert.equal(got.credentialed, true);
    assert.equal(got.credentialHealth, "unverified", "a credential FILE existing is not health");

    // A default fresh add: empty home, empty vault, health absent — and v18:
    // status auth_needed (never ok without a credential), nothing to verify.
    const fresh = await client.request<AccountAddResult>("account.add", { harness: "codex", label: "fresh" });
    assert.equal(fresh.credentialHealth, "absent");
    assert.equal(fresh.account.status, "auth_needed");
    assert.equal(fresh.imported, null);
    assert.equal(fresh.verification, "none");
    const list = await client.request<AccountListResult>("account.list", { harness: "codex" });
    assert.equal(list.credentialHealth[adopted.account.id], "unverified");
    assert.equal(list.credentialHealth[fresh.account.id], "absent");
    assert.deepEqual(list.accounts.map((a) => [a.id, a.status, a.credentialHealth]).sort(), [["codex-adopt", "ok", "unverified"], ["codex-fresh", "auth_needed", "absent"]]);
    // pause/unpause keeps the truth: a logged-out account unpauses to auth_needed, not ok
    await client.request("account.pause", { id: fresh.account.id });
    const unpaused = await client.request<AccountUpdateResult>("account.unpause", { id: fresh.account.id });
    assert.equal(unpaused.account.status, "auth_needed");
    assert.equal(unpaused.account.credentialHealth, "absent");

    // The scheduled verification cannot reach a provider here: it settles as a
    // typed transient failure — status stays ok, health stays unverified.
    const settled = await waitFor(async () => {
      const g = await client.request<AccountGetResult>("account.get", { id: adopted.account.id });
      return g.limits ? g : null;
    }, "background verification settled", 12_000);
    assert.equal(settled.limits?.readable, false);
    assert.equal(settled.limits?.unreadableReason, "provider_error");
    assert.equal(settled.account.status, "ok");
    assert.equal(settled.credentialHealth, "unverified");
    // on demand: account.verify says exactly what the probe proved (idempotent by key)
    const verify = await client.request<AccountVerifyResult>("account.verify", { id: adopted.account.id, idempotencyKey: "verify-1" });
    assert.equal(verify.outcome, "unverified");
    assert.equal(verify.probe, "limits");
    assert.equal(verify.limits?.unreadableReason, "provider_error");
    assert.equal(verify.account.credentialHealth, "unverified");
    assert.equal((await client.request<AccountVerifyResult>("account.verify", { id: adopted.account.id, idempotencyKey: "verify-1" })).deduped, true);
    const stubAdd = await client.request<AccountAddResult>("account.add", { harness: "stub", label: "s" });
    assert.equal(stubAdd.verification, "unsupported", "a recipe-less harness has a credential by definition but no probe");
    const stubVerify = await client.request<AccountVerifyResult>("account.verify", { id: stubAdd.account.id });
    assert.deepEqual([stubVerify.outcome, stubVerify.probe, stubVerify.limits], ["unverified", "none", null]);
    const bareVerify = await client.request<AccountVerifyResult>("account.verify", { id: fresh.account.id });
    assert.deepEqual([bareVerify.outcome, bareVerify.probe], ["absent", "none"]);

    const agyHome = join(dir, "machine-agy-home");
    const agyToken = ".gemini/antigravity-cli/antigravity-oauth-token";
    mkdirSync(join(agyHome, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(join(agyHome, agyToken), "agy-oauth-token");
    const agy = await client.request<AccountAddResult>("account.add", {
      harness: "agy",
      label: "personal",
      homePath: agyHome,
      importExisting: true,
    });
    assert.equal(agy.verification, "credential_file");
    const agyVerify = await client.request<AccountVerifyResult>("account.verify", { id: agy.account.id });
    assert.equal(agyVerify.probe, "credential_file");
    assert.equal(agyVerify.outcome, "unverified");
    assert.equal(agyVerify.limits, null);

    // Real validation evidence upgrades honestly: an explicit capture
    // validates the credential and records the login.
    const captured = await client.request<AccountCaptureResult>("account.capture", { id: adopted.account.id });
    assert.ok(captured.account.lastLoginAt != null);
    assert.equal(captured.account.credentialHealth, "verified");
    const verified = await client.request<AccountGetResult>("account.get", { id: adopted.account.id });
    assert.equal(verified.credentialHealth, "verified");
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    cleanup();
  }
});

test("rpc.accounts.v18: importExisting imports the MACHINE's vendor home (the field finding); nothing importable is `no_credentials_to_import` naming the paths; snapshot + watch deltas carry credentialHealth; login success flips status", async () => {
  const machineHome = join(mkdtempSync(join(tmpdir(), "hb-v2-machine-")), "home");
  const { dir, cleanup } = makeDaemonDir({ agents: { codex: { command: join("/nonexistent", "hive-test-codex") } } });
  let daemon: DaemonHandle | null = null;
  try {
    mkdirSync(machineHome, { recursive: true });
    // The daemon's idea of $HOME is the fake machine home: ~/.codex lives there, never in the developer's real home.
    daemon = await startDaemon(dir, {
      env: { HOME: machineHome, CODEX_HOME: join(machineHome, ".codex") },
    });
    const client = await daemon.client();
    const watch = await daemon.client();
    const frames: WatchFrame[] = [];
    watch.onEvent = (f: WatchFrame) => frames.push(f);
    await watch.request("watch");

    // Nothing anywhere → typed refusal, no row, and the message names what was checked.
    try {
      await client.request("account.add", { harness: "codex", label: "nothing", importExisting: true });
      assert.fail("expected no_credentials_to_import");
    } catch (err) {
      assert.ok(err instanceof RpcError);
      assert.equal(err.code, "no_credentials_to_import");
      assert.ok(err.message.includes(`${join(machineHome, ".codex", "auth.json")} (missing)`), err.message);
      assert.ok(err.message.includes(`${join(dir, "vault", "codex", "codex-nothing", "auth.json")} (missing)`), err.message);
    }
    assert.equal((await client.request<AccountListResult>("account.list")).accounts.length, 0, "a refusal creates no logged-out account");

    // The field finding: ~/.codex/auth.json (real shape; a stale April session), CODEX_HOME unset.
    const codexAuth = '{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"id_token":"i","access_token":"a","refresh_token":"r","account_id":"acc"},"last_refresh":"2026-04-01T00:00:00Z"}';
    mkdirSync(join(machineHome, ".codex"), { recursive: true });
    writeFileSync(join(machineHome, ".codex", "auth.json"), codexAuth);
    writeFileSync(join(machineHome, ".codex", "config.toml"), 'model = "gpt-5.6"\n');
    const imported = await client.request<AccountAddResult>("account.add", { harness: "codex", label: "work", importExisting: true, idempotencyKey: "import-1" });
    assert.deepEqual(imported.imported, { source: "vendor_home", from: join(machineHome, ".codex"), files: ["auth.json", "config.toml"] });
    assert.equal(imported.verification, "limits");
    assert.equal(imported.account.status, "ok");
    assert.equal(imported.account.credentialHealth, "unverified");
    assert.equal(readFileSync(join(dir, "vault", "codex", "codex-work", "auth.json"), "utf8"), codexAuth);
    assert.equal(readFileSync(join(machineHome, ".codex", "auth.json"), "utf8"), codexAuth, "the vendor home is read, never modified");
    // replay-safe: the same key answers with the recorded result, no second import
    const replay = await client.request<AccountAddResult>("account.add", { harness: "codex", label: "work", importExisting: true, idempotencyKey: "import-1" });
    assert.equal(replay.deduped, true);
    assert.equal(replay.account.id, "codex-work");
    await rejects(() => client.request("account.add", { harness: "codex", label: "work", importExisting: true }), "invalid_request");
    // the spawn path now sees a credentialed account (the field failure was `No codex account has credentials`)
    const get = await client.request<AccountGetResult>("account.get", { id: "codex-work" });
    assert.equal(get.credentialed, true);
    const fresh = await client.request<AccountAddResult>("account.add", { harness: "codex", label: "fresh" });
    assert.equal(fresh.account.status, "auth_needed");

    // MIRROR CONTRACT: snapshot rows AND account.put deltas carry the derived health.
    const snap = await client.request<{ accounts: MirrorAccountRow[] }>("snapshot");
    assert.deepEqual(snap.accounts.map((a) => [a.id, a.status, a.credentialHealth]).sort(), [["codex-fresh", "auth_needed", "absent"], ["codex-work", "ok", "unverified"]]);
    const putsFor = (id: string): MirrorAccountRow[] =>
      frames.flatMap((f) => (f.type === "delta" ? f.events : [])).filter((e) => e.kind === "account.put" && (e.payload.account as MirrorAccountRow).id === id).map((e) => e.payload.account as MirrorAccountRow);
    await waitFor(() => (putsFor("codex-fresh").length > 0 && putsFor("codex-work").length > 0 ? true : null), "account.put deltas");
    assert.equal(putsFor("codex-work")[0]?.credentialHealth, "unverified");
    assert.equal(putsFor("codex-fresh")[0]?.credentialHealth, "absent");
    assert.equal(putsFor("codex-fresh")[0]?.status, "auth_needed");

    // Login success (the capture path records the login exactly like a finished flow): status ok, health verified — in the result AND the delta.
    mkdirSync(join(dir, "homes", "codex-fresh"), { recursive: true });
    writeFileSync(join(dir, "homes", "codex-fresh", "auth.json"), '{"tokens":{"access_token":"fresh-login"}}');
    const captured = await client.request<AccountCaptureResult>("account.capture", { id: "codex-fresh" });
    assert.equal(captured.account.status, "ok");
    assert.equal(captured.account.credentialHealth, "verified");
    await waitFor(() => (putsFor("codex-fresh").some((row) => row.credentialHealth === "verified" && row.status === "ok") ? true : null), "verified account.put delta");
    watch.close();
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    cleanup();
    rmSync(dirname(machineHome), { recursive: true, force: true });
  }
});

test("rpc.accounts: Codex usageLimitExceeded persists bee and account boundaries until successful recovery", async () => {
  const { dir, cleanup } = makeDaemonDir({ agents: { codex: {
    command: process.execPath,
    args: [join(here, "..", "..", "driver-hsr", "test-agent", "fake-codex.mjs")],
    adapter: "codex",
  } } });
  let daemon: DaemonHandle | null = null;
  try {
    seedVault(dir, "codex", "codex-quota", "auth.json", '{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"id_token":"i","access_token":"a","refresh_token":"r","account_id":"acc"}}');
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    await client.request("account.add", { harness: "codex", label: "quota", importExisting: true });
    const bee = await client.request<SpawnResult>("spawn", { name: "quota", agent: "codex", cwd: dir, account: "codex-quota", tags: ["autoswap=false"] });
    const message = await client.request<SendRpcResult>("send", { beeId: bee.beeId, body: "@usageLimit" });
    await waitDelivered(client, bee.beeId, message.messageId, "quota request delivered");
    await waitFor(async () => {
      const v = await client.request<ViewResult>("view", { beeId: bee.beeId });
      return v.view.runtimeState === "idle" && v.view.flags.includes("resource_blocked") ? v : null;
    }, "failed Codex turn stays blocked");
    const account = await client.request<AccountGetResult>("account.get", { id: "codex-quota" });
    assert.ok(account.account.exhaustedAt, "quota failure reaches account exhaustion policy");
    assert.equal(account.account.status, "ok", "quota exhaustion does not require login");
    const next = await client.request<SendRpcResult>("send", { beeId: bee.beeId, body: "quota reset, continue" });
    await waitDelivered(client, bee.beeId, next.messageId, "recovery request delivered");
    await waitFor(async () => {
      const v = await client.request<ViewResult>("view", { beeId: bee.beeId });
      return v.view.runtimeState === "idle" && !v.view.flags.includes("resource_blocked");
    }, "successful turn clears bee boundary");
    await waitFor(async () => (await client.request<AccountGetResult>("account.get", { id: "codex-quota" })).account.exhaustedAt === null, "successful turn clears account exhaustion");
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    cleanup();
  }
});

/** A local stand-in for the Claude OAuth token endpoint: enrollment's validating rotation never leaves the test. */
async function oauthStub(): Promise<{ url: string; bodies: string[]; close: () => Promise<void>; refuse: (refreshToken: string) => void }> {
  const bodies: string[] = [];
  const refused = new Set<string>();
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    request.on("end", () => {
      bodies.push(body);
      const { refresh_token } = JSON.parse(body) as { refresh_token: string };
      if (refused.has(refresh_token)) { response.writeHead(400, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: "invalid_grant" })); return; }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ access_token: `ROTATED_ACCESS_${bodies.length}`, refresh_token: `ROTATED_REFRESH_${bodies.length}`, expires_in: 8 * 3600 }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1/oauth/token`, bodies, refuse: token => { refused.add(token); },
    close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test("rpc central credentials: per-account opt-in/status/lease/disable, idempotent enable, native login and capture fenced, expired and refused candidates rejected", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  const oauth = await oauthStub();
  try {
    const fixture = { claudeAiOauth: { accessToken: "CENTRAL_ACCESS_FIXTURE", refreshToken: "CENTRAL_REFRESH_FIXTURE", expiresAt: Date.now() + 8 * 3600000 } };
    seedVault(dir, "claude", "claude-pilot", ".credentials.json", JSON.stringify(fixture));
    seedVault(dir, "claude", "claude-second", ".credentials.json", JSON.stringify({ claudeAiOauth: { ...fixture.claudeAiOauth, refreshToken: "SECOND_REFRESH_FIXTURE" } }));
    seedVault(dir, "claude", "claude-refused", ".credentials.json", JSON.stringify({ claudeAiOauth: { ...fixture.claudeAiOauth, refreshToken: "REFUSED_REFRESH_FIXTURE" } }));
    oauth.refuse("REFUSED_REFRESH_FIXTURE");
    daemon = await startDaemon(dir, { env: { HIVE_CLAUDE_OAUTH_TOKEN_URL: oauth.url } });
    const client = await daemon.client();
    for (const label of ["pilot", "second", "refused"]) await client.request("account.add", { harness: "claude", label, importExisting: true });
    await client.request("account.add", { harness: "claude", label: "expired" });
    seedVault(dir, "claude", "claude-expired", ".credentials.json", JSON.stringify({ claudeAiOauth: { ...fixture.claudeAiOauth, refreshToken: "EXPIRED_REFRESH_FIXTURE", expiresAt: Date.now() - 1 } }));
    assert.equal(await client.request("account.credentials.status", { id: "claude-pilot" }), null);
    const state = await client.request<{ phase: string; generation: number }>("account.credentials.enable", { id: "claude-pilot", idempotencyKey: "central-enable" });
    assert.equal(state.phase, "ready");
    assert.equal(state.generation, 2, "adoption plus one validating rotation");
    assert.equal(oauth.bodies.length, 1);
    assert.ok(oauth.bodies[0]!.includes("CENTRAL_REFRESH_FIXTURE"), "the validating rotation consumed the adopted native chain");
    const replay = await client.request<{ deduped: boolean }>("account.credentials.enable", { id: "claude-pilot", idempotencyKey: "central-enable" });
    assert.equal(replay.deduped, true);
    // Several accounts are managed independently; enrolling a second never touches the first.
    const second = await client.request<{ phase: string; generation: number }>("account.credentials.enable", { id: "claude-second", idempotencyKey: "central-enable-second" });
    assert.equal(second.phase, "ready");
    assert.equal(second.generation, 2);
    assert.deepEqual(await client.request("account.credentials.status", { id: "claude-pilot" }), { ...state });
    // #12: an expired candidate is refused with nothing changed; a refused chain aborts with native copies intact.
    await rejects(() => client.request("account.credentials.enable", { id: "claude-expired", idempotencyKey: "central-enable-expired" }), "account_unavailable");
    assert.equal(await client.request("account.credentials.status", { id: "claude-expired" }), null);
    assert.ok(readFileSync(join(dir, "vault", "claude", "claude-expired", ".credentials.json"), "utf8").includes("EXPIRED_REFRESH_FIXTURE"));
    assert.equal(oauth.bodies.length, 2);
    await rejects(() => client.request("account.credentials.enable", { id: "claude-refused", idempotencyKey: "central-enable-refused" }), "account_unavailable");
    assert.equal((await client.request<{ phase: string }>("account.credentials.status", { id: "claude-refused" }))!.phase, "disabled");
    assert.ok(readFileSync(join(dir, "vault", "claude", "claude-refused", ".credentials.json"), "utf8").includes("REFUSED_REFRESH_FIXTURE"));
    assert.ok(!existsSync(join(dir, "homes", "claude-refused", ".credentials.json")), "no access-only copy was published for the refused candidate");
    await rejects(() => client.request("account.credentials.refresh", { id: "claude-pilot" }), "invalid_request");
    await rejects(() => client.request("account.login.start", { id: "claude-pilot" }), "account_unavailable");
    await rejects(() => client.request("account.capture", { id: "claude-pilot" }), "invalid_request");
    const lease = await client.request<{ files: Array<{ contentB64: string }> }>("account.lease", { account: "claude-pilot" });
    const shipped = JSON.parse(Buffer.from(lease.files[0]!.contentB64, "base64").toString()).claudeAiOauth;
    assert.equal(shipped.refreshToken, "");
    assert.equal(shipped.accessToken, "ROTATED_ACCESS_1");
    const secondLease = await client.request<{ files: Array<{ contentB64: string }> }>("account.lease", { account: "claude-second" });
    assert.equal(JSON.parse(Buffer.from(secondLease.files[0]!.contentB64, "base64").toString()).claudeAiOauth.accessToken, "ROTATED_ACCESS_2");
    const authorityPath = join(dir, "vault", ".credential-authorities", "claude-pilot.json");
    const authority = readFileSync(authorityPath, "utf8");
    writeFileSync(authorityPath, "corrupt");
    await rejects(() => client.request("account.lease", { account: "claude-pilot" }), "lease_unavailable");
    writeFileSync(authorityPath, authority);
    const disabled = await client.request<{ phase: string }>("account.credentials.disable", { id: "claude-pilot", idempotencyKey: "central-disable" });
    assert.equal(disabled.phase, "disabled");
    assert.ok(readFileSync(join(dir, "vault", "claude", "claude-pilot", ".credentials.json"), "utf8").includes("ROTATED_REFRESH_1"));
    assert.equal((await client.request<{ phase: string }>("account.credentials.status", { id: "claude-second" }))!.phase, "ready", "disabling one account leaves the other enrolled");
    for (const secret of ["CENTRAL_REFRESH_FIXTURE", "SECOND_REFRESH_FIXTURE", "EXPIRED_REFRESH_FIXTURE", "REFUSED_REFRESH_FIXTURE", "ROTATED_REFRESH_"]) {
      assert.ok(!daemon.output().includes(secret), `daemon output must not carry ${secret}`);
    }
    client.close();
  } finally { if (daemon) await daemon.stop(); await oauth.close(); cleanup(); }
});
