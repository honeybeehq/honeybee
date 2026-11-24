import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcError, type AccountAddResult, type CommandsResult, type ListResult, type MailboxResult, type SendRpcResult, type SpawnResult, type ViewResult } from "../src/protocol.ts";
import { HiveDaemon } from "../src/daemon.ts";
import { loadNodeConfig } from "../src/config.ts";
import { RpcClient } from "../../cli/src/client.ts";
import { AGENT_PATH, makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const HOUR = 3_600_000;
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const cursorJwt = (sub: string, expMs: number | null, nonce: string) =>
  `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: "https://fake-cursor-issuer.test", sub, nonce, ...(expMs === null ? {} : { exp: Math.floor(expMs / 1000) }) })}.fake-signature`;
const cursorAuth = (token: string) => `${JSON.stringify({ accessToken: token, refreshToken: "FAKE-CURSOR-REFRESH" }, null, 2)}\n`;

function writeCursorCredential(dir: string, id: string, raw: string, where: Array<"vault" | "home"> = ["vault", "home"]): void {
  for (const root of where) {
    const target = root === "vault" ? join(dir, "vault", "cursor", id) : join(dir, "homes", id);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "auth.json"), raw);
  }
}

function removeCursorCredential(dir: string, id: string): void {
  for (const path of [join(dir, "vault", "cursor", id, "auth.json"), join(dir, "homes", id, "auth.json")]) rmSync(path, { force: true });
}

function fakeCursorAgent(dir: string): string {
  const path = join(dir, "fake-cursor-agent");
  writeFileSync(path, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 2026.11.22-e9042b2; exit 0; fi\nexec "${process.execPath}" "${AGENT_PATH}" "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

function cursorDaemonDir() {
  const base = mkdtempSync(join(tmpdir(), "hb-cursor-agent-"));
  const rig = makeDaemonDir({
    retry: { maxAttempts: 4, backoffBaseMs: 50 },
    agents: { cursor: { command: fakeCursorAgent(base), args: [], adapter: "stub", env: { STUB_TURN_MS: "10", PATH: "/usr/bin:/bin" } } },
  } as never);
  return { dir: rig.dir, liveAuth: join(base, "live-cursor-auth.json"), cleanup: () => { rig.cleanup(); rmSync(base, { recursive: true, force: true }); } };
}

async function rejects(fn: () => Promise<unknown>, code: string): Promise<RpcError> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof RpcError, `expected RpcError, got ${String(err)}`);
    assert.equal(err.code, code, err.message);
    return err;
  }
  return assert.fail(`expected ${code}`);
}

async function waitDelivered(client: RpcClient, beeId: string, messageId: number, what: string): Promise<number> {
  return (await waitFor(async () => {
    const { messages } = await client.request<MailboxResult>("mailbox", { beeId });
    const message = messages.find((m) => m.id === messageId);
    return message?.deliveredAt != null ? message.deliveredGeneration : null;
  }, what, 15_000)) as number;
}

async function waitState(client: RpcClient, beeId: string, state: string, what: string): Promise<void> {
  await waitFor(async () => ((await client.request<ViewResult>("view", { beeId })).view.runtimeState === state ? true : null), what, 15_000);
}

test("cursor admission: an expired Cursor sign-in is refused at admission only after a re-capture found nothing newer; an unreadable expiry is refused at once; auto follows the same rule (HON-40)", async () => {
  const rig = cursorDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    const now = Date.now();
    for (const label of ["dead", "blind", "live"]) writeCursorCredential(rig.dir, `cursor-${label}`, cursorAuth(cursorJwt(`auth0|${label}`, now + 6 * HOUR, label)));
    daemon = await startDaemon(rig.dir, { env: { HIVE_CURSOR_AUTH_PATH: rig.liveAuth } });
    const client = await daemon.client();
    for (const label of ["dead", "blind", "live"]) await client.request<AccountAddResult>("account.add", { harness: "cursor", label, importExisting: true });
    await new Promise((resolve) => setTimeout(resolve, 500));
    writeCursorCredential(rig.dir, "cursor-dead", cursorAuth(cursorJwt("auth0|dead", now - HOUR, "dead")));
    writeCursorCredential(rig.dir, "cursor-blind", cursorAuth(cursorJwt("auth0|blind", null, "blind")));
    for (const label of ["dead", "blind"]) {
      const { account } = await client.request<{ account: { status: string } }>("account.get", { id: `cursor-${label}` });
      assert.equal(account.status, "ok", `cursor-${label} is still marked ok: only its token says otherwise`);
    }

    const blind = await rejects(() => client.request("spawn", { name: "blind", agent: "cursor", cwd: rig.dir, account: "cursor-blind" }), "account_credential_expired");
    assert.match(blind.message, /Cursor sign-in for cursor-blind has a token whose expiry cannot be read; log in: hive account login cursor-blind/);
    assert.deepEqual(blind.details, { account: "cursor-blind" });
    assert.equal((await client.request<ListResult>("list")).views.length, 0, "no bee was minted for a refused spawn");

    const first = await client.request<SpawnResult>("spawn", { name: "dead-1", agent: "cursor", cwd: rig.dir, account: "cursor-dead" });
    assert.equal(first.account, "cursor-dead", "no re-capture has run since the token expired, so activation gets to try one");
    await waitFor(() => /runtime\.start\.held bee=\S+ account=cursor-dead command=\d+ code=account_auth_needed/.test(readFileSync(join(rig.dir, "hived.log"), "utf8")) ? true : null, "held after activation's re-capture found nothing", 15_000);
    const refused = await rejects(() => client.request("spawn", { name: "dead-2", agent: "cursor", cwd: rig.dir, account: "cursor-dead" }), "account_auth_needed");
    assert.match(refused.message, /cursor-dead needs login; .*log in: hive account login cursor-dead/);

    const auto = await client.request<SpawnResult>("spawn", { name: "auto", agent: "cursor", cwd: rig.dir });
    assert.equal(auto.account, "cursor-live");
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    rig.cleanup();
  }
});

