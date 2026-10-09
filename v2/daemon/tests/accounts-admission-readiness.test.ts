/**
 * Node-local account admission (hb-admission) at the RPC tier — a REAL daemon
 * over a temp socket, fake-claude for the claude harness, the stub elsewhere:
 *  - auto never falls back to an account that cannot authenticate: the only
 *    credentialed account being auth_needed is a typed `account_auth_needed`
 *  - explicit spawn onto an expired, refresh-less Claude credential is
 *    `account_credential_expired`; the allocator claim path refuses the same way
 *  - a stopped bee whose account lost its credential: `send` is accepted and
 *    queued, the wake command is HELD (no process starts), and restoring the
 *    credential releases the hold and delivers the mail
 *  - bee.swapAccount onto an unusable destination refuses before touching the
 *    running source (same account, same generation, still live)
 *  - spawn `onlyAccountIds` binds the pick to the allowlist, refuses an
 *    explicit id or swap outside it, and never spawns unbound on an empty node
 *  - the judged credential is the one a runtime reads (populated home over
 *    vault); empty/truncated documents are `account_credential_invalid`
 *  - a claim refused for readiness is fenced locally and reports whether the
 *    owner must release it
 *  - an inherited CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY never reaches a
 *    NON-central Claude account's process env
 *  - pause ownership: lease vs operator pauses, foreign unpause refused
 *    (`account_pause_owned`), the holder's own unpause lifts only its pause
 * SAFETY: temp dirs only; never ~/.hive, never a real harness; HIVE_NO_KEYCHAIN.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcError, type CommandsResult, type MailboxResult, type SendRpcResult, type SpawnResult, type ViewResult } from "../src/protocol.ts";
import type { AccountAddResult, AccountAdmissionAcquireResult, AccountAdmissionReleaseResult, AccountGetResult, AccountUpdateResult } from "../src/protocol.ts";
import type { RpcClient } from "../../cli/src/client.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";
import { openCoreStore } from "../../core/src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(here, "..", "..", "driver-hsr", "test-agent", "fake-claude.mjs");
const VALID = (tag: string) => `{"claudeAiOauth":{"accessToken":"${tag}","refreshToken":"refresh-${tag}","expiresAt":4102444800000}}`;
/** A leased copy past expiry: refresh token blanked, access token dead. */
const EXPIRED_LEASED = (tag: string) => `{"claudeAiOauth":{"accessToken":"${tag}","refreshToken":"","expiresAt":1}}`;

async function rejects(fn: () => Promise<unknown>, code: string): Promise<RpcError> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof RpcError, `expected RpcError, got ${String(err)}`);
    assert.equal(err.code, code, err.message);
    return err;
  }
  assert.fail(`expected ${code}`);
}

function seedVault(dir: string, harness: string, id: string, file: string, content: string): void {
  const d = join(dir, "vault", harness, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, file), content);
}

function writeClaudeCredential(dir: string, id: string, content: string): void {
  seedVault(dir, "claude", id, ".credentials.json", content);
  const home = join(dir, "homes", id);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".credentials.json"), content);
}

function removeClaudeCredential(dir: string, id: string): void {
  for (const path of [join(dir, "vault", "claude", id, ".credentials.json"), join(dir, "homes", id, ".credentials.json")]) {
    rmSync(path, { force: true });
  }
}

async function waitDelivered(client: RpcClient, beeId: string, messageId: number, what: string): Promise<number> {
  return (await waitFor(async () => {
    const { messages } = await client.request<MailboxResult>("mailbox", { beeId });
    const m = messages.find((x) => x.id === messageId);
    return m?.deliveredAt != null ? m.deliveredGeneration : null;
  }, what, 12_000)) as number;
}

async function waitState(client: RpcClient, beeId: string, state: string, what: string): Promise<ViewResult> {
  return waitFor(async () => {
    const v = await client.request<ViewResult>("view", { beeId });
    return v.view.runtimeState === state ? v : null;
  }, what, 12_000);
}

