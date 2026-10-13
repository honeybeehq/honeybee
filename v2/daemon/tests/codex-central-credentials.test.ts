import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { makeDaemonDir, startDaemon, waitFor, sleep, type DaemonHandle } from "./helpers.ts";
import type { AccountCredentialAuthority } from "../../core/src/index.ts";
import type { RpcClient } from "../../cli/src/client.ts";
import { RpcError } from "../src/protocol.ts";
import { CODEX_OAUTH_CLIENT_ID } from "../src/codexCredentialAuthority.ts";

function token(seconds: number): string {
  return `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds, fixture: randomUUID() })).toString('base64url')}.${randomUUID()}`;
}

function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)]);
}

test("central Codex: isolated daemon rotates once, publishes access-only, refreshes early and stops at invalid_grant; native path stays native", async () => {
  const { dir, cleanup } = makeDaemonDir({ accounts: { centralRefreshAheadMs: 3_600_000, centralRefreshMinIntervalMs: 1800, centralRefreshRetryBaseMs: 100 } });
  const id = "codex-test-example.com";
  const secrets: string[] = [];
  const requests: string[] = [];
  let generation = 0;
  let refused = false;
  let daemon: DaemonHandle | null = null;
  let client: RpcClient | null = null;
  const original = randomUUID();
  secrets.push(original);
  let expected = original;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    requests.push(String(body.refresh_token));
    const valid = body.client_id === CODEX_OAUTH_CLIENT_ID && body.grant_type === "refresh_token" && body.refresh_token === expected;
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
    res.end(JSON.stringify({ access_token: access, refresh_token: refresh, ...(generation === 1 ? { id_token: "fixture-rotated-id" } : {}) }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const seed = (account: string, lifetime: number, refresh: string) => {
      const path = join(dir, "vault", "codex", account);
      mkdirSync(path, { recursive: true });
      const access = token(lifetime);
      secrets.push(access, refresh);
      writeFileSync(join(path, "auth.json"), JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: access, refresh_token: refresh, id_token: "fixture-id-token", account_id: "fixture-account" } }));
    };
    seed(id, 3600, original);
    const native = "codex-native-example.com";
    seed(native, 5, randomUUID());
    const binary = join(dir, "fake-codex");
    writeFileSync(binary, `#!${process.execPath}\nif(process.argv[2]!=='exec')process.exit(1);const fs=require('node:fs');const p=require('node:path');const home=process.env.CODEX_HOME;fs.appendFileSync(p.join(home,'native-calls'),'called\\n');const path=p.join(home,'auth.json');const doc=JSON.parse(fs.readFileSync(path));doc.tokens.access_token=Buffer.from('{}').toString('base64url')+'.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.fixture';fs.writeFileSync(path,JSON.stringify(doc));\n`);
    chmodSync(binary, 0o700);
    const cfgPath = join(dir, "config.json");
    const config = JSON.parse(readFileSync(cfgPath, "utf8"));
    config.agents.codex = { command: binary, adapter: "codex" };
    writeFileSync(cfgPath, JSON.stringify(config));
    daemon = await startDaemon(dir, { env: { HIVE_CODEX_OAUTH_TOKEN_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, HOME: dir, CODEX_HOME: join(dir, "unused") } });
    client = await daemon.client();
    const rpcResults: unknown[] = [];
    const cli = async (action: string, key?: string): Promise<AccountCredentialAuthority> => {
      const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../cli/src/bin.ts", import.meta.url)),
        "account", "credentials", action, id, "--data-dir", dir, "--json", ...(key ? ["--idempotency-key", key] : [])],
        { env: { PATH: process.env.PATH, HOME: dir, HIVE_NO_KEYCHAIN: "1" } });
      const result = JSON.parse(stdout) as AccountCredentialAuthority;
      rpcResults.push(result);
      return result;
    };
    const rpc = async <T>(verb: Parameters<RpcClient["request"]>[0], args: Record<string, unknown>): Promise<T> => {
      const result = await client!.request<T>(verb, args);
      if (verb !== "account.lease") rpcResults.push(result);
      return result;
    };
    await rpc("account.add", { harness: "codex", label: "test-example.com", importExisting: true });
    await rpc("account.add", { harness: "codex", label: "native-example.com", importExisting: true });
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
    assert.ok(enabled.expiresAt! > Date.now());
    const authorityPath = join(dir, "vault", ".credential-authorities", `${id}.json`);
    const authority = () => JSON.parse(readFileSync(authorityPath, "utf8"));
    const home = () => JSON.parse(readFileSync(join(dir, "homes", id, "auth.json"), "utf8"));
    assert.ok(authority().document.tokens.refresh_token === expected);
    assert.equal(home().tokens.refresh_token, "");
    assert.equal(home().tokens.account_id, "fixture-account");
    console.log(`1 enable: ready generation=${enabled.generation} expiry=${new Date(enabled.expiresAt!).toISOString()} authority_refresh_present=true home_refresh_present=false daemon_pid=${daemon.proc.pid}`);
    const previous = expected;
    await Promise.all([cli("refresh", "refresh"), cli("refresh", "refresh")]);
    const refreshed = await rpc<AccountCredentialAuthority>("account.credentials.status", { id });
    assert.equal(refreshed.generation, 3);
    assert.equal(requests.length, 2);
    assert.ok(home().tokens.id_token === "fixture-rotated-id");
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
    refused = true;
    await assert.rejects(() => rpc("account.credentials.refresh", { id, idempotencyKey: "rejected" }), (error: unknown) => error instanceof RpcError && error.code === "account_unavailable");
    const failed = await rpc<AccountCredentialAuthority>("account.credentials.status", { id });
    assert.equal(failed.phase, "login_required");
    assert.equal(failed.failure?.error, "invalid_grant");
    assert.equal(failed.failure?.retryAt, null);
    await sleep(2200);
    assert.equal(requests.length, 6);
    await assert.rejects(() => rpc("account.lease", { account: id }), (error: unknown) => error instanceof RpcError && error.code === "credential_login_required");
    console.log("4 invalid_grant: login_required retry_at=null calls_after_wait=0");
    const lease = await rpc<{ files: Array<{ contentB64: string }> }>("account.lease", { account: native });
    assert.equal(JSON.parse(Buffer.from(lease.files[0]!.contentB64, "base64").toString()).tokens.refresh_token, "");
    assert.ok(existsSync(join(dir, "homes", native, "native-calls")));
    assert.equal(await rpc("account.credentials.status", { id: native }), null);
    console.log("5 non-enabled account: native codex exec invoked; central status=null");
    await cli("disable", "disable");
    assert.equal(home().tokens.refresh_token, "");
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
