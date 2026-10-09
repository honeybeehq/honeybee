/**
 * Auth resume, end to end against a real daemon and the fake Claude CLI. The
 * fake reads `$CLAUDE_CONFIG_DIR/.credentials.json` on every provider call
 * (FAKE_CLAUDE_REQUIRE_CREDENTIAL), so an expired file cuts a turn off with
 * the logged-out result a real Claude Code prints, and a valid one lets the
 * next turn through. SAFETY: temp dirs only; fixture tokens; no Keychain; the
 * usage and token endpoints point at local stubs or a dead port.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AUTH_CONTINUE_BODY, AUTH_RESUME_SENDER, type AuthInterruptionRow } from "../../core/src/index.ts";
import type { RpcClient } from "../../cli/src/client.ts";
import {
  RpcError,
  type AccountCredentialsRestoredResult,
  type AccountGetResult,
  type AccountInterruptionsResult,
  type MailboxResult,
  type SendRpcResult,
  type SpawnResult,
  type SwapAccountResult,
  type ViewResult,
} from "../src/protocol.ts";
import { makeDaemonDir, sleep, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(here, "..", "..", "driver-hsr", "test-agent", "fake-claude.mjs");
const DEAD_ENDPOINT = "http://127.0.0.1:9/v1/oauth/token";

function rig() {
  return makeDaemonDir({
    agents: {
      claude: {
        command: process.execPath,
        args: [FAKE_CLAUDE, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
        adapter: "claude",
        env: { FAKE_CLAUDE_REQUIRE_CREDENTIAL: "1" },
      },
    },
  });
}

/** Write the account's credential in both places a Claude account keeps it. */
function writeCredential(dir: string, account: string, credential: { accessToken: string; expiresAt: number; refreshToken?: string }): void {
  for (const base of [join(dir, "homes", account), join(dir, "vault", "claude", account)]) {
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, ".credentials.json"), JSON.stringify({ claudeAiOauth: credential }));
  }
}
const valid = (accessToken: string) => ({ accessToken, expiresAt: Date.now() + 8 * 3_600_000 });
const expired = (accessToken: string) => ({ accessToken, expiresAt: 1 });

async function addAccount(client: RpcClient, dir: string, label: string): Promise<string> {
  const id = `claude-${label}`;
  writeCredential(dir, id, valid(`FIXTURE_ACCESS_${label}_1`));
  await client.request("account.add", { harness: "claude", label, importExisting: true });
  return id;
}

async function spawnWarm(client: RpcClient, dir: string, name: string, account: string): Promise<string> {
  const spawned = await client.request<SpawnResult>("spawn", { name, agent: "claude", cwd: dir, account, tags: ["autoswap=false"] });
  const hello = await client.request<SendRpcResult>("send", { beeId: spawned.beeId, body: `hello ${name}` });
  await delivered(client, spawned.beeId, hello.messageId);
  await viewWhere(client, spawned.beeId, (v) => v.view.runtimeState === "idle", `${name} idle after its first turn`);
  return spawned.beeId;
}

async function mailbox(client: RpcClient, beeId: string): Promise<MailboxResult["messages"]> {
  return (await client.request<MailboxResult>("mailbox", { beeId })).messages;
}

async function delivered(client: RpcClient, beeId: string, messageId: number): Promise<void> {
  await waitFor(async () => (await mailbox(client, beeId)).find((m) => m.id === messageId)?.deliveredAt != null, `message ${messageId} delivered`, 12_000);
}

async function viewWhere(client: RpcClient, beeId: string, pred: (v: ViewResult) => boolean, what: string): Promise<ViewResult> {
  return waitFor(async () => {
    const v = await client.request<ViewResult>("view", { beeId });
    return pred(v) ? v : null;
  }, what, 12_000);
}

async function interruptions(client: RpcClient, beeId: string): Promise<AuthInterruptionRow[]> {
  return (await client.request<AccountInterruptionsResult>("account.interruptions", { beeId })).interruptions;
}

async function interruptionWhere(client: RpcClient, beeId: string, pred: (row: AuthInterruptionRow) => boolean, what: string): Promise<AuthInterruptionRow> {
  return waitFor(async () => (await interruptions(client, beeId)).find(pred) ?? null, what, 12_000);
}

/** Send a message and wait until its turn is cut off by the logged-out result. */
async function cutOff(client: RpcClient, beeId: string, body: string): Promise<number> {
  const sent = await client.request<SendRpcResult>("send", { beeId, body });
  await interruptionWhere(client, beeId, (row) => row.state === "open" && row.messageIds.includes(sent.messageId), `${body} cut off`);
  await viewWhere(client, beeId, (v) => v.view.flags.includes("auth_needed") && v.view.runtimeState === "idle", `${body} flagged`);
  return sent.messageId;
}