function claudeDaemonDir(extraEnv: Record<string, string> = {}, accounts: Record<string, unknown> = {}) {
  return makeDaemonDir({
    accounts: accounts as never,
    agents: {
      claude: {
        command: process.execPath,
        args: [FAKE_CLAUDE, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
        adapter: "claude",
        env: extraEnv,
      },
    },
  });
}

test("admission.auto: the only credentialed account being auth_needed is a typed refusal, never a last resort", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    // v18: an add with no credential is auth_needed; a credential landing later does not
    // clear it (only a login / readable probe does), so this is exactly the stranded shape.
    const added = await client.request<AccountAddResult>("account.add", { harness: "claude", label: "only" });
    assert.equal(added.account.status, "auth_needed");
    writeClaudeCredential(dir, added.account.id, VALID("only"));
    const refusal = await rejects(() => client.request("spawn", { name: "auto", agent: "claude", cwd: dir }), "account_auth_needed");
    assert.match(refusal.message, /claude-only: recent auth failure/);
    assert.equal((await client.request<{ views: ViewResult[] }>("list")).views.length, 0, "no bee was minted");
    await rejects(() => client.request("spawn", { name: "rr", agent: "claude", cwd: dir, account: "rr" }), "account_auth_needed");
    await rejects(() => client.request("spawn", { name: "explicit", agent: "claude", cwd: dir, account: "claude-only" }), "account_auth_needed");
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    cleanup();
  }
});

test("admission.expired: explicit spawn refuses an expired, refresh-less Claude credential; auto skips it; a refreshable one is admitted", async () => {
  const { dir, cleanup } = claudeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    seedVault(dir, "claude", "claude-dead", ".credentials.json", EXPIRED_LEASED("dead"));
    seedVault(dir, "claude", "claude-live", ".credentials.json", VALID("live"));
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const dead = await client.request<AccountAddResult>("account.add", { harness: "claude", label: "dead", importExisting: true });
    assert.equal(dead.account.status, "ok", "a credential FILE exists, so status alone says nothing");
    await client.request<AccountAddResult>("account.add", { harness: "claude", label: "live", importExisting: true });

    const refusal = await rejects(() => client.request("spawn", { name: "x", agent: "claude", cwd: dir, account: "claude-dead" }), "account_credential_expired");
    assert.deepEqual(refusal.details, { account: "claude-dead" });
    // auto skips the dead account and names why
    const auto = await client.request<SpawnResult>("spawn", { name: "auto", agent: "claude", cwd: dir });
    assert.equal(auto.account, "claude-live");
    assert.match(auto.accountReason ?? "", /skipped claude-dead for expired credential/);
    // an expired token WITH a refresh chain is the harness's own problem to rotate: admitted
    writeClaudeCredential(dir, "claude-dead", `{"claudeAiOauth":{"accessToken":"dead","refreshToken":"still-here","expiresAt":1}}`);
    const revived = await client.request<SpawnResult>("spawn", { name: "y", agent: "claude", cwd: dir, account: "claude-dead" });
    assert.equal(revived.account, "claude-dead");
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    cleanup();
  }
});