async function withSleptCursorAccount(run: (client: RpcClient, dir: string) => Promise<void>): Promise<void> {
  const rig = cursorDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    const now = Date.now();
    writeCursorCredential(rig.dir, "cursor-slept", cursorAuth(cursorJwt("auth0|sleeper", now + 6 * HOUR, "before")));
    daemon = await startDaemon(rig.dir, { env: { HIVE_CURSOR_AUTH_PATH: rig.liveAuth } });
    const client = await daemon.client();
    await client.request<AccountAddResult>("account.add", { harness: "cursor", label: "slept", importExisting: true });
    await new Promise((resolve) => setTimeout(resolve, 500));
    writeCursorCredential(rig.dir, "cursor-slept", cursorAuth(cursorJwt("auth0|sleeper", now - HOUR, "before")));
    writeFileSync(rig.liveAuth, cursorAuth(cursorJwt("auth0|sleeper", now + 8 * HOUR, "after")));
    await run(client, rig.dir);
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    rig.cleanup();
  }
}

test("cursor admission: a stored Cursor token that expired while Cursor's own login stayed fresh is re-captured, so an explicit spawn starts and auto picks the account (HON-40)", async () => {
  await withSleptCursorAccount(async (client, dir) => {
    const explicit = await client.request<SpawnResult>("spawn", { name: "explicit", agent: "cursor", cwd: dir, account: "cursor-slept" });
    assert.equal(explicit.account, "cursor-slept");
    const sent = await client.request<SendRpcResult>("send", { beeId: explicit.beeId, body: "hello after sleep" });
    assert.equal(await waitDelivered(client, explicit.beeId, sent.messageId, "the session starts with no action from the person"), 1);
    const spawn = (await client.request<CommandsResult>("commands", { beeId: explicit.beeId })).commands.find((command) => command.verb === "spawn");
    assert.equal(spawn?.attempts, 0, "started on the first attempt");
    assert.match(readFileSync(join(dir, "hived.log"), "utf8"), /account\.cursor\.recaptured account=cursor-slept/);
  });
  await withSleptCursorAccount(async (client, dir) => {
    const auto = await client.request<SpawnResult>("spawn", { name: "auto", agent: "cursor", cwd: dir });
    assert.equal(auto.account, "cursor-slept", "auto does not skip an account a re-capture rescues");
    const sent = await client.request<SendRpcResult>("send", { beeId: auto.beeId, body: "hello" });
    assert.equal(await waitDelivered(client, auto.beeId, sent.messageId, "auto's session starts"), 1);
  });
});

