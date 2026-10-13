import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { makeDaemonDir, startDaemon, waitFor, sleep, type DaemonHandle } from "./helpers.ts";
import type { AccountCredentialAuthority } from "../../core/src/index.ts";
import type { RpcClient } from "../../cli/src/client.ts";
import { RpcError } from "../src/protocol.ts";
const GROK_OAUTH_CLIENT_ID = "fixture-public-client";
const scope = `https://auth.x.ai::${GROK_OAUTH_CLIENT_ID}`;

function token(seconds: number): string {
  return `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds, fixture: randomUUID() })).toString('base64url')}.${randomUUID()}`;
}

function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)]);
}

test("central Grok: isolated daemon rotates once, publishes access-only, refreshes early and stops at invalid_grant; native path stays native", async () => {
  const { dir, cleanup } = makeDaemonDir({ accounts: { centralRefreshAheadMs: 3_600_000, centralRefreshMinIntervalMs: 1800, centralRefreshRetryBaseMs: 100 } });
  const id = "grok-test-example.com";
  const secrets: string[] = [];
  const requests: string[] = [];
  let generation = 0;
  let refused = false;
  let unusableResponse = false;
  let omitExpiry = true;
  let daemon: DaemonHandle | null = null;
  let client: RpcClient | null = null;
  const original = randomUUID();
  secrets.push(original);
  let expected = original;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString())) as Record<string, unknown>;
    requests.push(String(body.refresh_token));
    assert.equal(req.headers["content-type"], "application/x-www-form-urlencoded");
    const valid = body.principal_type === "Team" && body.principal_id === "fixture-team" && body.client_id === GROK_OAUTH_CLIENT_ID && body.grant_type === "refresh_token" && body.refresh_token === expected;
    if (refused || !valid) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_grant", error_description: `${expected} rejected` }));
      return;
    }
    generation += 1;
    const access = token(3600);
    const refresh = randomUUID();
    secrets.push(access, refresh);
    expected = refresh;
    await sleep(80);
    res.writeHead(200, { "Content-Type": "application/json" });
    if (unusableResponse) {
      unusableResponse = false;
      res.end(JSON.stringify({ refresh_token: refresh, expires_in: 3600 }));
    } else {
      res.end(JSON.stringify({ access_token: access, refresh_token: refresh, ...(omitExpiry ? {} : { expires_in: 3600 }) }));
      omitExpiry = false;
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const seed = (account: string, lifetime: number, refresh: string) => {
      const path = join(dir, "vault", "grok", account);
      mkdirSync(path, { recursive: true });
      const access = token(lifetime);
      secrets.push(access, refresh);
      writeFileSync(join(path, "auth.json"), JSON.stringify({ [scope]: { key: access, refresh_token: refresh, oidc_client_id: GROK_OAUTH_CLIENT_ID, oidc_issuer: "https://auth.x.ai", auth_mode: "oidc", create_time: new Date().toISOString(), expires_at: new Date(Date.now() + lifetime * 1000).toISOString(), user_id: "fixture-account", principal_type: "Team", principal_id: "fixture-team" } }));
    };
    seed(id, 3600, original);
    const native = "grok-native-example.com";
    seed(native, 3600, randomUUID());
    const nativeRaw = readFileSync(join(dir, "vault", "grok", native, "auth.json"), "utf8");
    const preload = join(dir, "no-provider.mjs");
    writeFileSync(preload, `const originalFetch = globalThis.fetch; globalThis.fetch = (url, options) => { const target = String(url); if (target.startsWith("http://127.0.0.1:")) return originalFetch(url, options); if (target === "https://cli-chat-proxy.grok.com/v1/billing?format=credits") return Promise.resolve(new Response(JSON.stringify({config:{creditUsagePercent:0}}), {status:200})); throw new Error("External provider access forbidden in isolated proof"); };`);
    daemon = await startDaemon(dir, { env: { NODE_OPTIONS: `--import=${preload}`, HIVE_GROK_OAUTH_TOKEN_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, HOME: dir, GROK_HOME: join(dir, "unused") } });
    client = await daemon.client();
    const rpcResults: unknown[] = [];
    const cli = async (action: string, key?: string): Promise<AccountCredentialAuthority> => {
      const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../cli/src/bin.ts", import.meta.url)),
        "account", "credentials", action, id, "--data-dir", dir, "--json", ...(key ? ["--idempotency-key", key] : [])],
        { env: { PATH: process.env.PATH, HOME: dir, HIVE_NO_KEYCHAIN: "1" } });
      const parsed = JSON.parse(stdout);
      const result = (action === "status" ? parsed.authority : parsed) as AccountCredentialAuthority;
      rpcResults.push(result);
      return result;
    };
    const rpc = async <T>(verb: Parameters<RpcClient["request"]>[0], args: Record<string, unknown>): Promise<T> => {
      let result: T;
      try { result = await client!.request<T>(verb, args); }
      catch (error) { rpcResults.push(error instanceof Error ? error.message : String(error)); throw error; }
      if (verb !== "account.lease") rpcResults.push(result);
      return result;
    };
    await rpc("account.add", { harness: "grok", label: "test-example.com", importExisting: true });
    await rpc("account.add", { harness: "grok", label: "native-example.com", importExisting: true });
    const enabled = await waitFor(async () => {
      try { return await rpc<AccountCredentialAuthority>("account.credentials.enable", { id, idempotencyKey: randomUUID() }); }
      catch (error) {
        if (error instanceof RpcError && error.message.includes("native credential refresh is in progress")) return null;
        throw error;
      }
    }, "enrollment after native probe");
    assert.equal(enabled.phase, "ready");
    assert.equal(enabled.generation, 2);
    const cliStatus = await cli("status");
    assert.equal(cliStatus.generation, 2);
    console.log(`CLI status: phase=${cliStatus.phase} generation=${cliStatus.generation} expiry=${new Date(cliStatus.expiresAt!).toISOString()}`);
    assert.ok(enabled.expiresAt! > Date.now() + 3_500_000);
    const authorityPath = join(dir, "vault", ".credential-authorities", `${id}.json`);
    const authority = () => JSON.parse(readFileSync(authorityPath, "utf8"));
    const home = () => JSON.parse(readFileSync(join(dir, "homes", id, "auth.json"), "utf8"));
    assert.equal(statSync(authorityPath).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "vault", ".credential-authorities")).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "homes", id, "auth.json")).mode & 0o777, 0o600);
    assert.ok(authority().document[scope].refresh_token === expected);
    assert.ok(home()[scope].refresh_token === undefined);
    assert.equal(home()[scope].user_id, "fixture-account");
    console.log(`1 enable: ready generation=${enabled.generation} expiry=${new Date(enabled.expiresAt!).toISOString()} authority_refresh_present=true home_refresh_present=false authority_mode=0600 authority_dir_mode=0700 home_mode=0600 daemon_pid=${daemon.proc.pid}`);
    const ownedHome = readFileSync(join(dir, "homes", id, "auth.json"), "utf8");
    const foreign = JSON.parse(ownedHome);
    foreign[scope].refresh_token = randomUUID();
    secrets.push(foreign[scope].refresh_token);
    writeFileSync(join(dir, "homes", id, "auth.json"), JSON.stringify(foreign));
    const beforeConflict = requests.length;
    await assert.rejects(() => rpc("account.credentials.refresh", { id, idempotencyKey: "foreign" }), (error: unknown) => error instanceof RpcError && error.message.includes("external Grok"));
    assert.equal(requests.length, beforeConflict);
    assert.ok(readFileSync(join(dir, "homes", id, "auth.json"), "utf8") === JSON.stringify(foreign));
    writeFileSync(join(dir, "homes", id, "auth.json"), ownedHome);
    for (const invalid of ["{", JSON.stringify({ ...JSON.parse(ownedHome), unrelated: {} }), JSON.stringify({ "https://auth.x.ai::other-client": JSON.parse(ownedHome)[scope] })]) {
      writeFileSync(join(dir, "homes", id, "auth.json"), invalid);
      await assert.rejects(() => rpc("account.credentials.refresh", { id, idempotencyKey: randomUUID() }), (error: unknown) => error instanceof RpcError && error.message.includes("corrupt, has multiple entries, or has a conflicting OIDC scope"));
      assert.equal(requests.length, beforeConflict);
      assert.ok(readFileSync(join(dir, "homes", id, "auth.json"), "utf8") === invalid);
    }
    writeFileSync(join(dir, "homes", id, "auth.json"), ownedHome);
    const foreignAccess = JSON.parse(ownedHome);
    foreignAccess[scope].key = token(7200);
    foreignAccess[scope].user_id = "other-account";
    foreignAccess[scope].principal_id = "other-team";
    secrets.push(foreignAccess[scope].key);
    writeFileSync(join(dir, "homes", id, "auth.json"), JSON.stringify(foreignAccess));
    await assert.rejects(() => rpc("account.credentials.refresh", { id, idempotencyKey: "foreign-access" }), (error: unknown) => error instanceof RpcError && error.message.includes("external Grok"));
    assert.equal(requests.length, beforeConflict);
    assert.ok(readFileSync(join(dir, "homes", id, "auth.json"), "utf8") === JSON.stringify(foreignAccess));
    writeFileSync(join(dir, "homes", id, "auth.json"), ownedHome);
    const centralLease = await rpc<{ files: Array<{ contentB64: string }> }>("account.lease", { account: id });
    assert.ok(JSON.parse(Buffer.from(centralLease.files[0]!.contentB64, "base64").toString())[scope].refresh_token === undefined);
    console.log("ownership: foreign refresh chain and access-only principal refused without HTTP call or overwrite; central lease access-only");
    const previous = expected;
    await Promise.all([cli("refresh", "refresh"), cli("refresh", "refresh")]);
    const refreshed = await rpc<AccountCredentialAuthority>("account.credentials.status", { id });
    assert.equal(refreshed.generation, 3);
    assert.equal(requests.length, 2);
    assert.ok(requests[1] === previous && expected !== previous);
    console.log(`2 concurrent refresh: generation=${refreshed.generation} refresh_calls=1 previous_token_matched=true rotated=true`);
    await Promise.all([rpc("account.credentials.refresh", { id, idempotencyKey: "distinct-a" }), rpc("account.credentials.refresh", { id, idempotencyKey: "distinct-b" })]);
    assert.equal(requests.length, 4);
    assert.equal(new Set(requests).size, requests.length);
    console.log("distinct concurrent requests: serialized; each used its own rotated generation; no token double-spent");
    const early = await waitFor(async () => {
      const state = await rpc<AccountCredentialAuthority>("account.credentials.status", { id });
      return state.generation === 6 && state.phase === "ready" ? state : null;
    }, "automatic early refresh", 8000);
    assert.ok(early.expiresAt! > Date.now());
    assert.equal(requests.length, 5);
    console.log(`3 automatic early refresh: generation=${early.generation} before_expiry=true`);
    const previousAccess = home()[scope].key;
    unusableResponse = true;
    await assert.rejects(() => rpc("account.credentials.refresh", { id, idempotencyKey: "unusable-access" }), (error: unknown) => error instanceof RpcError && error.code === "account_unavailable");
    const pending = await rpc<AccountCredentialAuthority>("account.credentials.status", { id });
    assert.equal(pending.phase, "uncertain");
    assert.equal(pending.generation, 7);
    assert.ok(authority().document[scope].refresh_token === expected);
    assert.ok(home()[scope].key === previousAccess && home()[scope].refresh_token === undefined);
    const recovered = await waitFor(async () => {
      const state = await rpc<AccountCredentialAuthority>("account.credentials.status", { id });
      return state.phase === "ready" && state.generation === 8 ? state : null;
    }, "retry with rotated chain after unusable access");
    assert.ok(recovered.expiresAt! > Date.now());
    assert.equal(requests.length, 7);
    assert.equal(new Set(requests).size, requests.length);
    console.log("rotated unusable access: new refresh chain retained, phase uncertain, prior access-only copy preserved; retry uses new token and reaches ready generation=8");
    refused = true;
    await assert.rejects(() => rpc("account.credentials.refresh", { id, idempotencyKey: "rejected" }), (error: unknown) => error instanceof RpcError && error.code === "account_unavailable");
    const failed = await rpc<AccountCredentialAuthority>("account.credentials.status", { id });
    assert.equal(failed.phase, "login_required");
    await assert.rejects(() => rpc("account.login.start", { id }), (error: unknown) => error instanceof RpcError && error.code === "login_flow_refused" && error.message.includes("credentials disable"));
    assert.equal(failed.failure?.error, "invalid_grant");
    assert.equal(failed.failure?.retryAt, null);
    await sleep(2200);
    assert.equal(requests.length, 8);
    await assert.rejects(() => rpc("account.lease", { account: id }), (error: unknown) => error instanceof RpcError && error.code === "credential_login_required");
    console.log("4 invalid_grant: login_required retry_at=null calls_after_wait=0 native_login_fenced=true actionable_disable_login_enable=true");
    const lease = await rpc<{ files: Array<{ contentB64: string }> }>("account.lease", { account: native });
    assert.ok(JSON.parse(Buffer.from(lease.files[0]!.contentB64, "base64").toString())[scope].refresh_token === "");
    assert.ok(readFileSync(join(dir, "vault", "grok", native, "auth.json"), "utf8") === nativeRaw);
    assert.deepEqual(await rpc("account.credentials.status", { id: native }), { supported: true, phase: "native", generation: null, expiresAt: null });
    console.log("5 non-enabled account: native Grok auth unchanged; central status=native supported=true");
    await cli("disable", "disable");
    assert.ok(home()[scope].refresh_token === undefined);
    console.log("disable after refusal: disabled; unusable refresh token not restored");
    client.close(); client = null;
    await daemon.stop();
    const logs = daemon.output();
    assert.ok(secrets.every(secret => !logs.includes(secret)), "daemon logs contain no fixture credential bytes");
    assert.ok(secrets.every(secret => !JSON.stringify(rpcResults).includes(secret)), "RPC metadata contains no fixture credential bytes");
    const publicFiles = files(dir).filter(path => !path.startsWith(join(dir, "vault") + "/") && !path.startsWith(join(dir, "homes") + "/"));
    assert.ok(publicFiles.every(path => secrets.every(secret => !readFileSync(path).includes(Buffer.from(secret)))), "SQLite, journal and other non-credential files contain no fixture credential bytes");
    assert.equal(requests.filter(value => value === original).length, 1);
    assert.equal(new Set(requests).size, requests.length);
    console.log(`6 secret scan: logs=0 SQLite/ledger=0 RPC_metadata=0; daemon_pid=${daemon.proc.pid} stopped=true`);
  } finally {
    client?.close();
    if (daemon && daemon.proc.exitCode === null && daemon.proc.signalCode === null) await daemon.stop();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    cleanup();
    console.log("cleanup: owned daemon stopped; stub listener closed");
  }
});