test("admission.claim: an allocator claim onto an account that can no longer authenticate is refused with a typed code and released, not replayed", async () => {
  const owner = { node: "worker-1", epoch: "owner-v1" };
  const { dir, cleanup } = claudeDaemonDir({}, { allocationMode: "active", allocationNodeId: "worker-1", allocationOwner: owner });
  let daemon: DaemonHandle | null = null;
  try {
    seedVault(dir, "claude", "claude-a", ".credentials.json", VALID("a"));
    // Active admission needs a VERIFIED account with fresh quota facts: seed the store before boot.
    const now = Date.now();
    const store = openCoreStore(join(dir, "core.sqlite3"), { ephemeral: true });
    store.createAccount({ id: "claude-a", harness: "claude", homePath: join(dir, "homes", "claude-a"), label: "a", lastLoginAt: now });
    store.putAccountLimits("claude-a", {
      readable: true,
      fetchedAt: now,
      fiveHour: { usedPercent: 5, resetsAt: now + 4 * 60 * 60_000, windowMinutes: 300 },
      weekly: { usedPercent: 5, resetsAt: now + 6 * 24 * 60 * 60_000, windowMinutes: 10_080 },
    });
    store.close();
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const context = { version: 1, authority: owner, scope: "claude:provider-accounts", revision: "fleet-1", observedAt: now, complete: true, accounts: [] };
    const workId = "11111111-1111-4111-8111-111111111111";
    const acquired = await client.request<AccountAdmissionAcquireResult>("account.admission.acquire", {
      harness: "claude", operation: "spawn", target: { node: "worker-1", workId, expectedGeneration: 0 },
      allocationContext: context, idempotencyKey: "acquire-spawn-1",
    });
    assert.equal(acquired.claim?.account, "claude-a");
    // The token dies between acquire and apply (the satellite lease shape).
    writeClaudeCredential(dir, "claude-a", EXPIRED_LEASED("a"));
    const refusal = await rejects(
      () => client.request("spawn", { id: workId, name: "claimed", agent: "claude", cwd: dir, allocationClaim: acquired.claim, idempotencyKey: "apply-spawn-1" }),
      "account_credential_expired",
    );
    assert.deepEqual(refusal.details, { claimId: acquired.claim!.id, account: "claude-a", fenced: true, released: true, ownerReleaseRequired: false });
    assert.equal((await client.request<{ views: ViewResult[] }>("list")).views.length, 0, "no bee was minted");
    const release = await client.request<AccountAdmissionReleaseResult>("account.admission.release", { claimId: acquired.claim!.id, reason: "caller retry", idempotencyKey: "release-1" });
    assert.equal(release.status, "already_released", "this node minted the hold and released it; the caller acquires a fresh claim elsewhere");
    // Replaying the claim while the account is still unusable: the same typed refusal.
    await rejects(
      () => client.request("spawn", { id: workId, name: "claimed", agent: "claude", cwd: dir, allocationClaim: acquired.claim, idempotencyKey: "apply-spawn-2" }),
      "account_credential_expired",
    );
    // Replaying it after the credential recovers: the fence holds — a refused claim is never applied here.
    writeClaudeCredential(dir, "claude-a", VALID("a2"));
    await rejects(
      () => client.request("spawn", { id: workId, name: "claimed", agent: "claude", cwd: dir, allocationClaim: acquired.claim, idempotencyKey: "apply-spawn-3" }),
      "account_claim_refused",
    );
    assert.equal((await client.request<{ views: ViewResult[] }>("list")).views.length, 0, "still no bee");
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    cleanup();
  }
});

test("admission.claim.remote: a claim minted by another owner node is fenced here and the refusal says the owner must release it", async () => {
  const owner = { node: "owner-mac", epoch: "owner-v1" };
  const { dir, cleanup } = claudeDaemonDir({}, { allocationMode: "active", allocationNodeId: "satellite-1", allocationOwner: owner });
  let daemon: DaemonHandle | null = null;
  try {
    seedVault(dir, "claude", "claude-a", ".credentials.json", EXPIRED_LEASED("a"));
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    await client.request("account.add", { harness: "claude", label: "a", importExisting: true });
    const workId = "22222222-2222-4222-8222-222222222222";
    const now = Date.now();
    const claim = {
      version: 1, id: "claim-from-owner-1", scope: "claude:provider-accounts", account: "claude-a", operation: "spawn", units: 1, model: null,
      sourceAccount: null, createdAt: now, expiresAt: now + 60_000, authority: owner,
      target: { node: "satellite-1", workId, expectedGeneration: 0 },
      allocation: { version: 1, mode: "active", scope: "claude:provider-accounts", revision: "fleet-1", observedAt: now, operation: "spawn", outcome: "selected", account: "claude-a", reason: "owner", retryAt: null, candidates: [] },
    };
    const refusal = await rejects(
      () => client.request("spawn", { id: workId, name: "claimed", agent: "claude", cwd: dir, allocationClaim: claim, idempotencyKey: "apply-remote-1" }),
      "account_credential_expired",
    );
    assert.deepEqual(refusal.details, { claimId: "claim-from-owner-1", account: "claude-a", fenced: true, released: false, ownerReleaseRequired: true });
    writeClaudeCredential(dir, "claude-a", VALID("a2"));
    await rejects(
      () => client.request("spawn", { id: workId, name: "claimed", agent: "claude", cwd: dir, allocationClaim: claim, idempotencyKey: "apply-remote-2" }),
      "account_claim_refused",
    );
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    cleanup();
  }
});