const continuations = (messages: MailboxResult["messages"], after: number) => messages.filter((m) => m.id > after);

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

test("auth-resume.1: capture after a logged-out cut — an untouched turn is redelivered, a half-done turn gets one continue message, a bee the user stopped stays stopped", async () => {
  const { dir, cleanup } = rig();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir, { env: { HIVE_CLAUDE_OAUTH_TOKEN_URL: DEAD_ENDPOINT } });
    const client = await daemon.client();
    const account = await addAccount(client, dir, "a");
    const fresh = await spawnWarm(client, dir, "fresh", account);
    const partial = await spawnWarm(client, dir, "partial", account);
    const stopped = await spawnWarm(client, dir, "stopped", account);

    const long = await client.request<SendRpcResult>("send", { beeId: partial, body: "long job @steps:4 @slow:400" });
    await delivered(client, partial, long.messageId);
    await sleep(600);
    writeCredential(dir, account, expired("FIXTURE_ACCESS_a_1"));
    await interruptionWhere(client, partial, (row) => row.state === "open", "partial cut off mid-turn");
    const untouched = await cutOff(client, fresh, "never ran");
    const stopMe = await cutOff(client, stopped, "stop me");

    assert.equal((await interruptionWhere(client, fresh, (row) => row.state === "open", "fresh row")).turnProgress, "none");
    const partialRow = await interruptionWhere(client, partial, (row) => row.state === "open", "partial row");
    assert.deepEqual([partialRow.turnProgress, partialRow.messageIds, partialRow.account, partialRow.generation], ["some", [long.messageId], account, 1]);
    await waitFor(async () => (await client.request<AccountGetResult>("account.get", { id: account })).account.status === "auth_needed", "account auth_needed");

    await client.request("stop", { beeId: stopped });
    await viewWhere(client, stopped, (v) => v.view.runtimeState === "stopped", "stopped by the user");
    await interruptionWhere(client, stopped, (row) => row.state === "cancelled" && row.settleReason === "stopped_by_user", "user stop cancels the continuation");
    await sleep(300);
    for (const [beeId, last] of [[fresh, untouched], [partial, long.messageId], [stopped, stopMe]] as const) {
      assert.deepEqual(continuations(await mailbox(client, beeId), last), [], "nothing resumes while the credential is still broken");
    }

    writeCredential(dir, account, valid("FIXTURE_ACCESS_a_2"));
    await client.request("account.capture", { id: account });

    const freshDone = await interruptionWhere(client, fresh, (row) => row.state === "completed", "fresh continued and finished");
    assert.equal(freshDone.continuationKind, "redeliver");
    assert.equal(freshDone.restoredBy, "capture");
    const freshMail = continuations(await mailbox(client, fresh), untouched);
    assert.deepEqual(freshMail.map((m) => [m.id, m.body, m.sender, m.deliveredAt != null]), [[freshDone.continuationMessageIds[0], "never ran", "operator", true]]);

    const partialDone = await interruptionWhere(client, partial, (row) => row.state === "completed", "partial continued and finished");
    assert.equal(partialDone.continuationKind, "continue");
    assert.deepEqual(continuations(await mailbox(client, partial), long.messageId).map((m) => [m.body, m.sender, m.deliveredAt != null]), [[AUTH_CONTINUE_BODY, AUTH_RESUME_SENDER, true]]);

    for (const beeId of [fresh, partial]) {
      const v = await viewWhere(client, beeId, (view) => view.view.runtimeState === "idle", "idle after the continuation");
      assert.deepEqual(v.view.flags, []);
      assert.equal(v.view.generation, 1, "the same runtime continued; nothing was restarted");
    }
    const stoppedView = await client.request<ViewResult>("view", { beeId: stopped });
    assert.deepEqual([stoppedView.view.runtimeState, stoppedView.view.flags], ["stopped", []]);
    assert.deepEqual(continuations(await mailbox(client, stopped), stopMe), [], "a bee the user stopped gets no continuation");
    assert.equal((await client.request<AccountGetResult>("account.get", { id: account })).account.status, "ok");

    await client.request("account.capture", { id: account });
    await sleep(300);
    assert.equal(continuations(await mailbox(client, fresh), untouched).length, 1, "a repeated capture sends nothing more");
    assert.equal(continuations(await mailbox(client, partial), long.messageId).length, 1);
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    cleanup();
  }
});