test("cursor admission: a re-start whose Cursor sign-in expired is held, not failed, and signing in releases it without spending a start attempt (HON-40)", async () => {
  const rig = cursorDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    const now = Date.now();
    writeFileSync(rig.liveAuth, cursorAuth(cursorJwt("auth0|user", now + 6 * HOUR, "first")));
    daemon = await startDaemon(rig.dir, { env: { HIVE_CURSOR_AUTH_PATH: rig.liveAuth } });
    const client = await daemon.client();
    await client.request<AccountAddResult>("account.add", { harness: "cursor", label: "a" });
    await client.request("account.capture", { id: "cursor-a" });
    const bee = await client.request<SpawnResult>("spawn", { name: "held", agent: "cursor", cwd: rig.dir, account: "cursor-a" });
    const first = await client.request<SendRpcResult>("send", { beeId: bee.beeId, body: "hello" });
    assert.equal(await waitDelivered(client, bee.beeId, first.messageId, "first delivered"), 1);
    await waitState(client, bee.beeId, "idle", "idle");
    await client.request("stop", { beeId: bee.beeId });
    await waitState(client, bee.beeId, "stopped", "stopped");

    const lapsed = cursorAuth(cursorJwt("auth0|user", now - HOUR, "first"));
    writeCursorCredential(rig.dir, "cursor-a", lapsed);
    writeFileSync(rig.liveAuth, lapsed);
    const queued = await client.request<SendRpcResult>("send", { beeId: bee.beeId, body: "while expired" });
    assert.ok(queued.commandId != null, "the send is accepted and a wake is queued");
    await waitFor(() => /runtime\.start\.held bee=\S+ account=cursor-a command=\d+ code=account_auth_needed/.test(readFileSync(join(rig.dir, "hived.log"), "utf8")) ? true : null, "held once activation's re-capture found nothing newer", 15_000);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal((await client.request<ViewResult>("view", { beeId: bee.beeId })).view.runtimeState, "stopped", "no runtime started with the expired token");

    writeFileSync(rig.liveAuth, cursorAuth(cursorJwt("auth0|user", now + 7 * HOUR, "second")));
    await client.request("account.capture", { id: "cursor-a" });
    assert.equal(await waitDelivered(client, bee.beeId, queued.messageId, "delivered after signing in"), 2);
    const wake = (await client.request<CommandsResult>("commands", { beeId: bee.beeId })).commands.find((command) => command.id === queued.commandId);
    assert.equal(wake?.status, "done");
    assert.equal(wake?.attempts, 0, "the hold and its release spent no start attempt");
    assert.doesNotMatch(readFileSync(join(rig.dir, "hived.log"), "utf8"), /start_failed/);
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    rig.cleanup();
  }
});

test("cursor admission: a start held after its activation failed re-activates on release instead of failing on the stale activation (HON-40)", async () => {
  const rig = cursorDaemonDir();
  const saved = { HOME: process.env.HOME, HIVE_NO_KEYCHAIN: process.env.HIVE_NO_KEYCHAIN, HIVE_CURSOR_AUTH_PATH: process.env.HIVE_CURSOR_AUTH_PATH, HIVE_GATEWAYS_DISABLE: process.env.HIVE_GATEWAYS_DISABLE };
  const home = mkdtempSync(join(tmpdir(), "hb-cursor-home-"));
  Object.assign(process.env, { HOME: home, HIVE_NO_KEYCHAIN: "1", HIVE_CURSOR_AUTH_PATH: rig.liveAuth, HIVE_GATEWAYS_DISABLE: "1" });
  const valid = cursorAuth(cursorJwt("auth0|user", Date.now() + 6 * HOUR, "valid"));
  writeCursorCredential(rig.dir, "cursor-a", valid);
  let seeds = 0;
  const cfg = loadNodeConfig(rig.dir);
  const daemon = new HiveDaemon(cfg, {
    keychainReader: async () => null,
    keychainWriter: async () => false,
    gatewayMcpSeeder: async () => {
      seeds += 1;
      if (seeds === 1) {
        removeCursorCredential(rig.dir, "cursor-a");
        throw new Error("fixture: gateway seeding failed while the credential went away");
      }
      return { status: "seeded", written: [] };
    },
  });
  let client: RpcClient | null = null;
  try {
    await daemon.start();
    client = await RpcClient.connect(cfg.socketPath);
    await client.request<AccountAddResult>("account.add", { harness: "cursor", label: "a", importExisting: true });
    const bee = await client.request<SpawnResult>("spawn", { name: "stale", agent: "cursor", cwd: rig.dir, account: "cursor-a" });
    const message = await client.request<SendRpcResult>("send", { beeId: bee.beeId, body: "hello" });
    await waitFor(() => /runtime\.start\.held bee=\S+ account=cursor-a command=\d+ code=account_credential_missing/.test(readFileSync(join(rig.dir, "hived.log"), "utf8")) ? true : null, "hold logged after the failed activation", 15_000);

    writeCursorCredential(rig.dir, "cursor-a", valid);
    assert.equal(await waitDelivered(client, bee.beeId, message.messageId, "delivered after the credential returned"), 1);
    const spawn = (await client.request<CommandsResult>("commands", { beeId: bee.beeId })).commands.find((command) => command.verb === "spawn");
    assert.equal(spawn?.attempts, 0, "the release re-ran activation instead of failing on the stale one");
    assert.equal(seeds, 2);
  } finally {
    client?.close();
    await daemon.shutdown({ preserveRuntimes: false }).catch(() => undefined);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
    rig.cleanup();
  }
});