test("admission.hold: send to a stopped bee whose account lost its credential is accepted and queued; the wake is held, no process starts; restoring the credential releases it", async () => {
  const { dir, cleanup } = claudeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    seedVault(dir, "claude", "claude-a", ".credentials.json", VALID("a"));
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    await client.request("account.add", { harness: "claude", label: "a", importExisting: true });
    const bee = await client.request<SpawnResult>("spawn", { name: "held", agent: "claude", cwd: dir, account: "claude-a" });
    const first = await client.request<SendRpcResult>("send", { beeId: bee.beeId, body: "hello" });
    await waitDelivered(client, bee.beeId, first.messageId, "first delivered");
    await waitState(client, bee.beeId, "idle", "idle");
    await client.request("stop", { beeId: bee.beeId });
    await waitState(client, bee.beeId, "stopped", "stopped");

    removeClaudeCredential(dir, "claude-a");
    const queued = await client.request<SendRpcResult>("send", { beeId: bee.beeId, body: "while dead" });
    assert.ok(queued.commandId != null, "a wake command was enqueued with the message");
    await waitFor(() => /runtime\.start\.held bee=\S+ account=claude-a command=\d+ code=account_credential_missing/.test(readFileSync(join(dir, "hived.log"), "utf8")) ? true : null, "hold logged");
    await new Promise((r) => setTimeout(r, 300));
    const view = await client.request<ViewResult>("view", { beeId: bee.beeId });
    assert.equal(view.view.runtimeState, "stopped", "no runtime started");
    assert.equal(view.view.generation, 1, "no new generation");
    const mail = (await client.request<MailboxResult>("mailbox", { beeId: bee.beeId })).messages.find((m) => m.id === queued.messageId);
    assert.ok(mail, "the message is in the mailbox");
    assert.equal(mail!.deliveredAt, null, "…and still undelivered");
    const wake = (await client.request<CommandsResult>("commands", { beeId: bee.beeId })).commands.find((c) => c.id === queued.commandId);
    assert.equal(wake?.status, "queued", "the wake command is held, not failed");
    assert.equal(wake?.attempts, 0, "the hold consumed no retry budget");

    // A lease pause (the workstation shredding and parking the account) does not bypass the credential check.
    await client.request("account.pause", { id: "claude-a", owner: "lease", ownerId: "apiary:ws-1" });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await client.request<ViewResult>("view", { beeId: bee.beeId })).view.runtimeState, "stopped", "still no runtime while paused without a credential");
    assert.equal((await client.request<CommandsResult>("commands", { beeId: bee.beeId })).commands.find((c) => c.id === queued.commandId)?.status, "queued");

    // Healthy material returns while the pause stays: the restart is not new placement and resumes.
    writeClaudeCredential(dir, "claude-a", VALID("a2"));
    assert.equal(await waitDelivered(client, bee.beeId, queued.messageId, "delivered once the credential is back"), 2);
    assert.match(readFileSync(join(dir, "hived.log"), "utf8"), /runtime\.start\.released bee=\S+ account=claude-a/);
    assert.equal((await client.request<AccountGetResult>("account.get", { id: "claude-a" })).account.pausedBy, "lease", "the pause survived the restart");
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    cleanup();
  }
});