test("auth-resume.2: account.credentialsRestored on a satellite — refused while the credential is expired, one continuation per bee across a daemon kill, repeat calls send nothing", async () => {
  const { dir, cleanup } = rig();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir, { env: { HIVE_CLAUDE_OAUTH_TOKEN_URL: DEAD_ENDPOINT } });
    let client = await daemon.client();
    const account = await addAccount(client, dir, "sat");
    const one = await spawnWarm(client, dir, "one", account);
    const two = await spawnWarm(client, dir, "two", account);
    writeCredential(dir, account, expired("FIXTURE_ACCESS_sat_1"));
    const firstMail = await cutOff(client, one, "task one");
    const secondMail = await cutOff(client, two, "task two");

    await rejects(() => client.request("account.credentialsRestored", { id: account }), "account_unavailable");
    // A good vault backup does not make the home copy — the one runtimes read — usable.
    writeFileSync(join(dir, "vault", "claude", account, ".credentials.json"), JSON.stringify({ claudeAiOauth: valid("FIXTURE_ACCESS_sat_backup") }));
    await rejects(() => client.request("account.credentialsRestored", { id: account }), "account_unavailable");
    assert.deepEqual(continuations(await mailbox(client, one), firstMail), []);

    writeCredential(dir, account, valid("FIXTURE_LEASED_ACCESS_sat_2"));
    const restored = await client.request<AccountCredentialsRestoredResult>("account.credentialsRestored", { id: account, idempotencyKey: "lease-2" });
    assert.deepEqual([...restored.resumingBeeIds].sort(), [one, two].sort());
    assert.deepEqual([...restored.clearedBeeIds].sort(), [one, two].sort());
    assert.equal(restored.account.status, "ok");
    client.close();
    await daemon.kill();

    daemon = await startDaemon(dir, { env: { HIVE_CLAUDE_OAUTH_TOKEN_URL: DEAD_ENDPOINT } });
    client = await daemon.client();
    for (const [beeId, original, body] of [[one, firstMail, "task one"], [two, secondMail, "task two"]] as const) {
      const done = await interruptionWhere(client, beeId, (row) => row.state === "completed", `${body} finished after the restart`);
      assert.equal(done.restoredBy, "credentials_restored");
      assert.deepEqual(continuations(await mailbox(client, beeId), original).map((m) => [m.body, m.deliveredAt != null]), [[body, true]]);
      assert.deepEqual((await client.request<ViewResult>("view", { beeId })).view.flags, []);
    }

    const replay = await client.request<AccountCredentialsRestoredResult>("account.credentialsRestored", { id: account, idempotencyKey: "lease-2" });
    assert.equal(replay.deduped, true);
    const again = await client.request<AccountCredentialsRestoredResult>("account.credentialsRestored", { id: account });
    assert.deepEqual([again.resumingBeeIds, again.clearedBeeIds, again.revision], [[], [], restored.revision]);
    await sleep(300);
    assert.equal(continuations(await mailbox(client, one), firstMail).length, 1);
    assert.equal(continuations(await mailbox(client, two), secondMail).length, 1);
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    cleanup();
  }
});

test("auth-resume.3: a bee that cannot authenticate on a credential that validates is continued once, then left flagged until the credential changes", async () => {
  const { dir, cleanup } = rig();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir, { env: { HIVE_CLAUDE_OAUTH_TOKEN_URL: DEAD_ENDPOINT } });
    const client = await daemon.client();
    const account = await addAccount(client, dir, "loop");
    const bee = await spawnWarm(client, dir, "stuck", account);
    const original = await cutOff(client, bee, "@authfail every time");

    const first = await client.request<AccountCredentialsRestoredResult>("account.credentialsRestored", { id: account });
    assert.deepEqual(first.resumingBeeIds, [bee]);
    const blocked = await interruptionWhere(client, bee, (row) => row.state === "open" && row.blockedRevision === first.revision, "the redelivered copy failed again");
    assert.deepEqual(blocked.messageIds, [original]);
    await viewWhere(client, bee, (v) => v.view.flags.includes("auth_needed") && v.view.runtimeState === "idle", "flagged again");

    const second = await client.request<AccountCredentialsRestoredResult>("account.credentialsRestored", { id: account });
    assert.deepEqual([second.resumingBeeIds, second.blockedBeeIds, second.clearedBeeIds], [[], [bee], []]);
    await sleep(300);
    assert.equal(continuations(await mailbox(client, bee), original).length, 1, "the same credential never resumes a bee twice");
    assert.ok((await client.request<ViewResult>("view", { beeId: bee })).view.flags.includes("auth_needed"));

    writeCredential(dir, account, valid("FIXTURE_ACCESS_loop_2"));
    const third = await client.request<AccountCredentialsRestoredResult>("account.credentialsRestored", { id: account });
    assert.notEqual(third.revision, first.revision);
    assert.deepEqual(third.resumingBeeIds, [bee]);
    await waitFor(async () => continuations(await mailbox(client, bee), original).length === 2, "a new credential earns one more attempt");
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    cleanup();
  }
});