test("central Grok review: live ownership fences, saved publication survives restart, healthy disable restores chain", async () => {
  const stub = fileURLToPath(new URL("../../../tests/fixtures/grok-acp-stub.mjs", import.meta.url));
  const { dir, cleanup } = makeDaemonDir({ accounts: { centralRefreshAheadMs: 0 }, agents: { grok: { command: process.execPath, args: [stub], adapter: "grok" } } });
  const id = "grok-review-example.com";
  let expected = randomUUID();
  const secrets: string[] = [expected];
  let refreshes = 0;
  let malformedExpiry = false;
  let daemon: DaemonHandle | null = null;
  let client: RpcClient | null = null;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = new URLSearchParams(Buffer.concat(chunks).toString());
    const valid = body.get("refresh_token") === expected;
    assert.ok(valid, "stub received current chain");
    refreshes++;
    expected = randomUUID();
    const access = token(3600);
    secrets.push(expected, access);
    await sleep(150);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ access_token: access, refresh_token: expected, ...(malformedExpiry ? { expires_in: "invalid" } : {}) }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const vault = join(dir, "vault", "grok", id);
    const home = join(dir, "homes", id);
    mkdirSync(vault, { recursive: true });
    const access = token(3600);
    secrets.push(access);
    writeFileSync(join(vault, "auth.json"), JSON.stringify({ [scope]: { auth_mode: "oidc", oidc_issuer: "https://auth.x.ai", oidc_client_id: GROK_OAUTH_CLIENT_ID, key: access, refresh_token: expected, expires_at: new Date(Date.now() + 3600_000).toISOString() } }));
    const preload = join(dir, "no-provider.mjs");
    writeFileSync(preload, `const original=globalThis.fetch;globalThis.fetch=(url,options)=>{if(String(url).startsWith('http://127.0.0.1:'))return original(url,options);if(String(url)==='https://cli-chat-proxy.grok.com/v1/billing?format=credits')return Promise.resolve(new Response(JSON.stringify({config:{creditUsagePercent:0}}),{status:200}));throw new Error('External provider access forbidden');};`);
    const env = { NODE_OPTIONS: `--import=${preload}`, HOME: dir, GROK_HOME: join(dir, "unused"), HIVE_GATEWAYS_DISABLE: "1", HIVE_GROK_OAUTH_TOKEN_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
    daemon = await startDaemon(dir, { env });
    client = await daemon.client();
    await client.request("account.add", { harness: "grok", label: "review-example.com", importExisting: true });
    const spawn = async (name: string) => {
      const result = await client!.request<{ beeId: string }>("spawn", { name, agent: "grok", cwd: dir, account: id, tags: ["autoswap=false"] });
      await waitFor(async () => ["running", "idle"].includes((await client!.request<{ view: { runtimeState: string } }>("view", { beeId: result.beeId })).view.runtimeState) ? true : null, "fake Grok running");
      return result.beeId;
    };
    const stop = async (beeId: string) => {
      await client!.request("stop", { beeId });
      await waitFor(async () => (await client!.request<{ view: { runtimeState: string } }>("view", { beeId })).view.runtimeState === "stopped" ? true : null, "fake Grok stopped");
    };
    const nativeBee = await spawn("native");
    await assert.rejects(() => client!.request("account.credentials.enable", { id, idempotencyKey: "live-enable" }), (error: unknown) => error instanceof RpcError && error.message.includes("Stop this account's local Grok"));
    assert.equal(refreshes, 0);
    await stop(nativeBee);
    await client.request("account.credentials.enable", { id, idempotencyKey: "enable" });
    const managedBee = await spawn("managed");
    await assert.rejects(() => client!.request("account.credentials.disable", { id, idempotencyKey: "live-disable" }), (error: unknown) => error instanceof RpcError && error.message.includes("Stop this account's local Grok"));
    await stop(managedBee);
    console.log("Grok ownership: live enable/disable refused; no native rotation before stopped");
    const homePath = join(home, "auth.json");
    const homeRaw = readFileSync(homePath, "utf8");
    rmSync(homePath);
    mkdirSync(homePath);
    await assert.rejects(() => client!.request("account.credentials.refresh", { id, idempotencyKey: "blocked-publish" }), (error: unknown) => error instanceof RpcError);
    assert.equal(refreshes, 2);
    const authorityPath = join(dir, "vault", ".credential-authorities", `${id}.json`);
    assert.ok(JSON.parse(readFileSync(authorityPath, "utf8")).document[scope].refresh_token === expected);
    client.close(); client = null;
    await daemon.stop();
    assert.ok(secrets.every(secret => !daemon!.output().includes(secret)), "first daemon logs contain no fixture bytes");
    rmSync(homePath, { recursive: true });
    writeFileSync(homePath, homeRaw);
    daemon = await startDaemon(dir, { env });
    client = await daemon.client();
    await waitFor(async () => (await client!.request<AccountCredentialAuthority>("account.credentials.status", { id })).phase === "ready" ? true : null, "saved publication recovered");
    assert.equal(refreshes, 2);
    assert.ok(JSON.parse(readFileSync(homePath, "utf8"))[scope].refresh_token === undefined);
    await client.request("account.credentials.disable", { id, idempotencyKey: "healthy-disable" });
    for (const path of [homePath, join(vault, "auth.json")]) assert.ok(JSON.parse(readFileSync(path, "utf8"))[scope].refresh_token === expected, "healthy disable restores latest chain");
    console.log("Grok restart: saved rotated result published without another HTTP call; healthy disable restores latest native chain");
    await client.request("account.credentials.enable", { id, idempotencyKey: "reenable" });
    malformedExpiry = true;
    const beforeMalformed = refreshes;
    await assert.rejects(() => client!.request("account.credentials.refresh", { id, idempotencyKey: "malformed-expiry" }), (error: unknown) => error instanceof RpcError && error.message.includes("malformed expiry"));
    const terminal = await client.request<AccountCredentialAuthority>("account.credentials.status", { id });
    assert.equal(terminal.phase, "login_required");
    assert.equal(terminal.failure?.error, "invalid_token_response");
    assert.equal(terminal.failure?.retryAt, null);
    assert.ok(JSON.parse(readFileSync(authorityPath, "utf8")).document[scope].refresh_token === expected);
    assert.ok(JSON.parse(readFileSync(homePath, "utf8"))[scope].refresh_token === undefined);
    client.close(); client = null;
    await daemon.stop();
    daemon = await startDaemon(dir, { env });
    client = await daemon.client();
    await sleep(1200);
    await assert.rejects(() => client!.request("account.credentials.refresh", { id, idempotencyKey: "no-second-rotation" }), (error: unknown) => error instanceof RpcError && error.message.includes("malformed expiry"));
    assert.equal(refreshes, beforeMalformed + 1);
    assert.equal((await client.request<AccountCredentialAuthority>("account.credentials.status", { id })).failure?.retryAt, null);
    console.log("Grok malformed expiry: login_required invalid_token_response retryAt=null; new private chain retained; one HTTP call total even across restart/forced refresh");

    client.close(); client = null;
    await daemon.stop();
    assert.ok(secrets.every(secret => !daemon!.output().includes(secret)), "successor logs contain no fixture bytes");
  } finally {
    client?.close();
    if (daemon && daemon.proc.exitCode === null && daemon.proc.signalCode === null) await daemon.stop();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    cleanup();
  }
});