test("admission.material: the credential a runtime would read is judged — a populated home outranks the vault, and an empty or truncated document is invalid", async () => {
  const { dir, cleanup } = claudeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    seedVault(dir, "claude", "claude-a", ".credentials.json", VALID("a"));
    seedVault(dir, "claude", "claude-b", ".credentials.json", VALID("b"));
    seedVault(dir, "claude", "claude-c", ".credentials.json", VALID("c"));
    seedVault(dir, "claude", "claude-d", ".credentials.json", VALID("d"));
    // HOME pinned to the temp dir: an invalid vault entry must never make the import reach the developer's real vendor home.
    daemon = await startDaemon(dir, { env: { HOME: dir, CLAUDE_CONFIG_DIR: join(dir, "no-such-vendor-home") } });
    const client = await daemon.client();
    for (const label of ["a", "b", "c", "d"]) await client.request("account.add", { harness: "claude", label, importExisting: true });
    // A partial write leaves an empty or truncated document behind (home + vault).
    writeClaudeCredential(dir, "claude-c", "");
    writeClaudeCredential(dir, "claude-d", '{"claudeAiOauth":{"accessToken":"d","refr');
    // A valid vault copy cannot rescue an expired, refresh-less HOME: activation leaves a populated home alone.
    mkdirSync(join(dir, "homes", "claude-a"), { recursive: true });
    writeFileSync(join(dir, "homes", "claude-a", ".credentials.json"), EXPIRED_LEASED("a-home"));
    await rejects(() => client.request("spawn", { name: "a", agent: "claude", cwd: dir, account: "claude-a" }), "account_credential_expired");
    // An older expired vault document with a refresh token does not rescue it either.
    seedVault(dir, "claude", "claude-a", ".credentials.json", '{"claudeAiOauth":{"accessToken":"old","refreshToken":"old-refresh","expiresAt":1}}');
    await rejects(() => client.request("spawn", { name: "a2", agent: "claude", cwd: dir, account: "claude-a" }), "account_credential_expired");
    // The converse: a usable home with an expired vault copy is admitted on the home.
    mkdirSync(join(dir, "homes", "claude-b"), { recursive: true });
    writeFileSync(join(dir, "homes", "claude-b", ".credentials.json"), VALID("b-home"));
    seedVault(dir, "claude", "claude-b", ".credentials.json", EXPIRED_LEASED("b-vault"));
    assert.equal((await client.request<SpawnResult>("spawn", { name: "b", agent: "claude", cwd: dir, account: "claude-b" })).account, "claude-b");
    // Empty and truncated documents are invalid, not "present".
    const empty = await rejects(() => client.request("spawn", { name: "c", agent: "claude", cwd: dir, account: "claude-c" }), "account_credential_invalid");
    assert.match(empty.message, /not a usable claude credential/);
    await rejects(() => client.request("spawn", { name: "d", agent: "claude", cwd: dir, account: "claude-d" }), "account_credential_invalid");
    const auto = await rejects(() => client.request("spawn", { name: "auto", agent: "claude", cwd: dir, onlyAccountIds: ["claude-c", "claude-d"] }), "account_auth_needed");
    assert.match(auto.message, /claude-c: invalid credential, claude-d: invalid credential/);
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    cleanup();
  }
});

test("admission.swap: a swap onto an unusable destination is refused before the running source is touched", async () => {
  const { dir, cleanup } = claudeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    seedVault(dir, "claude", "claude-a", ".credentials.json", VALID("a"));
    seedVault(dir, "claude", "claude-b", ".credentials.json", EXPIRED_LEASED("b"));
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    await client.request("account.add", { harness: "claude", label: "a", importExisting: true });
    await client.request("account.add", { harness: "claude", label: "b", importExisting: true });
    const bee = await client.request<SpawnResult>("spawn", { name: "src", agent: "claude", cwd: dir, account: "claude-a" });
    const first = await client.request<SendRpcResult>("send", { beeId: bee.beeId, body: "hello" });
    await waitDelivered(client, bee.beeId, first.messageId, "first delivered");
    const before = await waitState(client, bee.beeId, "idle", "idle");

    await rejects(() => client.request("bee.swapAccount", { beeId: bee.beeId, account: "claude-b" }), "account_credential_expired");
    await client.request("account.pause", { id: "claude-b", owner: "lease", ownerId: "apiary:ws-1" });
    const paused = await rejects(() => client.request("bee.swapAccount", { beeId: bee.beeId, account: "claude-b" }), "account_paused");
    assert.match(paused.message, /paused by lease:apiary:ws-1/);
    await rejects(() => client.request("bee.swapAccount", { beeId: bee.beeId, account: "auto" }), "account_unavailable");

    const after = await client.request<ViewResult>("view", { beeId: bee.beeId });
    assert.equal(after.bee?.account, "claude-a");
    assert.equal(after.view.generation, before.view.generation);
    assert.equal(after.view.runtimeState, "idle");
    assert.equal(after.runtime?.pid, before.runtime?.pid, "same process");
    assert.equal((await client.request<CommandsResult>("commands", { beeId: bee.beeId })).commands.filter((c) => c.verb === "stop").length, 0, "no stop was enqueued");
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    cleanup();
  }
});