test("auth-resume.4: the daemon's own refresh and a readable limits probe each resume the bee with no operator action", async () => {
  const tokens: string[] = [];
  let usageReadable = false;
  const provider = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    request.on("end", () => {
      response.setHeader("Content-Type", "application/json");
      if (request.url?.includes("/oauth/token")) {
        tokens.push(body);
        response.end(JSON.stringify({ access_token: `FIXTURE_ROTATED_ACCESS_${tokens.length}`, refresh_token: `FIXTURE_ROTATED_REFRESH_${tokens.length}`, expires_in: 8 * 3600 }));
        return;
      }
      if (!usageReadable) { response.statusCode = 503; response.end(JSON.stringify({ error: "unavailable" })); return; }
      response.end(JSON.stringify({ five_hour: { utilization: 10, resets_at: new Date(Date.now() + 3_600_000).toISOString() }, seven_day: { utilization: 20, resets_at: new Date(Date.now() + 86_400_000).toISOString() } }));
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  const { dir, cleanup } = rig();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir, { env: { HIVE_CLAUDE_OAUTH_TOKEN_URL: `${base}/v1/oauth/token`, HIVE_CLAUDE_USAGE_URL: `${base}/api/oauth/usage` } });
    const client = await daemon.client();

    const refreshed = await addAccount(client, dir, "refresh");
    const refreshBee = await spawnWarm(client, dir, "refresh-bee", refreshed);
    writeCredential(dir, refreshed, { ...expired("FIXTURE_ACCESS_refresh_1"), refreshToken: "FIXTURE_REFRESH_refresh_1" });
    const refreshMail = await client.request<SendRpcResult>("send", { beeId: refreshBee, body: "survive the expiry" });
    const refreshDone = await interruptionWhere(client, refreshBee, (row) => row.state === "completed", "resumed by the daemon's refresh");
    assert.deepEqual([refreshDone.restoredBy, refreshDone.continuationKind, refreshDone.messageIds], ["refresh", "redeliver", [refreshMail.messageId]]);
    assert.equal(tokens.length, 1, "one rotation");
    assert.deepEqual((await client.request<ViewResult>("view", { beeId: refreshBee })).view.flags, []);

    const probed = await addAccount(client, dir, "probe");
    const probeBee = await spawnWarm(client, dir, "probe-bee", probed);
    const probeMail = await cutOff(client, probeBee, "@authfail once");
    assert.deepEqual(continuations(await mailbox(client, probeBee), probeMail), [], "an unreadable probe validates nothing");
    usageReadable = true;
    await client.request("account.limits", { id: probed });
    const probeRow = await waitFor(async () => (await interruptions(client, probeBee)).find((row) => row.restoredBy === "limits_probe") ?? null, "resumed by the readable probe");
    assert.deepEqual(probeRow.continuationMessageIds.length, 1);
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    cleanup();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});

test("auth-resume.5: swapping an interrupted bee onto a healthy account continues its turn there; the old account's later restore does not touch it", async () => {
  const { dir, cleanup } = rig();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir, { env: { HIVE_CLAUDE_OAUTH_TOKEN_URL: DEAD_ENDPOINT } });
    const client = await daemon.client();
    const source = await addAccount(client, dir, "src");
    const target = await addAccount(client, dir, "dst");
    const bee = await spawnWarm(client, dir, "mover", source);
    writeCredential(dir, source, expired("FIXTURE_ACCESS_src_1"));
    const original = await cutOff(client, bee, "finish on the other account");

    const swap = await client.request<SwapAccountResult>("bee.swapAccount", { beeId: bee, account: target });
    assert.equal(swap.action, "stop_then_revive");
    const done = await interruptionWhere(client, bee, (row) => row.state === "completed", "continued on the target account");
    assert.deepEqual([done.account, done.restoredBy, done.continuationKind], [target, "account_swap", "redeliver"]);
    const after = await viewWhere(client, bee, (v) => v.view.runtimeState === "idle" && v.view.generation === 2, "idle on generation 2");
    assert.deepEqual(after.view.flags, []);
    assert.deepEqual(continuations(await mailbox(client, bee), original).map((m) => [m.body, m.deliveredGeneration]), [["finish on the other account", 2]]);

    writeCredential(dir, source, valid("FIXTURE_ACCESS_src_2"));
    const restored = await client.request<AccountCredentialsRestoredResult>("account.credentialsRestored", { id: source });
    assert.deepEqual([restored.resumingBeeIds, restored.clearedBeeIds], [[], []]);
    await sleep(300);
    assert.equal(continuations(await mailbox(client, bee), original).length, 1);
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    cleanup();
  }
});