test("admission.allowlist: spawn onlyAccountIds binds auto/rr to the allowlist and refuses an explicit id outside it", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    await client.request("account.add", { harness: "stub", label: "a" });
    await client.request("account.add", { harness: "stub", label: "b" });
    const bound = await client.request<SpawnResult>("spawn", { name: "only-b", agent: "stub", cwd: dir, onlyAccountIds: ["stub-b"] });
    assert.equal(bound.account, "stub-b");
    const rr = await client.request<SpawnResult>("spawn", { name: "rr-b", agent: "stub", cwd: dir, account: "rr", onlyAccountIds: ["stub-b"] });
    assert.equal(rr.account, "stub-b");
    await rejects(() => client.request("spawn", { name: "outside", agent: "stub", cwd: dir, account: "stub-a", onlyAccountIds: ["stub-b"] }), "account_unavailable");
    const none = await rejects(() => client.request("spawn", { name: "nowhere", agent: "stub", cwd: dir, onlyAccountIds: ["stub-elsewhere"] }), "account_unavailable");
    assert.match(none.message, /No stub account matches the allowed ids on this node/);
    await rejects(() => client.request("spawn", { name: "dup", agent: "stub", cwd: dir, onlyAccountIds: ["stub-b", "stub-b"] }), "invalid_request");
    // An explicit swap outside the allowlist is refused with the source untouched.
    const bound2 = await client.request<SpawnResult>("spawn", { name: "swap-src", agent: "stub", cwd: dir, account: "stub-b" });
    await rejects(() => client.request("bee.swapAccount", { beeId: bound2.beeId, account: "stub-a", onlyAccountIds: ["stub-b"] }), "account_unavailable");
    assert.equal((await client.request<ViewResult>("view", { beeId: bound2.beeId })).bee?.account, "stub-b");
    // A harness with NO accounts on this node never spawns unbound when the caller bound the pick.
    const none2 = await rejects(() => client.request("spawn", { name: "unbound", agent: "claude", cwd: dir, onlyAccountIds: ["claude-x"] }), "account_unavailable");
    assert.match(none2.message, /No claude account matches the allowed ids on this node/);
    assert.equal((await client.request<{ views: ViewResult[] }>("list")).views.filter((v) => v.bee?.name === "unbound").length, 0);
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    cleanup();
  }
});

test("admission.env: inherited CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY never reach a non-central Claude account's process", async () => {
  const argvLog = join(makeDaemonDir().dir, "argv.jsonl");
  const { dir, cleanup } = claudeDaemonDir({ FAKE_CLAUDE_ARGV_LOG: argvLog });
  let daemon: DaemonHandle | null = null;
  try {
    seedVault(dir, "claude", "claude-a", ".credentials.json", VALID("a"));
    daemon = await startDaemon(dir, { env: { CLAUDE_CODE_OAUTH_TOKEN: "operator-inherited-token", ANTHROPIC_API_KEY: "operator-inherited-key" } });
    const client = await daemon.client();
    await client.request("account.add", { harness: "claude", label: "a", importExisting: true });
    const bee = await client.request<SpawnResult>("spawn", { name: "scrubbed", agent: "claude", cwd: dir, account: "claude-a" });
    const first = await client.request<SendRpcResult>("send", { beeId: bee.beeId, body: "hello" });
    await waitDelivered(client, bee.beeId, first.messageId, "first delivered");
    // The delivery mark is the write to stdin; the harness logs its boot env on its own clock.
    await waitState(client, bee.beeId, "idle", "turn served");
    await waitFor(() => existsSync(argvLog) ? true : null, "fake-claude boot logged");
    const boots = readFileSync(argvLog, "utf8").split("\n").filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { env: { CLAUDE_CODE_OAUTH_TOKEN: string | null; ANTHROPIC_API_KEY: string | null; CLAUDE_CONFIG_DIR: string | null } });
    assert.equal(boots.length, 1);
    assert.equal(boots[0]!.env.CLAUDE_CONFIG_DIR, join(dir, "homes", "claude-a"));
    assert.equal(boots[0]!.env.CLAUDE_CODE_OAUTH_TOKEN, "", "blanked, not inherited");
    assert.equal(boots[0]!.env.ANTHROPIC_API_KEY, "", "blanked, not inherited");
    const stored = (await client.request<ViewResult>("view", { beeId: bee.beeId })).bee?.env ?? {};
    assert.equal(stored.CLAUDE_CODE_OAUTH_TOKEN, "", "the persisted bee env carries the scrub too");
    assert.ok(!existsSync(join(dir, "homes", "claude-a", "nope")));
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    cleanup();
  }
});

test("admission.pause: pause ownership over RPC — lease vs operator, foreign unpause refused, own unpause lifts only its pause, force overrides", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    await client.request("account.add", { harness: "stub", label: "a" });
    const lease = { owner: "lease", ownerId: "apiary:ws-1" };
    const byLease = await client.request<AccountUpdateResult>("account.pause", { id: "stub-a", ...lease });
    assert.equal(byLease.applied, true);
    assert.equal(byLease.account.pausedBy, "lease");
    assert.equal(byLease.account.pausedOwner, "apiary:ws-1");
    assert.ok(byLease.account.pausedAt != null);
    assert.equal((await client.request<AccountUpdateResult>("account.pause", { id: "stub-a", ...lease })).applied, false, "same holder = quiet");
    const foreign = await rejects(() => client.request("account.pause", { id: "stub-a" }), "account_pause_owned");
    assert.deepEqual(foreign.details, { heldBy: { by: "lease", owner: "apiary:ws-1" } });
    await rejects(() => client.request("account.unpause", { id: "stub-a" }), "account_pause_owned");
    await rejects(() => client.request("account.unpause", { id: "stub-a", owner: "lease", ownerId: "apiary:ws-2" }), "account_pause_owned");
    assert.equal((await client.request<AccountGetResult>("account.get", { id: "stub-a" })).account.status, "paused");
    const lifted = await client.request<AccountUpdateResult>("account.unpause", { id: "stub-a", ...lease });
    assert.equal(lifted.applied, true);
    assert.equal(lifted.account.status, "ok");
    assert.equal(lifted.account.pausedBy, null);

    // An operator pause is not lifted by a lease unpause.
    await client.request<AccountUpdateResult>("account.pause", { id: "stub-a" });
    const held = await rejects(() => client.request("account.unpause", { id: "stub-a", ...lease }), "account_pause_owned");
    assert.deepEqual(held.details, { heldBy: { by: "operator", owner: null } });
    const still = await client.request<AccountGetResult>("account.get", { id: "stub-a" });
    assert.equal(still.account.status, "paused");
    assert.equal(still.account.pausedBy, "operator");
    await rejects(() => client.request("spawn", { name: "p", agent: "stub", cwd: dir, account: "stub-a" }), "account_paused");
    const forced = await client.request<AccountUpdateResult>("account.unpause", { id: "stub-a", ...lease, force: true });
    assert.equal(forced.account.status, "ok");
    // Parameter validation: operator takes no ownerId; lease/quota require one.
    await rejects(() => client.request("account.pause", { id: "stub-a", ownerId: "x" }), "invalid_request");
    await rejects(() => client.request("account.pause", { id: "stub-a", owner: "quota" }), "invalid_request");
    await rejects(() => client.request("account.pause", { id: "stub-a", owner: "someone" }), "invalid_request");
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    cleanup();
  }
});
