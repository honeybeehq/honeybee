import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, unlinkSync, statSync, rmdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import type { AccountCredentialAuthority, CredentialHandoffReceipt, MirrorAccountRow } from "../../core/src/index.ts";
import { RpcClient } from "../../cli/src/client.ts";
import { RpcError, type RpcVerb, type ViewResult } from "../src/protocol.ts";
import { forceStopTestDaemon, makeDaemonDir, startDaemon as startFixtureDaemon, waitFor as waitForState, type DaemonHandle } from "./helpers.ts";

type Exported = { receipt: CredentialHandoffReceipt; material: { generation: number; document: Record<string, unknown> } };
type Result = { handoffId: string; state: string; receipt: CredentialHandoffReceipt; generation: number; expiresAt: number };
const from = { nodeId: "dummy-node-A", deviceKey: "dummy-device-A" };
const to = { nodeId: "dummy-node-B", deviceKey: "dummy-device-B" };
const scope = "https://auth.x.ai::fixture-public-client";
function paths(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? paths(join(root, entry.name)) : entry.isFile() ? [join(root, entry.name)] : []);
}
function jwt(): string { return `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, fixture: randomUUID() })).toString("base64url")}.${randomUUID()}`; }

function writeCrashGate(path: string, rule: Record<string, unknown>) {
  const temp = `${path}.${randomUUID()}`;
  writeFileSync(temp, JSON.stringify(rule));
  renameSync(temp, path);
}

function startDaemon(dir: string, opts: Parameters<typeof startFixtureDaemon>[1]) {
  return startFixtureDaemon(dir, { ...opts, stopTimeoutMs: 30_000 });
}

function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, what: string): Promise<T> {
  return waitForState(fn, what, 30_000);
}

for (const harness of ["claude", "codex", "grok"]) test(`credential handoff ${harness}: two isolated daemons, durable prepare/commit, rotation, scrub, abort, TTL, replay and failures`, { timeout: 180_000 }, async t => {
  const a = makeDaemonDir({ accounts: { centralRefreshAheadMs: 0, centralRefreshRetryBaseMs: 60_000 } });
  const b = makeDaemonDir({ accounts: { centralRefreshAheadMs: 0, centralRefreshRetryBaseMs: 60_000 } });
  const valid = new Set<string>(), secrets: string[] = [], refreshes: string[] = [], metadata: unknown[] = [];
  let rejectToken: string | null = null, loseResponse = false, unusableResponse = false, terminalExpiry = false, refuseReleaseOnce = false;
  let corruptOnReject: string | null = null;
  let liveCappedHandoff: string | null = null;
  const fresh = () => { const value = randomUUID(); secrets.push(value); return value; };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    const body = req.headers["content-type"] === "application/x-www-form-urlencoded" ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw);
    const previous = body.refresh_token;
    refreshes.push(previous);
    if (!valid.has(previous) || previous === rejectToken) {
      if (previous === rejectToken && corruptOnReject) { mkdirSync(join(corruptOnReject, ".."), { recursive: true }); writeFileSync(corruptOnReject, "{not json"); corruptOnReject = null; }
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_grant", error_description: previous }));
      return;
    }
    if (refuseReleaseOnce) { refuseReleaseOnce = false; res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" }); res.end(JSON.stringify({ error: "rate_limit" })); return; }
    valid.delete(previous);
    const refresh = fresh(), access = harness === "codex" ? jwt() : fresh();
    secrets.push(access); valid.add(refresh);
    if (loseResponse) { loseResponse = false; res.destroy(); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...(unusableResponse ? {} : { access_token: access }), refresh_token: refresh, expires_in: terminalExpiry ? "malformed" : 3600 }));
    unusableResponse = false; terminalExpiry = false;
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`;
  let da: DaemonHandle | null = null, db: DaemonHandle | null = null, ca: RpcClient | null = null, cb: RpcClient | null = null;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => cleanupPromise ??= (async () => {
    ca?.close(); cb?.close();
    const stopped = await Promise.allSettled([da && forceStopTestDaemon(da), db && forceStopTestDaemon(db)]);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    a.cleanup(); b.cleanup();
    for (const result of stopped) if (result.status === "rejected") throw result.reason;
  })();
  t.after(cleanup);
  t.signal.addEventListener("abort", () => { void cleanup().catch(() => {}); }, { once: true });
  const env = (dir: string) => {
    const preload = join(dir, "no-provider.mjs");
    writeFileSync(preload, `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';import{join}from'node:path';import{DatabaseSync}from'node:sqlite';const readGate=(path)=>{try{return JSON.parse(fs.readFileSync(path,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}};const dbprepare=DatabaseSync.prototype.prepare;DatabaseSync.prototype.prepare=function(sql){const stmt=dbprepare.call(this,sql);if(sql.includes("VALUES('credential_handoff_identity'")){const run=stmt.run.bind(stmt);stmt.run=(...args)=>{const root=${JSON.stringify(dir)};const gate=join(root,'crash-gate.json');const rule=readGate(gate);if(rule&&rule.phase==='identity'){fs.writeFileSync(join(root,'crash-stopped'),'');process.kill(process.pid,'SIGSTOP');}return run(...args);};}return stmt;};const dbexec=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql){const result=dbexec.call(this,sql);const root=${JSON.stringify(dir)};const gate=join(root,'crash-gate.json');const rule=readGate(gate);if(rule&&rule.phase==='standdown'&&sql==='PRAGMA wal_checkpoint(FULL)'){fs.writeFileSync(join(root,'crash-stopped'),'');process.kill(process.pid,'SIGSTOP');}return result;};const f=globalThis.fetch;globalThis.fetch=async(url,o)=>{if(String(url).startsWith('http://127.0.0.1:')){{const earlyRoot=${JSON.stringify(dir)},earlyGate=join(earlyRoot,'crash-gate.json');if(readGate(earlyGate)?.phase==='early-release'){fs.writeFileSync(join(earlyRoot,'early-rotation-waiting'),'');while(fs.existsSync(earlyGate))await new Promise(r=>setTimeout(r,10));}}const response=await f(url,o);const root=${JSON.stringify(dir)};const gate=join(root,'crash-gate.json');const rule=readGate(gate);if(rule&&rule.phase==='response'){fs.writeFileSync(join(root,'crash-stopped'),'');process.kill(process.pid,'SIGSTOP');}return response;}throw new Error('External provider forbidden in isolated handoff');};const rename=fs.renameSync;fs.renameSync=(a,b)=>{const root=${JSON.stringify(dir)};const gate=join(root,'crash-gate.json');const rule=readGate(gate);if(rule&&rule.phase==='preparing'&&String(b).endsWith('/'+rule.account+'.json')){const value=JSON.parse(fs.readFileSync(a,'utf8'));if(value.generation===rule.generation){fs.writeFileSync(join(root,'crash-stopped'),'');process.kill(process.pid,'SIGSTOP');}}rename(a,b);if(rule&&rule.phase==='release-before'&&String(b).endsWith('/'+rule.account+'.json')){const value=JSON.parse(fs.readFileSync(b,'utf8'));if(value.releasePeerAttempt&&value.generation===rule.generation){fs.writeFileSync(join(root,'crash-stopped'),'');process.kill(process.pid,'SIGSTOP');}}if(rule&&rule.phase==='keyrotate'&&String(b).endsWith('/handoff-signing-key.pem')){fs.writeFileSync(join(root,'crash-stopped'),'');process.kill(process.pid,'SIGSTOP');}if(rule&&rule.phase!=='preparing'&&String(b).endsWith('/'+rule.account+'.json')){const value=JSON.parse(fs.readFileSync(b,'utf8'));if(value.generation>rule.generation){fs.writeFileSync(join(root,'crash-stopped'),'');process.kill(process.pid,'SIGSTOP');}}};syncBuiltinESMExports();`);
    return { NODE_OPTIONS: `--import=${preload}`, HOME: join(dir, "empty-user-home"), CLAUDE_CONFIG_DIR: join(dir, "unused-claude"), CODEX_HOME: join(dir, "unused-codex"), GROK_HOME: join(dir, "unused-grok"), XDG_CONFIG_HOME: join(dir, "unused-xdg-config"), XDG_DATA_HOME: join(dir, "unused-xdg-data"), HIVE_GATEWAYS_DISABLE: "1", HIVE_CLAUDE_OAUTH_TOKEN_URL: endpoint, HIVE_CODEX_OAUTH_TOKEN_URL: endpoint, HIVE_GROK_OAUTH_TOKEN_URL: endpoint };
  };
  const rpc = async <T>(client: RpcClient, action: string, params: Record<string, unknown>): Promise<T> => {
    try {
      const result = await client.request<T>(`account.credentials.${action}` as RpcVerb, params, 60_000);
      if (action !== "export") metadata.push(result);
      return result;
    } catch (error) {
      if (error instanceof RpcError) metadata.push({ code: error.code, message: error.message, details: error.details });
      throw error;
    }
  };
  const refused = async (run: () => Promise<unknown>, code: string) => assert.rejects(run, (error: unknown) => error instanceof RpcError && error.code === code);
  const tokenOf = (material: Exported) => harness === "claude" ? (material.material.document.claudeAiOauth as Record<string, unknown>).refreshToken as string : harness === "codex" ? (material.material.document.tokens as Record<string, unknown>).refresh_token as string : (material.material.document[scope] as Record<string, unknown>).refresh_token as string;
  const enroll = async (label: string) => {
    const id = `${harness}-${label}-example.com`, refresh = fresh(), access = harness === "codex" ? jwt() : fresh();
    secrets.push(access); valid.add(refresh);
    const document = harness === "claude" ? { claudeAiOauth: { accessToken: access, refreshToken: refresh, expiresAt: Date.now() + 3600000 } }
      : harness === "codex" ? { OPENAI_API_KEY: null, tokens: { access_token: access, refresh_token: refresh, id_token: "fixture", account_id: "fixture" } }
      : { [scope]: { key: access, refresh_token: refresh, oidc_client_id: "fixture-public-client", oidc_issuer: "https://auth.x.ai", auth_mode: "oidc", create_time: new Date().toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString(), principal_type: "Team", principal_id: "fixture-team", user_id: "fixture-account" } };
    const vault = join(a.dir, "vault", harness, id);
    mkdirSync(vault, { recursive: true });
    writeFileSync(join(vault, harness === "claude" ? ".credentials.json" : "auth.json"), JSON.stringify(document), { mode: 0o600 });
    await ca!.request("account.add", { id, harness, label: `${label}-example.com`, importExisting: true });
    await waitFor(async () => {
      try { return await rpc(ca!, "enable", { id, idempotencyKey: randomUUID() }); }
      catch (error) { if (error instanceof RpcError && error.message.includes("native credential refresh")) return null; throw error; }
    }, "dummy authority enrolled");
    return id;
  };
  const exported = (id: string, handoffId: string, ttlMs?: number) => rpc<Exported>(ca!, "export", { account: id, handoffId, from, to, epoch: 1, ...(ttlMs ? { ttlMs } : {}) });
  const prepare = async (id: string, handoffId: string, value: Exported) => {
    const refusal: { last: RpcError | null } = { last: null };
    try {
      return await waitFor(async () => {
        try { return await rpc<Result>(cb!, "adoptPrepare", { account: id, handoffId, from, to, authenticatedPeer: from, epoch: 1, sourceKey: value.receipt.binding.sourceKey, exportReceipt: value.receipt, material: value.material }); }
        catch (error) {
          if (error instanceof RpcError && error.code === "credential_handoff_unavailable" && ["The destination has an active credential operation.", "Credential handoff cannot proceed; inspect credential status and finish the current ownership operation."].includes(error.message)) {
            refusal.last = error;
            return null;
          }
          throw error;
        }
      }, "destination credential operation settled for preparation");
    } catch (error) {
      if (refusal.last && error instanceof Error && error.message.startsWith("waitFor timeout:")) throw new Error(`${error.message}; last refusal: ${refusal.last.code}: ${refusal.last.message}`, { cause: error });
      throw error;
    }
  };
  const commit = async (handoffId: string, prepared: Result) => {
    await rpc(ca!, "exportPrepare", { handoffId, preparedReceipt: prepared.receipt, targetKey: prepared.receipt.binding.targetKey, authenticatedPeer: to });
    return rpc<Result>(ca!, "exportCommit", { handoffId, claimId: prepared.receipt.binding.claimId });
  };
  try {
    for (const rig of [a, b]) {
      const cfgPath = join(rig.dir, "config.json"), cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      if (harness !== "grok") cfg.agents[harness] = { command: process.execPath, args: [fileURLToPath(new URL(`../../driver-hsr/test-agent/fake-${harness}.mjs`, import.meta.url)), ...(harness === "codex" ? ["app-server"] : [])], adapter: harness };
      writeFileSync(cfgPath, JSON.stringify(cfg));
    }
    da = await startDaemon(a.dir, { env: env(a.dir) }); db = await startDaemon(b.dir, { env: env(b.dir) });
    ca = await da.client(); cb = await db.client();
    await rpc(ca, "handoffIdentitySet", { identity: from });
    await rpc(cb, "handoffIdentitySet", { identity: to });
    await refused(() => rpc(cb!, "handoffIdentitySet", { identity: from }), "credential_handoff_conflict");
    for (const lane of ["node_relay", "remote"] as const) {
      const relayed = await RpcClient.connect(da.socketPath, 3000, lane);
      try {
        await refused(() => relayed.request("account.credentials.handoffIdentitySet", { identity: to, replace: true, ingress: "local_unix" }), "credential_handoff_conflict");
        await refused(() => relayed.request("account.credentials.exportPrepare", { targetKey: "untrusted-public-key", authenticatedPeer: to }), "credential_handoff_conflict");
        await refused(() => relayed.request("account.credentials.handoffStatus", { handoffId: "missing", authenticatedPeer: to }), "credential_handoff_conflict");
        await relayed.request("account.list", {});
      } finally { relayed.close(); }
    }
    assert.ok(ca.capabilities.includes("account.credentials.handoff.v1"));
    const reserveId = await enroll("reserve"), reserveInput = join(a.dir, "reserve-input.json"), reserveOutput = join(a.dir, "vault", "occupied-output.json");
    writeFileSync(reserveInput, JSON.stringify({ account: reserveId, handoffId: randomUUID(), from, to, epoch: 1 }));
    await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../cli/src/bin.ts", import.meta.url)), "account", "credentials", "export", "--file", reserveInput, "--data-dir", a.dir], { env: { PATH: process.env.PATH, HOME: a.dir, HIVE_NO_KEYCHAIN: "1" } }), (error: unknown) => error instanceof Error && /Export requires --out/.test((error as Error & { stderr?: string }).stderr ?? "") && !/TypeError/.test((error as Error & { stderr?: string }).stderr ?? ""));
    assert.equal((await rpc<AccountCredentialAuthority>(ca, "status", { id: reserveId })).phase, "ready");
    writeFileSync(reserveOutput, "{}");
    await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../cli/src/bin.ts", import.meta.url)), "account", "credentials", "export", "--file", reserveInput, "--out", reserveOutput, "--data-dir", a.dir], { env: { PATH: process.env.PATH, HOME: a.dir, HIVE_NO_KEYCHAIN: "1" } }), (error: unknown) => error instanceof Error);
    assert.equal((await rpc<AccountCredentialAuthority>(ca, "status", { id: reserveId })).phase, "ready");
    unlinkSync(reserveOutput);
    const replacementHandoff = randomUUID(), replacementExport = await exported(reserveId, replacementHandoff);
    await cb.request("account.add", { id: reserveId, harness, label: "reserve-example.com" });
    const replacementPrepared = await prepare(reserveId, replacementHandoff, replacementExport);
    const newFrom = { ...from, deviceKey: "dummy-device-A-repaired" }, newTo = { ...to, deviceKey: "dummy-device-B-repaired" };
    await refused(() => rpc(cb!, "handoffIdentitySet", { identity: newTo }), "credential_handoff_conflict");
    const identityPayload = join(b.dir, "identity-replace-input.json");
    writeFileSync(identityPayload, JSON.stringify({ identity: newTo, replace: true }));
    await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../cli/src/bin.ts", import.meta.url)), "account", "credentials", "handoff-identity-set", "--file", identityPayload, "--data-dir", b.dir], { env: { PATH: process.env.PATH, HOME: b.dir, HIVE_NO_KEYCHAIN: "1" } }), (error: unknown) => error instanceof Error && /requires explicit --replace/.test((error as Error & { stderr?: string }).stderr ?? ""));
    await rpc(cb, "handoffIdentitySet", { identity: to });
    assert.equal((await rpc<Result>(cb, "handoffStatus", { handoffId: replacementHandoff, role: "destination" })).state, "prepared");
    const { stderr: usageStderr } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../cli/src/bin.ts", import.meta.url)), "account"], { env: { PATH: process.env.PATH, HOME: b.dir, HIVE_NO_KEYCHAIN: "1" } }).catch((error: Error & { stderr: string }) => ({ stderr: error.stderr }));
    assert.match(usageStderr, /\[--replace\]/);
    writeCrashGate(join(b.dir, "crash-gate.json"), { phase: "identity" });
    const interruptedReplacement = promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../cli/src/bin.ts", import.meta.url)), "account", "credentials", "handoff-identity-set", "--file", identityPayload, "--replace", "--data-dir", b.dir, "--json"], { env: { PATH: process.env.PATH, HOME: b.dir, HIVE_NO_KEYCHAIN: "1" } }).catch(() => null);
    await waitFor(() => existsSync(join(b.dir, "crash-stopped")) ? true : null, "B stopped after shadow void before new identity pin");
    await db.kill(); cb.close(); await interruptedReplacement;
    unlinkSync(join(b.dir, "crash-gate.json")); unlinkSync(join(b.dir, "crash-stopped"));
    db = await startDaemon(b.dir, { env: env(b.dir) }); cb = await db.client();
    await rpc(cb, "handoffIdentitySet", { identity: to });
    assert.equal((await rpc<Result>(cb, "handoffStatus", { handoffId: replacementHandoff, role: "destination" })).state, "aborted");
    const { stdout: replacementStdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../cli/src/bin.ts", import.meta.url)), "account", "credentials", "handoff-identity-set", "--file", identityPayload, "--replace", "--data-dir", b.dir, "--json"], { env: { PATH: process.env.PATH, HOME: b.dir, HIVE_NO_KEYCHAIN: "1" } });
    metadata.push(replacementStdout);
    assert.equal((await rpc<Result>(cb, "handoffStatus", { handoffId: replacementHandoff, role: "destination" })).state, "aborted");
    assert.ok(!existsSync(join(b.dir, "vault", ".credential-authorities", reserveId + ".json")));
    const sourceReplace = await rpc<{ abortedExports: string[]; voidedAdoptions: string[] }>(ca, "handoffIdentitySet", { identity: newFrom, replace: true });
    assert.deepEqual(sourceReplace.abortedExports, [replacementHandoff]);
    assert.equal((await rpc<Result>(ca, "handoffStatus", { handoffId: replacementHandoff })).receipt.kind, "aborted");
    assert.equal((await rpc<AccountCredentialAuthority>(ca, "status", { id: reserveId })).phase, "ready");
    await da.kill(); ca.close(); da = await startDaemon(a.dir, { env: env(a.dir) }); ca = await da.client();
    await db.kill(); cb.close(); db = await startDaemon(b.dir, { env: env(b.dir) }); cb = await db.client();
    await refused(() => rpc(ca!, "handoffIdentitySet", { identity: from }), "credential_handoff_conflict");
    await refused(() => rpc(cb!, "handoffIdentitySet", { identity: to }), "credential_handoff_conflict");
    await rpc(ca, "handoffIdentitySet", { identity: from, replace: true });
    await rpc(cb, "handoffIdentitySet", { identity: to, replace: true });
    await refused(() => rpc(ca!, "exportPrepare", { handoffId: replacementHandoff, preparedReceipt: replacementPrepared.receipt, targetKey: replacementPrepared.receipt.binding.targetKey, authenticatedPeer: to }), "credential_handoff_decided");
    await refused(() => prepare(reserveId, replacementHandoff, replacementExport), "credential_handoff_decided");
    await rpc(ca, "refresh", { id: reserveId, idempotencyKey: randomUUID() });
    console.log(`${harness} local Unix facts only: node_relay/remote hellos refuse identity/peer/key facts and parameter spoofing; explicit --replace voids unclaimed export/prepared shadow, persists restart; post-shadow/pre-pin SIGKILL retry completes; source refresh works`);
    const id = await enroll("test"), handoffId = randomUUID();
    const value = await exported(id, handoffId), oldRefresh = tokenOf(value);
    const cliInput = join(a.dir, "handoff-input.json"), cliOutput = join(a.dir, "vault", "handoff-output.json");
    writeFileSync(cliInput, JSON.stringify({ account: id, handoffId, from, to, epoch: 1 }));
    const { stdout: exportStdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../cli/src/bin.ts", import.meta.url)), "account", "credentials", "export", "--file", cliInput, "--out", cliOutput, "--data-dir", a.dir, "--json"], { env: { PATH: process.env.PATH, HOME: a.dir, HIVE_NO_KEYCHAIN: "1" } });
    metadata.push(exportStdout);
    assert.equal(statSync(cliOutput).mode & 0o777, 0o600);
    assert.ok(tokenOf(JSON.parse(readFileSync(cliOutput, "utf8"))) === oldRefresh, "CLI exports the same chain privately");
    unlinkSync(cliOutput);
    const { stdout: statusStdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../cli/src/bin.ts", import.meta.url)), "account", "credentials", "status", id, "--data-dir", a.dir], { env: { PATH: process.env.PATH, HOME: a.dir, HIVE_NO_KEYCHAIN: "1" } });
    metadata.push(statusStdout);
    assert.ok(statusStdout.includes("handing_off") && statusStdout.includes(to.nodeId) && statusStdout.includes("since"));
    assert.equal((await rpc<AccountCredentialAuthority>(ca, "status", { id })).phase, "handing_off");
    assert.equal((await rpc<AccountCredentialAuthority>(ca, "status", { id })).handoff!.nodeId, to.nodeId);
    for (const action of ["enable", "refresh", "disable"]) await refused(() => rpc(ca!, action, { id, idempotencyKey: randomUUID() }), "credential_handoff_fenced");
    await refused(() => ca!.request("account.lease", { account: id }), "credential_handoff_fenced");
    const count = refreshes.length;
    await da.kill(); ca.close(); da = await startDaemon(a.dir, { env: env(a.dir) }); ca = await da.client();
    await waitFor(async () => (await rpc<AccountCredentialAuthority>(ca!, "status", { id })).phase === "handing_off", "restarted source export fence restored");
    assert.equal(refreshes.length, count);
    console.log(`${harness} 1/4 export fence survives A SIGKILL/restart; refresh/mint/enable/disable refused; timers skip`);
    const lease = await ca.request<{ files: unknown[] }>("account.lease", { account: id }).catch(() => null);
    assert.equal(lease, null);
    const primary = harness === "claude" ? ".credentials.json" : "auth.json";
    const accessOnly = readFileSync(join(a.dir, "homes", id, primary), "utf8");
    const installed = await cb.request<{ account: MirrorAccountRow }>("account.lease.install", { id, harness, label: "test-example.com", shareId: "12345678-test-handoff", authorityNodeId: from.nodeId, epoch: 0, expiresAt: Math.floor(Date.now() / 1000) + 3600, files: [{ homeRelPath: primary, contentB64: Buffer.from(accessOnly).toString("base64"), mode: 0o600 }] });
    const target = installed.account.id;
    let beeId: string | null = null;
    let originalRuntime: ViewResult["runtime"] = null;
    if (harness !== "grok") {
      const spawned = await cb.request<{ beeId: string }>("spawn", { name: `handoff-${harness}`, agent: harness, cwd: b.dir, account: target, tags: ["autoswap=false"] });
      beeId = spawned.beeId;
      await waitFor(async () => ["running", "idle"].includes((await cb!.request<{ view: { runtimeState: string } }>("view", { beeId })).view.runtimeState) ? true : null, "leased dummy bee running");
    }
    if (beeId) originalRuntime = (await cb.request<ViewResult>("view", { beeId })).runtime;
    await refused(() => rpc(cb!, "adoptPrepare", { account: target, handoffId, from: { ...from, nodeId: "dummy-relaying-member" }, to, authenticatedPeer: from, epoch: 1, sourceKey: value.receipt.binding.sourceKey, exportReceipt: value.receipt, material: value.material }), "credential_handoff_conflict");
    assert.equal((await rpc<Result>(ca, "handoffStatus", { handoffId })).receipt, null);
    await refused(() => rpc(ca!, "adoptPrepare", { account: id, handoffId, from, to, authenticatedPeer: from, epoch: 1, sourceKey: value.receipt.binding.sourceKey, exportReceipt: value.receipt, material: value.material }), "credential_handoff_conflict");
    const prepared = await prepare(target, handoffId, value);
    await refused(() => rpc(cb!, "handoffKeyRotate", { idempotencyKey: randomUUID() }), "credential_handoff_fenced");
    assert.equal(refreshes.length, count);
    if (beeId) await refused(() => rpc(cb!, "operatorTakeover", { account: target, confirm: true, takeoverId: randomUUID() }), "credential_handoff_fenced");
    const replay = await prepare(target, handoffId, value);
    assert.equal(replay.receipt.binding.claimId, prepared.receipt.binding.claimId);
    await db.kill(); cb.close(); db = await startDaemon(b.dir, { env: env(b.dir) }); cb = await db.client();
    const resumedPrepare = await prepare(target, handoffId, value);
    assert.equal(resumedPrepare.receipt.binding.claimId, prepared.receipt.binding.claimId);
    await refused(() => rpc(ca!, "exportPrepare", { handoffId, preparedReceipt: prepared.receipt, targetKey: value.receipt.binding.sourceKey, authenticatedPeer: to }), "credential_handoff_conflict");
    await rpc(ca, "exportPrepare", { handoffId, preparedReceipt: prepared.receipt, targetKey: prepared.receipt.binding.targetKey, authenticatedPeer: to });
    await refused(() => rpc(ca!, "exportAbort", { handoffId }), "credential_handoff_decided");
    await refused(() => rpc(ca!, "handoffIdentitySet", { identity: { ...from, deviceKey: "claimed-change" }, replace: true }), "credential_handoff_fenced");
    await refused(() => rpc(ca!, "handoffKeyRotate", { idempotencyKey: randomUUID() }), "credential_handoff_fenced");
    const committed = await commit(handoffId, prepared);
    assert.deepEqual(await rpc<Result>(ca, "exportCommit", { handoffId, claimId: prepared.receipt.binding.claimId }), committed);
    const forged = { ...committed.receipt, signature: Buffer.alloc(64).toString("base64") };
    await refused(() => rpc(cb!, "adopt", { account: target, handoffId, commitReceipt: forged }), "credential_handoff_conflict");
    await refused(() => rpc(ca!, "exportAbort", { handoffId }), "credential_handoff_decided");
    const adopted = await rpc<Result>(cb, "adopt", { account: target, handoffId, commitReceipt: committed.receipt });
    assert.equal(adopted.generation, value.material.generation + 1);
    assert.equal(refreshes.length, count + 1);
    const replayAdopt = await rpc<Result>(cb, "adopt", { account: target, handoffId, commitReceipt: committed.receipt });
    assert.deepEqual(replayAdopt, adopted);
    assert.equal(refreshes.length, count + 1);
    assert.equal((await rpc<AccountCredentialAuthority>(cb, "status", { id: target })).phase, "ready");
    const targetRow = await cb.request<{ account: MirrorAccountRow }>("account.get", { id: target });
    assert.equal(targetRow.account.source, "local"); assert.equal(targetRow.account.id, target);
    if (beeId) {
      const current = await cb.request<ViewResult>("view", { beeId });
      assert.equal(current.bee!.account, target);
      assert.equal(current.runtime!.pid, originalRuntime!.pid);
      assert.equal(current.runtime!.generation, originalRuntime!.generation);
      assert.ok(["running", "idle"].includes(current.view.runtimeState!));
    }
    assert.ok(!readFileSync(join(b.dir, "homes", target, primary)).includes(Buffer.from(oldRefresh)));
    assert.equal(valid.has(oldRefresh), false);
    console.log(`${harness} 2/4/7 prepared B survives SIGKILL before rotation; adopt rotates exactly once; replay no-op; same leased row becomes local, bee account preserved; home access-only; old token consumed`);
    const rejected = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: oldRefresh }) });
    assert.equal(rejected.status, 400);
    const afterRejectedProbe = refreshes.length;
    const privateRoot = join(a.dir, "vault", ".credential-authorities");
    const rawAuthority = readFileSync(join(privateRoot, `${id}.json`));
    writeFileSync(join(privateRoot, `${id}.previous.json`), rawAuthority, { mode: 0o600 });
    writeFileSync(join(privateRoot, `${id}.json.${randomUUID()}.tmp`), rawAuthority, { mode: 0o600 });
    if (harness === "codex") {
      mkdirSync(join(a.dir, "vault", harness, id, ".codex"), { recursive: true });
      writeFileSync(join(a.dir, "vault", harness, id, ".codex", "auth.json"), JSON.stringify(value.material.document), { mode: 0o600 });
    }
    await rpc(ca, "exportConfirm", { handoffId, adoptedReceipt: adopted.receipt });
    await rpc(ca, "exportConfirm", { handoffId, adoptedReceipt: adopted.receipt });
    for (const path of paths(a.dir).filter(path => path.startsWith(join(a.dir, "homes")) || path.startsWith(join(a.dir, "vault")))) assert.ok(!readFileSync(path).includes(Buffer.from(oldRefresh)), "source refresh bytes scrubbed");
    assert.ok(!existsSync(join(a.dir, "vault", ".credential-authorities", `${id}.json`)));
    await waitFor(async () => (await rpc<Result>(ca!, "handoffStatus", { handoffId })).state === "confirmed", "source confirmation settled");
    assert.equal(refreshes.length, afterRejectedProbe);
    await refused(() => ca!.request("account.lease", { account: id }), "credential_handoff_decided");
    await ca.request("account.limits", { id, refresh: true });
    assert.equal(refreshes.length, afterRejectedProbe);
    const newAccess = readFileSync(join(b.dir, "homes", target, primary), "utf8");
    const oldPeer = await ca.request<{ account: MirrorAccountRow }>("account.lease.install", { id, harness, label: "test-example.com", shareId: "12345678-new-authority", authorityNodeId: to.nodeId, epoch: 1, expiresAt: Math.floor(Date.now() / 1000) + 3600, adopt: true, files: [{ homeRelPath: primary, contentB64: Buffer.from(newAccess).toString("base64"), mode: 0o600 }] });
    assert.equal(oldPeer.account.id, id); assert.equal(oldPeer.account.source, "leased");
    console.log(`${harness} 3 confirm: authority removed, homes/vault/mirrors refresh-byte hits=0; source provider calls=0; old row accepts new authority lease in place`);
    const healthyId = await enroll("healthy-peer"), healthyHandoff = randomUUID(), healthyExport = await exported(healthyId, healthyHandoff);
    await cb.request("account.add", { id: healthyId, harness, label: "healthy-peer-example.com" });
    const healthyPrepared = await prepare(healthyId, healthyHandoff, healthyExport), healthyCommit = await commit(healthyHandoff, healthyPrepared);
    const healthyAdopted = await rpc<Result>(cb, "adopt", { account: healthyId, handoffId: healthyHandoff, commitReceipt: healthyCommit.receipt });
    const healthyPath = join(b.dir, "vault", ".credential-authorities", healthyId + ".json"), healthyBefore = readFileSync(healthyPath), healthyCalls = refreshes.length;
    const refusedTakeoverId = randomUUID(), refusedTakeover = await rpc<Result>(ca, "operatorTakeover", { account: healthyId, confirm: true, takeoverId: refusedTakeoverId });
    let refusalReceipt: CredentialHandoffReceipt | null = null;
    try { await rpc(cb, "operatorTakeoverApply", { takeoverReceipt: refusedTakeover.receipt, issuerKey: refusedTakeover.receipt.binding.sourceKey, authenticatedPeer: from }); assert.fail("healthy adopted peer must refuse"); }
    catch (error) {
      assert.ok(error instanceof RpcError && error.code === "credential_handoff_decided");
      refusalReceipt = error.details?.receipt as CredentialHandoffReceipt;
      assert.equal((error.details?.originalReceipt as CredentialHandoffReceipt).kind, "adopted");
    }
    assert.ok(readFileSync(healthyPath).equals(healthyBefore));
    assert.equal((await rpc<AccountCredentialAuthority>(cb, "status", { id: healthyId })).phase, "ready");
    const cancellation = { takeoverId: refusedTakeoverId, peerReceipt: refusalReceipt, peerKey: refusalReceipt!.binding.targetKey, authenticatedPeer: to };
    assert.equal((await rpc<Result>(ca, "operatorTakeoverCancel", cancellation)).state, "aborted");
    await rpc(ca, "operatorTakeoverCancel", cancellation);
    await rpc(ca, "exportConfirm", { handoffId: healthyHandoff, adoptedReceipt: healthyAdopted.receipt });
    assert.equal(refreshes.length, healthyCalls);
    console.log(`${harness} terminal adopted peer protected: typed signed refusal preserves chain byte-for-byte; issuer cancels unapplied takeover and confirms original adoption, no provider`);
    const savedId = await enroll("saved"), savedHandoff = randomUUID(), savedExport = await exported(savedId, savedHandoff);
    await cb.request("account.add", { id: savedId, harness, label: "saved-example.com" });
    const savedPrepared = await prepare(savedId, savedHandoff, savedExport), savedCommit = await commit(savedHandoff, savedPrepared);
    writeCrashGate(join(b.dir, "crash-gate.json"), { account: savedId, generation: savedExport.material.generation });
    const beforeSaved = refreshes.length;
    const pendingAdoption = rpc(cb, "adopt", { account: savedId, handoffId: savedHandoff, commitReceipt: savedCommit.receipt }).catch(() => null);
    await waitFor(() => existsSync(join(b.dir, "crash-stopped")) ? true : null, "B stopped after saving rotated result before publication");
    await db.kill(); cb.close(); await pendingAdoption;
    unlinkSync(join(b.dir, "crash-gate.json"));
    db = await startDaemon(b.dir, { env: env(b.dir) }); cb = await db.client();
    const recovered = await rpc<Result>(cb, "adopt", { account: savedId, handoffId: savedHandoff, commitReceipt: savedCommit.receipt });
    assert.equal(recovered.generation, savedExport.material.generation + 1);
    assert.equal(refreshes.length, beforeSaved + 1);
    await rpc(ca, "exportConfirm", { handoffId: savedHandoff, adoptedReceipt: recovered.receipt });
    console.log(`${harness} crash after rotated authority file save before publish: SIGKILL/restart/retry publishes saved generation, total rotations=1`);
    const preparingId = await enroll("preparing"), preparingHandoff = randomUUID(), preparingExport = await exported(preparingId, preparingHandoff);
    await cb.request("account.add", { id: preparingId, harness, label: "preparing-example.com" });
    unlinkSync(join(b.dir, "crash-stopped"));
    writeCrashGate(join(b.dir, "crash-gate.json"), { account: preparingId, generation: preparingExport.material.generation, phase: "preparing" });
    let prepareFailure: unknown;
    const pendingPrepare = prepare(preparingId, preparingHandoff, preparingExport).catch(error => { prepareFailure = error; return null; });
    await waitFor(() => {
      if (prepareFailure) throw new Error(`Preparation refused before crash boundary: ${prepareFailure instanceof RpcError ? `${prepareFailure.code}: ${prepareFailure.message}` : "transport"}`);
      return existsSync(join(b.dir, "crash-stopped"));
    }, "B stopped before prepared material rename");
    await db.kill(); cb.close(); await pendingPrepare; unlinkSync(join(b.dir, "crash-gate.json"));
    db = await startDaemon(b.dir, { env: env(b.dir) }); cb = await db.client();
    const preparingStatus = await rpc<Result>(cb, "handoffStatus", { handoffId: preparingHandoff, role: "destination" });
    assert.equal(preparingStatus.state, "preparing"); assert.equal(preparingStatus.receipt, null);
    const finishedPrepare = await prepare(preparingId, preparingHandoff, preparingExport), finishedCommit = await commit(preparingHandoff, finishedPrepare);
    const finishedAdopt = await rpc<Result>(cb, "adopt", { account: preparingId, handoffId: preparingHandoff, commitReceipt: finishedCommit.receipt });
    await rpc(ca, "exportConfirm", { handoffId: preparingHandoff, adoptedReceipt: finishedAdopt.receipt });
    console.log(`${harness} preparation crash: durable preparing state exposes no receipt before material fsync; replay completes then one rotation`);
    const abortId = await enroll("abort"), abortHandoff = randomUUID(), abortedExport = await exported(abortId, abortHandoff);
    const aborted = await rpc<Result>(ca, "exportAbort", { handoffId: abortHandoff });
    await cb.request("account.add", { id: abortId, harness, label: "abort-example.com" });
    const abandonedPrepared = await prepare(abortId, abortHandoff, abortedExport);
    await refused(() => rpc(ca!, "exportPrepare", { handoffId: abortHandoff, preparedReceipt: abandonedPrepared.receipt, targetKey: abandonedPrepared.receipt.binding.targetKey, authenticatedPeer: to }), "credential_handoff_decided");
    const abortedTakeoverId = randomUUID(), abortedTakeover = await rpc<Result>(cb, "operatorTakeover", { account: abortId, confirm: true, takeoverId: abortedTakeoverId });
    let abortedRefusal: CredentialHandoffReceipt | null = null;
    try { await rpc(ca, "operatorTakeoverApply", { takeoverReceipt: abortedTakeover.receipt, issuerKey: abortedTakeover.receipt.binding.sourceKey, authenticatedPeer: to }); assert.fail("unprepared aborted source must refuse"); }
    catch (error) {
      assert.ok(error instanceof RpcError && error.code === "credential_handoff_decided");
      abortedRefusal = error.details?.receipt as CredentialHandoffReceipt;
      assert.equal((error.details?.originalReceipt as CredentialHandoffReceipt).kind, "aborted");
    }
    await rpc(cb, "operatorTakeoverCancel", { takeoverId: abortedTakeoverId, peerReceipt: abortedRefusal, peerKey: abortedRefusal!.binding.targetKey, authenticatedPeer: from });
    await rpc(cb, "adoptAbort", { handoffId: abortHandoff, abortReceipt: aborted.receipt });
    await refused(() => rpc(cb!, "adopt", { account: abortId, handoffId: abortHandoff, commitReceipt: committed.receipt }), "credential_handoff_conflict");
    await rpc(ca, "refresh", { id: abortId, idempotencyKey: randomUUID() });
    console.log(`${harness} 5 abort restores A; delayed prepare cannot commit; signed abort cleans B; unprepared source refuses/cancels takeover with signed abort; delayed adopt refused`);
    const rotateId = await enroll("rotate"), rotateHandoff = randomUUID(), rotateExport = await exported(rotateId, rotateHandoff);
    const rotationParams = { idempotencyKey: randomUUID() }, beforeRotation = refreshes.length;
    const rotation = await rpc<{ publicKey: string; abortedHandoffIds: string[]; disposition: string; providerCalled: boolean }>(ca, "handoffKeyRotate", rotationParams);
    assert.equal(rotation.disposition, "rotated");
    assert.equal(rotation.providerCalled, false);
    assert.notEqual(rotation.publicKey, rotateExport.receipt.binding.sourceKey);
    assert.deepEqual(rotation.abortedHandoffIds, [rotateHandoff]);
    assert.deepEqual(await rpc(ca, "handoffKeyRotate", rotationParams), { ...rotation, deduped: true });
    const signingRoot = join(a.dir, "vault", ".credential-authorities"), signingPath = join(signingRoot, "handoff-signing-key.pem");
    assert.equal(statSync(signingRoot).mode & 0o777, 0o700);
    assert.equal(statSync(signingPath).mode & 0o777, 0o600);
    assert.equal(refreshes.length, beforeRotation);
    assert.equal((await rpc<AccountCredentialAuthority>(ca, "status", { id: rotateId })).phase, "ready");
    const rotationAbort = await rpc<Result>(ca, "exportAbort", { handoffId: rotateHandoff });
    await cb.request("account.add", { id: rotateId, harness, label: "rotate-example.com" });
    const lateRotationPrepare = await prepare(rotateId, rotateHandoff, rotateExport);
    await refused(() => rpc(ca!, "exportPrepare", { handoffId: rotateHandoff, preparedReceipt: lateRotationPrepare.receipt, targetKey: lateRotationPrepare.receipt.binding.targetKey, authenticatedPeer: to }), "credential_handoff_decided");
    await rpc(cb, "adoptAbort", { handoffId: rotateHandoff, abortReceipt: rotationAbort.receipt });
    await da.kill(); ca.close(); da = await startDaemon(a.dir, { env: env(a.dir) }); ca = await da.client();
    assert.deepEqual(await rpc(ca, "handoffKeyRotate", rotationParams), { ...rotation, deduped: true });
    const nextRotationHandoff = randomUUID(), nextRotationExport = await exported(rotateId, nextRotationHandoff);
    assert.equal(nextRotationExport.receipt.binding.sourceKey, rotation.publicKey);
    await rpc(ca, "exportAbort", { handoffId: nextRotationHandoff });
    const crashKeyHandoff = randomUUID(), crashKeyExport = await exported(rotateId, crashKeyHandoff), crashKeyParams = { idempotencyKey: randomUUID() };
    writeCrashGate(join(a.dir, "crash-gate.json"), { phase: "keyrotate", account: rotateId });
    const crashRotation = rpc(ca, "handoffKeyRotate", crashKeyParams).catch(() => null);
    await waitFor(() => existsSync(join(a.dir, "crash-stopped")) ? true : null, "A stopped after signing key replacement");
    await da.kill(); ca.close(); await crashRotation;
    unlinkSync(join(a.dir, "crash-gate.json")); unlinkSync(join(a.dir, "crash-stopped"));
    da = await startDaemon(a.dir, { env: env(a.dir) }); ca = await da.client();
    assert.equal((await rpc<Result>(ca, "handoffStatus", { handoffId: crashKeyHandoff })).state, "aborted");
    assert.equal((await rpc<AccountCredentialAuthority>(ca, "status", { id: rotateId })).phase, "ready");
    await rpc(ca, "handoffKeyRotate", crashKeyParams);
    const crashAbort = await rpc<Result>(ca, "exportAbort", { handoffId: crashKeyHandoff });
    await prepare(rotateId, crashKeyHandoff, crashKeyExport);
    await rpc(cb, "adoptAbort", { handoffId: crashKeyHandoff, abortReceipt: crashAbort.receipt });
    assert.equal(refreshes.length, beforeRotation);
    await rpc(ca, "refresh", { id: rotateId, idempotencyKey: randomUUID() });
    console.log(`${harness} key rotation: unclaimed export durably aborted; old pinned key verifies abort; prepared claims refuse; peer node mismatch refused; 0700/0600; duplicate/restart replay no-op; key-replacement SIGKILL keeps exports aborted; no provider call`);
    const ttlId = await enroll("ttl"), ttlHandoff = randomUUID(), ttlExport = await exported(ttlId, ttlHandoff, 1000);
    await waitFor(async () => (await rpc<AccountCredentialAuthority>(ca!, "status", { id: ttlId })).phase === "ready" ? true : null, "expired unprepared export auto-aborted");
    await da.kill(); ca.close(); da = await startDaemon(a.dir, { env: env(a.dir) }); ca = await da.client();
    assert.equal((await rpc<AccountCredentialAuthority>(ca, "status", { id: ttlId })).phase, "ready");
    assert.equal((await rpc<Result>(ca, "handoffStatus", { handoffId: ttlHandoff })).state, "aborted");
    await cb.request("account.add", { id: ttlId, harness, label: "ttl-example.com" });
    const ttlPrepared = await prepare(ttlId, ttlHandoff, ttlExport);
    await refused(() => rpc(ca!, "exportPrepare", { handoffId: ttlHandoff, preparedReceipt: ttlPrepared.receipt, targetKey: ttlPrepared.receipt.binding.targetKey, authenticatedPeer: to }), "credential_handoff_decided");
    const ttlAborted = await rpc<Result>(ca, "exportAbort", { handoffId: ttlHandoff });
    await rpc(cb, "adoptAbort", { handoffId: ttlHandoff, abortReceipt: ttlAborted.receipt });
    await rpc(ca, "exportAbort", { handoffId: ttlHandoff });
    console.log(`${harness} TTL unprepared export auto-aborts, survives restart, signed abort receipt available; late preparation cannot commit; source alone judges TTL`);
    const failId = await enroll("rejected"), failHandoff = randomUUID(), failExport = await exported(failId, failHandoff);
    await cb.request("account.add", { id: failId, harness, label: "rejected-example.com" });
    const failPrepared = await prepare(failId, failHandoff, failExport), failCommit = await commit(failHandoff, failPrepared);
    const untouchedSettings = join(b.dir, "homes", failId, "settings.json");
    mkdirSync(join(b.dir, "homes", failId), { recursive: true });
    writeFileSync(untouchedSettings, "{not json");
    rejectToken = tokenOf(failExport);
    await refused(() => rpc(cb!, "adopt", { account: failId, handoffId: failHandoff, commitReceipt: failCommit.receipt }), "credential_handoff_rejected");
    assert.equal((await rpc<AccountCredentialAuthority>(cb, "status", { id: failId })).phase, "native");
    assert.ok(!existsSync(join(b.dir, "vault", ".credential-authorities", `${failId}.json`)));
    await refused(() => rpc(ca!, "exportAbort", { handoffId: failHandoff }), "credential_handoff_decided");
    assert.equal(readFileSync(untouchedSettings, "utf8"), "{not json");
    await db.kill(); cb.close(); db = await startDaemon(b.dir, { env: env(b.dir) }); cb = await db.client();
    assert.equal((await rpc<AccountCredentialAuthority>(cb, "status", { id: failId })).phase, "native");
    rejectToken = null;
    console.log(`${harness} 6 invalid_grant typed; B not enabled/no authority; malformed settings untouched, B restart/RPC healthy; A committed_fenced, explicit operator takeover required`);
    const failedTakeoverId = randomUUID(), failedCalls = refreshes.length;
    const failAccessOnly = readFileSync(join(a.dir, "homes", failId, primary));
    await cb.request("account.lease.install", { id: failId, harness, label: "rejected-example.com", shareId: "12345678-failed-takeover", authorityNodeId: from.nodeId, epoch: 1, expiresAt: Math.floor(Date.now() / 1000) + 3600, files: [{ homeRelPath: primary, contentB64: failAccessOnly.toString("base64"), mode: 0o600 }] });
    const failedTakeover = await rpc<Result>(cb, "operatorTakeover", { account: failId, confirm: true, takeoverId: failedTakeoverId });
    const failedAck = await rpc<Result>(ca, "operatorTakeoverApply", { takeoverReceipt: failedTakeover.receipt, issuerKey: failedTakeover.receipt.binding.sourceKey, authenticatedPeer: to });
    await rpc(cb, "operatorTakeoverComplete", { takeoverId: failedTakeoverId, peerReceipt: failedAck.receipt, peerKey: failedAck.receipt.binding.targetKey, authenticatedPeer: from });
    const failedRow = (await cb.request<{ accounts: MirrorAccountRow[] }>("account.list", {})).accounts.find(account => account.id === failId)!;
    assert.equal(failedRow.source, "local"); assert.equal(failedRow.status, "auth_needed");
    assert.equal(refreshes.length, failedCalls);
    await refused(() => rpc(cb!, "operatorTakeover", { account: failId, confirm: true, takeoverId: randomUUID() }), "credential_handoff_decided");
    console.log(`${harness} failed destination operator take-over: retained leased row becomes local/native-login-required; both sides scrub, no provider`);

    const cleanupId = await enroll("cleanup"), cleanupHandoff = randomUUID(), cleanupExport = await exported(cleanupId, cleanupHandoff);
    await cb.request("account.add", { id: cleanupId, harness, label: "cleanup-example.com" });
    const cleanupPrepared = await prepare(cleanupId, cleanupHandoff, cleanupExport), cleanupCommit = await commit(cleanupHandoff, cleanupPrepared);
    rejectToken = tokenOf(cleanupExport); corruptOnReject = join(b.dir, "homes", cleanupId, primary);
    await assert.rejects(() => rpc(cb!, "adopt", { account: cleanupId, handoffId: cleanupHandoff, commitReceipt: cleanupCommit.receipt }), (error: unknown) => error instanceof RpcError && error.code === "credential_handoff_rejected" && error.details?.destinationDisposition === "cleanup_pending");
    await db.kill(); cb.close(); db = await startDaemon(b.dir, { env: env(b.dir) }); cb = await db.client();
    assert.equal((await rpc<Result & { cleanupPending: boolean }>(cb, "handoffStatus", { handoffId: cleanupHandoff, role: "destination" })).cleanupPending, true);
    await refused(() => rpc(cb!, "enable", { id: cleanupId, idempotencyKey: randomUUID() }), "credential_handoff_fenced");
    writeFileSync(join(b.dir, "homes", cleanupId, primary), readFileSync(join(a.dir, "homes", cleanupId, primary)), { mode: 0o600 });
    await waitFor(async () => !(await rpc<Result & { cleanupPending: boolean }>(cb!, "handoffStatus", { handoffId: cleanupHandoff, role: "destination" })).cleanupPending ? true : null, "background cleanup after storage repair");
    assert.equal((await rpc<AccountCredentialAuthority>(cb, "status", { id: cleanupId })).phase, "native");
    rejectToken = null;
    console.log(`${harness} pending cleanup: typed rejection survives unreadable material; restart serves RPC; affected account fenced; repair triggers background scrub`);
    const retainedId = await enroll("retained"), retainedHandoff = randomUUID(), retainedExport = await exported(retainedId, retainedHandoff);
    await cb.request("account.add", { id: retainedId, harness, label: "retained-example.com" });
    const retainedPrepared = await prepare(retainedId, retainedHandoff, retainedExport), retainedCommit = await commit(retainedHandoff, retainedPrepared);
    unusableResponse = true;
    await refused(() => rpc(cb!, "adopt", { account: retainedId, handoffId: retainedHandoff, commitReceipt: retainedCommit.receipt }), "credential_handoff_unusable_access");
    const retainedDocument = JSON.parse(readFileSync(join(b.dir, "vault", ".credential-authorities", `${retainedId}.json`), "utf8")).document;
    const retainedRefresh = tokenOf({ ...retainedExport, material: { ...retainedExport.material, document: retainedDocument } });
    assert.ok(retainedRefresh !== tokenOf(retainedExport) && valid.has(retainedRefresh), "known new refresh chain retained despite missing access");
    const retainedCalls = refreshes.length;
    const initialRetained: { outcome: string; retainedGeneration: number; retainedChainRecoveryAvailable: boolean } = await rpc(cb, "handoffStatus", { handoffId: retainedHandoff, role: "destination" });
    assert.equal(initialRetained.outcome, "retained_unusable"); assert.equal(initialRetained.retainedGeneration, retainedExport.material.generation + 1); assert.equal(initialRetained.retainedChainRecoveryAvailable, true);
    await refused(() => rpc(cb!, "adopt", { account: retainedId, handoffId: retainedHandoff, commitReceipt: retainedCommit.receipt }), "credential_handoff_unusable_access");
    assert.equal(refreshes.length, retainedCalls);
    assert.equal(refreshes.filter(value => value === tokenOf(retainedExport)).length, 1);
    console.log(`${harness} known rotated chain with missing access: retained_unusable, public saved generation/eligibility; adopt replay no provider`);
    await refused(() => rpc(cb!, "adopt", { account: retainedId, handoffId: retainedHandoff, commitReceipt: retainedCommit.receipt, retainedGeneration: initialRetained.retainedGeneration - 1 }), "credential_handoff_conflict");
    const livePayload = join(b.dir, "live-retained-adopt.json"); writeFileSync(livePayload, JSON.stringify({ account: retainedId, handoffId: retainedHandoff, commitReceipt: retainedCommit.receipt, retainedGeneration: initialRetained.retainedGeneration }));
    const { stdout: liveOutput } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../cli/src/bin.ts", import.meta.url)), "account", "credentials", "adopt", "--file", livePayload, "--data-dir", b.dir, "--json"], { env: { PATH: process.env.PATH, HOME: b.dir, HIVE_NO_KEYCHAIN: "1" } });
    metadata.push(liveOutput); const liveRecovered: Result = JSON.parse(liveOutput);
    assert.equal(liveRecovered.generation, initialRetained.retainedGeneration + 1); assert.equal(refreshes.length, retainedCalls + 1);
    const { stdout: payloadReplay } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../cli/src/bin.ts", import.meta.url)), "account", "credentials", "adopt", "--file", livePayload, "--data-dir", b.dir, "--json"], { env: { PATH: process.env.PATH, HOME: b.dir, HIVE_NO_KEYCHAIN: "1" } });
    metadata.push(payloadReplay); assert.equal((JSON.parse(payloadReplay) as Result).generation, liveRecovered.generation);
    assert.equal(refreshes.length, retainedCalls + 1);

    await rpc(cb, "adopt", { account: retainedId, handoffId: retainedHandoff, commitReceipt: retainedCommit.receipt, retainedGeneration: initialRetained.retainedGeneration });
    assert.equal(refreshes.length, retainedCalls + 1);
    await rpc(ca, "exportConfirm", { handoffId: retainedHandoff, adoptedReceipt: liveRecovered.receipt });
    console.log(`${harness} live member initial retained recovery: explicit generation in protected CLI payload rotates saved chain once, identical payload replay no provider, signed normal completion`);

    if (harness === "grok") {
      const terminalId = await enroll("terminal"), terminalHandoff = randomUUID(), terminalExport = await exported(terminalId, terminalHandoff);
      await cb.request("account.add", { id: terminalId, harness, label: "terminal-example.com" });
      const terminalPrepared = await prepare(terminalId, terminalHandoff, terminalExport), terminalCommit = await commit(terminalHandoff, terminalPrepared);
      terminalExpiry = true;
      await refused(() => rpc(cb!, "adopt", { account: terminalId, handoffId: terminalHandoff, commitReceipt: terminalCommit.receipt }), "credential_handoff_unusable_access");
      const retained = JSON.parse(readFileSync(join(b.dir, "vault", ".credential-authorities", `${terminalId}.json`), "utf8"));
      assert.ok(valid.has(tokenOf({ ...terminalExport, material: { ...terminalExport.material, document: retained.document } })), "terminal malformed expiry retains the new chain");
      const terminalCount = refreshes.length;
      await waitFor(async () => (await rpc<AccountCredentialAuthority>(cb!, "status", { id: terminalId })).phase === "login_required", "terminal unusable-access authority settled");
      await refused(() => rpc(cb!, "adopt", { account: terminalId, handoffId: terminalHandoff, commitReceipt: terminalCommit.receipt }), "credential_handoff_unusable_access");
      assert.equal(refreshes.length, terminalCount);
      console.log("grok terminal malformed expiry: replacement chain kept privately, login_required_retained, zero further rotations on retry");
    }
    const unknownId = await enroll("unknown"), unknownHandoff = randomUUID(), unknownExport = await exported(unknownId, unknownHandoff);
    await cb.request("account.add", { id: unknownId, harness, label: "unknown-example.com" });
    const unknownPrepared = await prepare(unknownId, unknownHandoff, unknownExport), unknownCommit = await commit(unknownHandoff, unknownPrepared);
    loseResponse = true;
    await refused(() => rpc(cb!, "adopt", { account: unknownId, handoffId: unknownHandoff, commitReceipt: unknownCommit.receipt }), "credential_handoff_uncertain");
    assert.equal((await rpc<AccountCredentialAuthority>(cb, "status", { id: unknownId })).phase, "uncertain");
    assert.ok(existsSync(join(b.dir, "vault", ".credential-authorities", `${unknownId}.json`)));
    const unknownCalls = refreshes.length;
    await db.kill(); cb.close(); db = await startDaemon(b.dir, { env: env(b.dir) }); cb = await db.client();
    await refused(() => rpc(cb!, "adopt", { account: unknownId, handoffId: unknownHandoff, commitReceipt: unknownCommit.receipt }), "credential_handoff_uncertain");
    assert.equal(refreshes.length, unknownCalls);
    console.log(`${harness} unknown response: durable uncertain destination, private material retained, source committed fence held`);
    const responseId = await enroll("response-window"), responseHandoff = randomUUID(), responseExport = await exported(responseId, responseHandoff);
    await cb.request("account.add", { id: responseId, harness, label: "response-window-example.com" });
    const responsePrepared = await prepare(responseId, responseHandoff, responseExport), responseCommit = await commit(responseHandoff, responsePrepared);
    const responseCalls = refreshes.length;
    if (existsSync(join(b.dir, "crash-stopped"))) unlinkSync(join(b.dir, "crash-stopped"));
    writeCrashGate(join(b.dir, "crash-gate.json"), { phase: "response", account: responseId });
    const responseAdopt = rpc(cb, "adopt", { account: responseId, handoffId: responseHandoff, commitReceipt: responseCommit.receipt }).catch(() => null);
    await waitFor(() => existsSync(join(b.dir, "crash-stopped")) ? true : null, "B stopped after provider response before durable save");
    await db.kill(); cb.close(); await responseAdopt;
    unlinkSync(join(b.dir, "crash-gate.json")); unlinkSync(join(b.dir, "crash-stopped"));
    db = await startDaemon(b.dir, { env: env(b.dir) }); cb = await db.client();
    await refused(() => rpc(cb!, "adopt", { account: responseId, handoffId: responseHandoff, commitReceipt: responseCommit.receipt }), "credential_handoff_uncertain");
    assert.equal(refreshes.length, responseCalls + 1);
    assert.equal((await rpc<AccountCredentialAuthority>(cb, "status", { id: responseId })).phase, "uncertain");
    assert.ok(existsSync(join(b.dir, "vault", ".credential-authorities", responseId + ".json")));
    console.log(`${harness} response-before-save SIGKILL: outcome unknown, source committed, destination retained privately; retry calls provider zero times; explicit native takeover required`);
    const takeoverId = randomUUID(), takeoverCalls = refreshes.length;
    await refused(() => rpc(ca!, "operatorTakeover", { account: responseId, takeoverId }), "invalid_request");
    const { stdout: takeoverStdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../cli/src/bin.ts", import.meta.url)), "account", "credentials", "take-over", responseId, "--confirm", "--takeover-id", takeoverId, "--data-dir", a.dir, "--json"], { env: { PATH: process.env.PATH, HOME: a.dir, HIVE_NO_KEYCHAIN: "1" } });
    metadata.push(takeoverStdout);
    const takeover = await rpc<Result>(ca, "operatorTakeover", { account: responseId, confirm: true, takeoverId });
    assert.equal(takeover.receipt.kind, "operator_takeover");
    await refused(() => ca!.request("account.login.start", { id: responseId }), "credential_handoff_fenced");
    await refused(() => rpc(cb!, "operatorTakeoverApply", { takeoverReceipt: takeover.receipt, issuerKey: takeover.receipt.binding.sourceKey, authenticatedPeer: to }), "credential_handoff_conflict");
    const applyParams = { takeoverReceipt: takeover.receipt, issuerKey: takeover.receipt.binding.sourceKey, authenticatedPeer: from };
    const takenDown = await rpc<Result>(cb, "operatorTakeoverApply", applyParams);
    assert.equal(takenDown.receipt.kind, "operator_taken_down");
    assert.deepEqual(await rpc(cb, "operatorTakeoverApply", applyParams), takenDown);
    await da.kill(); ca.close(); da = await startDaemon(a.dir, { env: env(a.dir) }); ca = await da.client();
    const completeParams = { takeoverId, peerReceipt: takenDown.receipt, peerKey: takenDown.receipt.binding.targetKey, authenticatedPeer: to };
    const takenOver = await rpc<Result>(ca, "operatorTakeoverComplete", completeParams);
    assert.equal(takenOver.state, "stood_down");
    assert.deepEqual(await rpc(ca, "operatorTakeoverComplete", completeParams), takenOver);
    assert.equal(refreshes.length, takeoverCalls);
    const takeoverAccount = (await ca.request<{ accounts: MirrorAccountRow[] }>("account.list", {})).accounts.find(account => account.id === responseId)!;
    assert.equal(takeoverAccount.source, "local");
    assert.equal(takeoverAccount.status, "auth_needed");
    for (const dir of [a.dir, b.dir]) assert.ok(!existsSync(join(dir, "vault", ".credential-authorities", responseId + ".json")));
    console.log(`${harness} explicit take-over CLI: confirm required, signed self/higher epoch; both sides scrubbed without provider; local login fenced until verified peer acknowledgment; restart/replay no-op; issuer same row local/auth_needed`);
    const retryStandId = await enroll("standdown-retry");
    const retryStandState = await rpc<AccountCredentialAuthority>(ca, "status", { id: retryStandId });
    const retryStandReceipt = await rpc<{ receipt: CredentialHandoffReceipt }>(cb, "standDownReceipt", { account: target, targetAccount: retryStandId, targetGeneration: retryStandState.generation, to: from, epoch: 2 });
    const retryStandParams = { account: retryStandId, epoch: 2, standDownReceipt: retryStandReceipt.receipt, authorityKey: retryStandReceipt.receipt.binding.sourceKey, authenticatedPeer: to };
    const retryStandPath = join(a.dir, "homes", retryStandId, primary), retryStandRaw = readFileSync(retryStandPath);
    if (harness !== "grok") {
      const busy = await ca.request<{ beeId: string }>("spawn", { name: `standdown-${harness}`, agent: harness, cwd: a.dir, account: retryStandId, tags: ["autoswap=false"] });
      await waitFor(async () => ["running", "idle"].includes((await ca!.request<ViewResult>("view", { beeId: busy.beeId })).view.runtimeState!) ? true : null, "stand-down dummy bee running");
      const calls = refreshes.length;
      await refused(() => rpc(ca!, "standDown", retryStandParams), "credential_handoff_fenced");
      assert.deepEqual(readFileSync(retryStandPath), retryStandRaw);
      assert.equal((await rpc<AccountCredentialAuthority>(ca, "status", { id: retryStandId })).phase, "ready");
      assert.equal(refreshes.length, calls);
      await ca.request("stop", { beeId: busy.beeId });
      await waitFor(async () => (await ca!.request<ViewResult>("view", { beeId: busy.beeId })).view.runtimeState === "stopped" ? true : null, "stand-down dummy bee stopped");
      console.log(`${harness} standDown running-bee fence: refusal before scrub/epoch/operation changes, no provider; explicit stop permits retry`);
    }
    writeFileSync(retryStandPath, "{");
    const retryStandCalls = refreshes.length;
    await refused(() => rpc(ca!, "standDown", retryStandParams), "credential_handoff_unavailable");
    assert.equal((await rpc<AccountCredentialAuthority>(ca, "status", { id: retryStandId })).phase, "ready");
    await refused(() => rpc(ca!, "refresh", { id: retryStandId, idempotencyKey: randomUUID() }), "credential_handoff_fenced");
    await da.kill(); ca.close(); da = await startDaemon(a.dir, { env: env(a.dir) }); ca = await da.client();
    writeFileSync(retryStandPath, retryStandRaw);
    writeCrashGate(join(a.dir, "crash-gate.json"), { phase: "standdown", account: retryStandId });
    const stoppedStandDown = rpc(ca, "standDown", retryStandParams).catch(() => null);
    await waitFor(() => existsSync(join(a.dir, "crash-stopped")) ? true : null, "A stopped after demotion before terminal handoff row");
    await da.kill(); ca.close(); await stoppedStandDown;
    unlinkSync(join(a.dir, "crash-gate.json")); unlinkSync(join(a.dir, "crash-stopped"));
    da = await startDaemon(a.dir, { env: env(a.dir) }); ca = await da.client();
    await rpc(ca, "standDown", retryStandParams);
    assert.equal(refreshes.length, retryStandCalls);
    console.log(`${harness} signed standDown: unauthenticated/mismatched receipt refused; scrub failure preserves phase, durable operation fences; restart/repair and post-demotion SIGKILL same-receipt retry complete without provider`);
    const beforeStandDown = refreshes.length;
    await refused(() => rpc(ca!, "standDown", { account: unknownId, epoch: 2 }), "invalid_request");
    const signedStandDown = await rpc<{ receipt: CredentialHandoffReceipt }>(cb, "standDownReceipt", { account: target, targetAccount: unknownId, targetGeneration: unknownExport.material.generation, to: from, epoch: 2 });
    const standParams = { account: unknownId, epoch: 2, standDownReceipt: signedStandDown.receipt, authorityKey: signedStandDown.receipt.binding.sourceKey, authenticatedPeer: to };
    await refused(() => rpc(ca!, "standDown", { ...standParams, authenticatedPeer: from }), "credential_handoff_conflict");
    await rpc(ca, "standDown", standParams);
    await rpc(ca, "standDown", standParams);
    assert.equal(refreshes.length, beforeStandDown);
    for (const path of paths(a.dir).filter(path => path.startsWith(join(a.dir, "homes")) || path.startsWith(join(a.dir, "vault")))) assert.ok(!readFileSync(path).includes(Buffer.from(tokenOf(unknownExport))));
    console.log(`${harness} 8 standDown scrubs without provider call`);
    const orgId = randomUUID(), genesis = createHash("sha256").update("fixture-genesis").digest("hex"), heads = [createHash("sha256").update("fixture-membership-head").digest("hex")];
    const roster = { orgId, genesis, heads, version: createHash("sha256").update(JSON.stringify([orgId, genesis, heads])).digest("hex"), authorNodeId: from.nodeId, authorCounter: 1, members: [from.nodeId] };
    type Released = { outcome: string; disposition: string; abortReceipt: CredentialHandoffReceipt | null; requiredEpoch: number; generation: number; message: string; cleanupPending: boolean; providerCalled: boolean; retryable: boolean; rotationScheduled: boolean; retainedGeneration?: number; retainedUnusableCount?: number; failureReason?: string; cappedRetainedDiscardAvailable?: boolean };
    const releaseFixture = async (label: string, leased = false) => {
      const account = await enroll(`release-${label}`), handoffId = randomUUID(), material = await exported(account, handoffId);
      await cb!.request("account.add", { id: account, harness, label: `release-${label}-example.com` });
      if (leased) await cb!.request("account.lease.install", { id: account, harness, label: `release-${label}-example.com`, shareId: "12345678-release-destination", adopt: true, authorityNodeId: from.nodeId, epoch: 0, expiresAt: Math.floor(Date.now() / 1000) + 3600, files: [{ homeRelPath: primary, contentB64: readFileSync(join(a.dir, "homes", account, primary)).toString("base64"), mode: 0o600 }] });
      const prepared = await prepare(account, handoffId, material), committed = await commit(handoffId, prepared);
      return { account, handoffId, material, committed, params: { account, handoffId, confirm: true, roster } };
    };
    assert.ok(ca.capabilities.includes("account.credentials.release_peer.v1"));
    const destinationRoster = { ...roster, authorNodeId: to.nodeId, members: [to.nodeId] };
    const interruptedDestination = await enroll("release-destination-preparing"), interruptedClaim = randomUUID(), interruptedMaterial = await exported(interruptedDestination, interruptedClaim);
    await cb.request("account.add", { id: interruptedDestination, harness, label: "release-destination-preparing-example.com" });
    writeCrashGate(join(b.dir, "crash-gate.json"), { phase: "preparing", account: interruptedDestination, generation: interruptedMaterial.material.generation });
    const interruptedPrepare = prepare(interruptedDestination, interruptedClaim, interruptedMaterial).catch(() => null);
    await waitFor(() => existsSync(join(b.dir, "crash-stopped")), "destination prepare stopped before private authority rename");
    await db.kill(); cb.close(); await interruptedPrepare;
    unlinkSync(join(b.dir, "crash-gate.json")); unlinkSync(join(b.dir, "crash-stopped"));
    db = await startDaemon(b.dir, { env: env(b.dir) }); cb = await db.client();
    const preparingCalls = refreshes.length;
    const interruptedReleased: Released = await rpc<Released>(cb, "releasePeer", { account: interruptedDestination, handoffId: interruptedClaim, confirm: true, roster: destinationRoster });
    assert.equal(interruptedReleased.disposition, "destination_shadow_voided"); assert.equal(interruptedReleased.cleanupPending, false);
    assert.equal(refreshes.length, preparingCalls);
    await refused(() => prepare(interruptedDestination, interruptedClaim, interruptedMaterial), "credential_handoff_decided");
    assert.equal(paths(join(b.dir, "vault", ".credential-authorities")).some(path => path.includes(interruptedDestination)), false);
    console.log(`${harness} release-peer destination preparing SIGKILL: missing primary and temporary received material voided, terminal claim, zero provider`);
    for (const state of ["prepared", "failed", "adopted", "uncertain"] as const) {
      const fixture = await releaseFixture(`destination-${state}`, state === "prepared");
      const releaseParams = { account: fixture.account, handoffId: fixture.handoffId, confirm: true, roster: destinationRoster };
      if (state === "failed") {
        valid.delete(tokenOf(fixture.material));
        await refused(() => rpc(cb!, "adopt", { account: fixture.account, handoffId: fixture.handoffId, commitReceipt: fixture.committed.receipt }), "credential_handoff_rejected");
      } else if (state === "adopted") {
        await rpc(cb!, "adopt", { account: fixture.account, handoffId: fixture.handoffId, commitReceipt: fixture.committed.receipt });
      } else if (state === "uncertain") {
        loseResponse = true;
        await refused(() => rpc(cb!, "adopt", { account: fixture.account, handoffId: fixture.handoffId, commitReceipt: fixture.committed.receipt }), "credential_handoff_uncertain");
        await refused(() => rpc(cb!, "releasePeer", releaseParams), "credential_handoff_uncertain");
      }
      const beforeRow: MirrorAccountRow = (await cb.request<{ accounts: MirrorAccountRow[] }>("account.list", {})).accounts.find(account => account.id === fixture.account)!;
      const providerCount = refreshes.length;
      const authorityPath = join(b.dir, "vault", ".credential-authorities", fixture.account + ".json");
      const saved = state === "adopted" ? readFileSync(authorityPath) : null;
      if (state === "uncertain") unlinkSync(authorityPath);
      const result: Released = await rpc<Released>(cb, "releasePeer", { ...releaseParams, ...(state === "uncertain" ? { nativeRecovery: true } : {}) });
      assert.equal(result.providerCalled, false); assert.equal(result.cleanupPending, false); assert.equal(result.requiredEpoch, 2);
      assert.equal(result.disposition, state === "adopted" ? "destination_holder_retained" : state === "uncertain" ? "destination_native_login_required" : "destination_shadow_voided");
      if (saved) { assert.equal((await rpc<{ scrubbed: boolean }>(cb, "handoffStatus", { handoffId: fixture.handoffId, role: "destination" })).scrubbed, false); assert.equal(readFileSync(authorityPath).equals(saved), true); assert.equal((await rpc<AccountCredentialAuthority>(cb, "status", { id: fixture.account })).phase, "ready"); }
      else assert.equal(existsSync(authorityPath), false);
      if (state === "prepared" || state === "failed") {
        const afterRow: MirrorAccountRow = (await cb.request<{ accounts: MirrorAccountRow[] }>("account.list", {})).accounts.find(account => account.id === fixture.account)!;
        assert.equal(afterRow.source, beforeRow.source); assert.deepEqual(afterRow.leasedFrom, beforeRow.leasedFrom); assert.equal(afterRow.status, beforeRow.status);
      }
      await refused(() => rpc(cb!, "adopt", { account: fixture.account, handoffId: fixture.handoffId, commitReceipt: fixture.committed.receipt }), "credential_handoff_decided");
      await refused(() => prepare(fixture.account, fixture.handoffId, fixture.material), "credential_handoff_decided");
      await db.kill(); cb.close(); db = await startDaemon(b.dir, { env: env(b.dir) }); cb = await db.client();
      await refused(() => rpc(cb!, "adopt", { account: fixture.account, handoffId: fixture.handoffId, commitReceipt: fixture.committed.receipt }), "credential_handoff_decided");
      const replay = await rpc<Released>(cb, "releasePeer", releaseParams);
      assert.equal(replay.disposition, result.disposition); assert.equal(refreshes.length, providerCount);
      console.log(`${harness} release-peer destination ${state}: zero provider; terminal claim survives restart and refuses late commit/prepare; holder preserved or shadow voided; epoch+1`);
    }

    {
      const cappedFixture = await releaseFixture("live-cap");
      liveCappedHandoff = cappedFixture.handoffId;
      const adoptParams = { account: cappedFixture.account, handoffId: cappedFixture.handoffId, commitReceipt: cappedFixture.committed.receipt };
      let cappedStatus: { retainedGeneration: number; retainedUnusableCount: number; retainedReceipt: CredentialHandoffReceipt; cappedRetainedDiscardAvailable: boolean };
      for (let attempt = 1; attempt <= 3; attempt++) {
        unusableResponse = true;
        if (attempt === 3) {
          const currentGeneration = cappedStatus!.retainedGeneration;
          writeCrashGate(join(b.dir, "crash-gate.json"), { phase: "live-retained-save", account: cappedFixture.account, generation: currentGeneration });
          const pending = rpc(cb, "adopt", { ...adoptParams, retainedGeneration: currentGeneration }).catch(() => null);
          await waitFor(() => existsSync(join(b.dir, "crash-stopped")), "live cap response saved before count recorded");
          await db.kill(); cb.close(); await pending; unlinkSync(join(b.dir, "crash-gate.json")); unlinkSync(join(b.dir, "crash-stopped"));
          db = await startDaemon(b.dir, { env: env(b.dir) }); cb = await db.client();
          cappedStatus = await rpc(cb, "handoffStatus", { handoffId: cappedFixture.handoffId, role: "destination" });
          assert.equal(cappedStatus.retainedUnusableCount, 3);
          await refused(() => rpc(cb!, "adopt", { ...adoptParams, retainedGeneration: currentGeneration }), "credential_handoff_decided");
        } else await refused(() => rpc(cb!, "adopt", { ...adoptParams, ...(attempt > 1 ? { retainedGeneration: cappedStatus!.retainedGeneration } : {}) }), "credential_handoff_unusable_access");
        cappedStatus = await rpc(cb, "handoffStatus", { handoffId: cappedFixture.handoffId, role: "destination" });
        assert.equal(cappedStatus.retainedUnusableCount, attempt);
      }
      assert.equal(cappedStatus!.cappedRetainedDiscardAvailable, true);
      const cappedCalls = refreshes.length;
      await refused(() => rpc(cb!, "adopt", { ...adoptParams, retainedGeneration: cappedStatus!.retainedGeneration }), "credential_handoff_decided");
      await refused(() => rpc(cb!, "adopt", { ...adoptParams, confirm: true, discardRetainedChain: true, sourceSettlement: cappedStatus!.retainedReceipt }), "credential_handoff_conflict");
      await refused(() => rpc(ca!, "exportSettle", { handoffId: cappedFixture.handoffId, retainedReceipt: cappedStatus!.retainedReceipt }), "invalid_request");
      for (const lane of ["node_relay", "remote"] as const) {
        const remote = await RpcClient.connect(da.socketPath, 3000, lane);
        try { await refused(() => remote.request("account.credentials.exportSettle", { handoffId: cappedFixture.handoffId, confirm: true, retainedReceipt: cappedStatus!.retainedReceipt }), "credential_handoff_conflict"); }
        finally { remote.close(); }
      }
      const sourcePrimaryPath = join(a.dir, "homes", cappedFixture.account, primary);
      const sourcePrimaryBefore = readFileSync(sourcePrimaryPath);
      const sourceAuthorityPath = join(a.dir, "vault", ".credential-authorities", cappedFixture.account + ".json");
      const sourceAuthorityBefore = readFileSync(sourceAuthorityPath);
      const newerNative = Buffer.from(JSON.stringify(cappedFixture.material.material.document).replace(tokenOf(cappedFixture.material), fresh()));
      try {
        writeFileSync(sourcePrimaryPath, newerNative);
        await refused(() => rpc(ca!, "exportSettle", { handoffId: cappedFixture.handoffId, confirm: true, retainedReceipt: cappedStatus!.retainedReceipt }), "credential_handoff_decided");
        assert.ok(readFileSync(sourcePrimaryPath).equals(newerNative), "source settlement preserves the newer native login");
        assert.ok(readFileSync(sourceAuthorityPath).equals(sourceAuthorityBefore), "refused source settlement preserves the fenced authority");
        assert.equal((await rpc<AccountCredentialAuthority>(ca, "status", { id: cappedFixture.account })).phase, "handing_off");
        assert.equal(refreshes.length, cappedCalls);
      } finally { writeFileSync(sourcePrimaryPath, sourcePrimaryBefore); }
      console.log(`${harness} source settlement refuses newer native login: native and authority byte-identical, source fence held, no provider call`);
      const settlementPayload = join(a.dir, "live-source-settlement.json"); writeFileSync(settlementPayload, JSON.stringify({ handoffId: cappedFixture.handoffId, retainedReceipt: cappedStatus!.retainedReceipt }));
      const { stdout: settlementOutput } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../cli/src/bin.ts", import.meta.url)), "account", "credentials", "export-settle", "--confirm", "--file", settlementPayload, "--data-dir", a.dir, "--json"], { env: { PATH: process.env.PATH, HOME: a.dir, HIVE_NO_KEYCHAIN: "1" } });
      metadata.push(settlementOutput); const sourceSettlement: Result & { requiredEpoch: number } = JSON.parse(settlementOutput);
      assert.equal(sourceSettlement.receipt.kind, "retained_discard_settlement"); assert.equal(sourceSettlement.requiredEpoch, 2);
      await da.kill(); ca.close(); da = await startDaemon(a.dir, { env: env(a.dir) }); ca = await da.client();
      const sourceReplay: Result = await rpc(ca, "exportSettle", { handoffId: cappedFixture.handoffId, confirm: true, retainedReceipt: cappedStatus!.retainedReceipt });
      assert.equal(sourceReplay.receipt.signature, sourceSettlement.receipt.signature);
      const discardParams = { ...adoptParams, confirm: true, discardRetainedChain: true, sourceSettlement: sourceSettlement.receipt };
      const previousPrimary = readFileSync(join(b.dir, "homes", cappedFixture.account, primary));
      writeFileSync(join(b.dir, "homes", cappedFixture.account, primary), "{not json");
      const pendingDiscard: { cleanupPending: boolean } = await rpc(cb, "adopt", discardParams);
      assert.equal(pendingDiscard.cleanupPending, true);
      assert.equal((await rpc<{ cleanupPending: boolean }>(cb, "handoffStatus", { handoffId: cappedFixture.handoffId, role: "destination" })).cleanupPending, true);
      await db.kill(); cb.close(); db = await startDaemon(b.dir, { env: env(b.dir) }); cb = await db.client();
      writeFileSync(join(b.dir, "homes", cappedFixture.account, primary), previousPrimary);
      const discardPayload = join(b.dir, "live-capped-discard.json"); writeFileSync(discardPayload, JSON.stringify(discardParams));
      const { stdout: discardOutput } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../cli/src/bin.ts", import.meta.url)), "account", "credentials", "adopt", "--confirm", "--discard-retained-chain", "--file", discardPayload, "--data-dir", b.dir, "--json"], { env: { PATH: process.env.PATH, HOME: b.dir, HIVE_NO_KEYCHAIN: "1" } });
      metadata.push(discardOutput); const discarded: { outcome: string; cleanupPending: boolean; requiredEpoch: number; message: string } = JSON.parse(discardOutput);
      assert.equal(discarded.outcome, "login_required"); assert.equal(discarded.cleanupPending, false); assert.equal(discarded.requiredEpoch, 2);
      assert.ok(discarded.message.includes("provider session behind the discarded chain stays valid until signed out"));
      await db.kill(); cb.close(); db = await startDaemon(b.dir, { env: env(b.dir) }); cb = await db.client();
      await rpc(cb, "adopt", discardParams); assert.equal(refreshes.length, cappedCalls);
      assert.equal((await rpc<AccountCredentialAuthority>(cb, "status", { id: cappedFixture.account })).phase, "native");
      const nativeRow = (await cb.request<{ accounts: MirrorAccountRow[] }>("account.list", {})).accounts.find(account => account.id === cappedFixture.account)!;
      assert.equal(nativeRow.source, "local"); assert.equal(nativeRow.status, "auth_needed");

      console.log(`${harness} live-member cap: exactly three unusable rotations, no fourth; source signed settlement/restart replay, response-save SIGKILL cap kept, cleanup failure/restart/repair replay, explicit discard on same row native-login-required, epoch+1, zero extra provider`);
    }

    for (const recoveryCase of (harness === "grok" ? ["success", "rejected", "release-before", "response", "release-save", "unusable-again", "unusable-limit"] : ["success", "rejected", "unusable-again", "unusable-limit"])) {
      const rejected = recoveryCase === "rejected";
      const retainedFixture = await releaseFixture(`destination-retained-${recoveryCase}`);
      if (harness === "grok") terminalExpiry = true; else unusableResponse = true;
      await refused(() => rpc(cb!, "adopt", { account: retainedFixture.account, handoffId: retainedFixture.handoffId, commitReceipt: retainedFixture.committed.receipt }), "credential_handoff_unusable_access");
      const initialStatus: { outcome: string; retainedGeneration: number; retainedChainRecoveryAvailable: boolean } = await rpc(cb, "handoffStatus", { handoffId: retainedFixture.handoffId, role: "destination" });
      assert.equal(initialStatus.retainedChainRecoveryAvailable, true); assert.equal(initialStatus.outcome, "retained_unusable");
      assert.equal(initialStatus.retainedGeneration, retainedFixture.material.material.generation + 1);
      const retainedPath = join(b.dir, "vault", ".credential-authorities", retainedFixture.account + ".json");
      const retainedDocument = JSON.parse(readFileSync(retainedPath, "utf8"));
      const retainedToken = tokenOf({ ...retainedFixture.material, material: { ...retainedFixture.material.material, document: retainedDocument.document } });
      const params = { account: retainedFixture.account, handoffId: retainedFixture.handoffId, confirm: true, roster: destinationRoster, retainedGeneration: initialStatus.retainedGeneration };
      await refused(() => rpc(cb!, "releasePeer", { ...params, useRetainedChain: true, retainedGeneration: undefined }), "credential_handoff_conflict");
      await refused(() => rpc(cb!, "releasePeer", { ...params, useRetainedChain: true, retainedGeneration: initialStatus.retainedGeneration - 1 }), "credential_handoff_conflict");
      await refused(() => rpc(cb!, "releasePeer", { ...params, nativeRecovery: true, retainedGeneration: undefined }), "credential_handoff_decided");
      if (rejected) valid.delete(retainedToken);
      const count = refreshes.length;
      if (recoveryCase.startsWith("unusable-")) {
        if (harness === "grok") terminalExpiry = true; else unusableResponse = true;
        let bad: Released = await rpc<Released>(cb, "releasePeer", { ...params, useRetainedChain: true, retainedGeneration: initialStatus.retainedGeneration });
        assert.equal(bad.outcome, "retained_unusable"); assert.equal(bad.disposition, "retained_unusable"); assert.equal(bad.retainedUnusableCount, 2);
        assert.ok(bad.message.includes(`--retained-generation ${bad.retainedGeneration}`));
        assert.equal(refreshes.length, count + 1);
        await refused(() => rpc(cb!, "releasePeer", { ...params, discardRetainedChain: true, retainedGeneration: undefined }), "credential_handoff_decided");
        await rpc(cb, "releasePeer", { ...params, useRetainedChain: true }); assert.equal(refreshes.length, count + 1);
        await refused(() => rpc(cb!, "releasePeer", { ...params, nativeRecovery: true, retainedGeneration: undefined }), "credential_handoff_decided");
        if (recoveryCase === "unusable-again") {
          const freshParams = { ...params, useRetainedChain: true, retainedGeneration: bad.retainedGeneration };
          const fixed: Released = await rpc<Released>(cb, "releasePeer", freshParams);
          assert.equal(fixed.outcome, "restored"); assert.equal(refreshes.length, count + 2);
          await rpc(cb, "releasePeer", freshParams);
          await rpc(cb, "releasePeer", { ...freshParams, retainedGeneration: retainedDocument.generation });
          assert.equal(refreshes.length, count + 2);
          assert.equal(JSON.parse(readFileSync(retainedPath, "utf8")).terminalAccessFailure, undefined);
          assert.equal((await rpc<{ scrubbed: boolean }>(cb, "handoffStatus", { handoffId: retainedFixture.handoffId, role: "destination" })).scrubbed, false);
          console.log("grok retained_unusable: saved chain/generation returned, previous request no provider; fresh bound generation rotates once and publishes; older generation replay no provider, holder reports no scrub");
        } else {
          for (let attempt = 3; attempt <= 3; attempt++) {
            if (harness === "grok") terminalExpiry = true; else unusableResponse = true;
            bad = await rpc<Released>(cb, "releasePeer", { ...params, useRetainedChain: true, retainedGeneration: bad.retainedGeneration });
            assert.equal(bad.retainedUnusableCount, attempt);
          }
          assert.equal(bad.outcome, "login_required"); assert.equal(bad.failureReason, "retained_unusable_limit");
          assert.equal(existsSync(retainedPath), true); assert.ok(bad.message.includes("--discard-retained-chain"));
          const cappedCalls = refreshes.length;
          await rpc(cb, "releasePeer", { ...params, useRetainedChain: true });
          await refused(() => rpc(cb!, "releasePeer", { ...params, useRetainedChain: true, retainedGeneration: bad.retainedGeneration }), "credential_handoff_decided");
          assert.equal(refreshes.length, cappedCalls);
          assert.equal((await rpc<{ retainedChainRecoveryAvailable: boolean }>(cb, "handoffStatus", { handoffId: retainedFixture.handoffId, role: "destination" })).retainedChainRecoveryAvailable, false);
          assert.equal(bad.cappedRetainedDiscardAvailable, true);
          const discardFile = join(b.dir, "discard-roster.json"); writeFileSync(discardFile, JSON.stringify(destinationRoster));
          const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../cli/src/bin.ts", import.meta.url)), "account", "credentials", "release-peer", retainedFixture.account, "--confirm", "--discard-retained-chain", "--file", discardFile, "--handoff-id", retainedFixture.handoffId, "--data-dir", b.dir, "--json"], { env: { PATH: process.env.PATH, HOME: b.dir, HIVE_NO_KEYCHAIN: "1" } });
          metadata.push(stdout); const discarded: Released = JSON.parse(stdout);
          assert.equal(discarded.outcome, "login_required"); assert.equal(discarded.cleanupPending, false); assert.equal(discarded.providerCalled, false);
          assert.ok(discarded.message.includes("provider session behind the discarded chain stays valid"));
          assert.equal(existsSync(retainedPath), false); assert.equal(refreshes.length, cappedCalls);
          const nativeRow: MirrorAccountRow = (await cb.request<{ accounts: MirrorAccountRow[] }>("account.list", {})).accounts.find(account => account.id === retainedFixture.account)!;
          assert.equal(nativeRow.source, "local"); assert.equal(nativeRow.status, "auth_needed");

          await rpc(cb, "releasePeer", { ...params, discardRetainedChain: true, retainedGeneration: undefined }); assert.equal(refreshes.length, cappedCalls);
          console.log("grok retained_unusable cap: three explicit bound failures -> login_required/reason; capped discard refused below limit, real CLI explicitly discards with provider-session warning, same row local/native-login-required, zero provider");
        }
        continue;
      }
      if (!["success", "rejected"].includes(recoveryCase)) {
        writeCrashGate(join(b.dir, "crash-gate.json"), { phase: recoveryCase, account: retainedFixture.account, generation: retainedDocument.generation });
        const pending = rpc(cb, "releasePeer", { ...params, useRetainedChain: true }).catch(() => null);
        await waitFor(() => existsSync(join(b.dir, "crash-stopped")), `retained-chain stopped at ${recoveryCase}`);
        await db.kill(); cb.close(); await pending;
        unlinkSync(join(b.dir, "crash-gate.json")); unlinkSync(join(b.dir, "crash-stopped"));
        db = await startDaemon(b.dir, { env: env(b.dir) }); cb = await db.client();
        const replay: Released = await rpc<Released>(cb, "releasePeer", { ...params, useRetainedChain: true });
        assert.equal(replay.outcome, recoveryCase === "release-save" ? "restored" : "uncertain");
        assert.equal(replay.providerCalled, false); assert.equal(refreshes.length, count + (recoveryCase === "release-before" ? 0 : 1));
        if (recoveryCase !== "release-save") await rpc(cb, "releasePeer", { ...params, nativeRecovery: true, retainedGeneration: undefined });
        console.log(`grok release-peer retained-chain ${recoveryCase} SIGKILL: durable attempt, saved replacement publication or unknown stop, zero blind retry`);
        continue;
      }
      const result: Released = await rpc<Released>(cb, "releasePeer", { ...params, useRetainedChain: true });
      assert.equal(result.providerCalled, true); assert.equal(result.cleanupPending, false); assert.equal(refreshes.length, count + 1);
      assert.equal(result.disposition, rejected ? "destination_native_login_required" : "destination_holder_retained");
      assert.equal(existsSync(retainedPath), !rejected);
      assert.equal((await rpc<{ retainedChainRecoveryAvailable: boolean }>(cb, "handoffStatus", { handoffId: retainedFixture.handoffId, role: "destination" })).retainedChainRecoveryAvailable, false);
      await rpc(cb, "releasePeer", { ...params, useRetainedChain: true });
      assert.equal(refreshes.length, count + 1);
      console.log(`grok release-peer explicit retained chain ${rejected ? "invalid_grant proven dead/scrubbed" : "rotated once/published authority"}: one call, terminal replay no provider, epoch+1`);
    }
    const preparedAccount = await enroll("release-prepared"), preparedHandoff = randomUUID(), preparedMaterial = await exported(preparedAccount, preparedHandoff);
    await cb.request("account.add", { id: preparedAccount, harness, label: "release-prepared-example.com" });
    const preparedShadow = await prepare(preparedAccount, preparedHandoff, preparedMaterial);
    await rpc(ca, "exportPrepare", { handoffId: preparedHandoff, preparedReceipt: preparedShadow.receipt, targetKey: preparedShadow.receipt.binding.targetKey, authenticatedPeer: to });
    const untouched = readFileSync(join(a.dir, "vault", ".credential-authorities", preparedAccount + ".json")), preparedCalls = refreshes.length;
    const preparedReleaseParams = { account: preparedAccount, handoffId: preparedHandoff, confirm: true, roster };
    writeCrashGate(join(a.dir, "crash-gate.json"), { phase: "early-release", account: preparedAccount });
    const preparedReleased = await rpc<Released>(ca, "releasePeer", preparedReleaseParams);
    assert.equal(preparedReleased.disposition, "prepared_aborted"); assert.equal(preparedReleased.requiredEpoch, 2); assert.equal(preparedReleased.providerCalled, false); assert.equal(preparedReleased.rotationScheduled, true); assert.ok(preparedReleased.message.includes(preparedAccount) && preparedReleased.message.includes("may still hold copied refresh material"));
    assert.ok(readFileSync(join(a.dir, "vault", ".credential-authorities", preparedAccount + ".json")).equals(untouched), "prepared abort preserves private material");
    assert.equal(refreshes.length, preparedCalls);
    await refused(() => rpc(ca!, "exportCommit", { handoffId: preparedHandoff, claimId: preparedShadow.receipt.binding.claimId }), "credential_handoff_decided");
    await rpc(cb, "adoptAbort", { handoffId: preparedHandoff, abortReceipt: preparedReleased.abortReceipt });
    const higherLease = await cb.request<{ account: MirrorAccountRow }>("account.lease.install", { id: preparedAccount, harness, label: "release-prepared-example.com", shareId: "12345678-release-prepared", authorityNodeId: from.nodeId, epoch: preparedReleased.requiredEpoch, expiresAt: Math.floor(Date.now() / 1000) + 3600, adopt: true, files: [{ homeRelPath: primary, contentB64: readFileSync(join(a.dir, "homes", preparedAccount, primary)).toString("base64"), mode: 0o600 }] });
    assert.equal(higherLease.account.id, preparedAccount); assert.equal(higherLease.account.source, "leased");
    assert.equal(refreshes.length, preparedCalls);
    await waitFor(() => existsSync(join(a.dir, "early-rotation-waiting")), "prepared release early normal rotation scheduled on next tick");
    assert.ok(readFileSync(join(a.dir, "vault", ".credential-authorities", preparedAccount + ".json")).equals(untouched), "prepared abort preserves private material");
    unlinkSync(join(a.dir, "crash-gate.json")); unlinkSync(join(a.dir, "early-rotation-waiting"));
    await waitFor(async () => { const state = await rpc<AccountCredentialAuthority>(ca!, "status", { id: preparedAccount }); return state.phase === "ready" && state.generation > preparedMaterial.material.generation; }, "prepared release normal early rotation settled");
    assert.equal(refreshes.length, preparedCalls + 1); assert.equal(valid.has(tokenOf(preparedMaterial)), false);
    assert.equal((await rpc<Released>(ca, "releasePeer", preparedReleaseParams)).disposition, "prepared_aborted");
    console.log(`${harness} release-peer prepared: no commit/provider in abort, chain byte-identical until scheduled next-tick normal rotation; epoch+1; signed abort clears returning shadow and same row accepts higher lease`);
    if (harness === "grok") for (const capped of [false, true]) {
      const sourceBad = await releaseFixture(`source-unusable-${capped}`), sourceCalls = refreshes.length;
      terminalExpiry = true;
      let bad: Released = await rpc<Released>(ca, "releasePeer", sourceBad.params);
      assert.equal(bad.outcome, "retained_unusable"); assert.equal(bad.retainedUnusableCount, 1);
      assert.equal(refreshes.length, sourceCalls + 1);
      await rpc(ca, "releasePeer", sourceBad.params); assert.equal(refreshes.length, sourceCalls + 1);
      await refused(() => rpc(ca!, "releasePeer", { ...sourceBad.params, nativeRecovery: true }), "credential_handoff_decided");
      if (!capped) {
        const sourceRoster = join(a.dir, "source-retained-roster.json"); writeFileSync(sourceRoster, JSON.stringify(roster));
        const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../cli/src/bin.ts", import.meta.url)), "account", "credentials", "release-peer", sourceBad.account, "--confirm", "--use-retained-chain", "--retained-generation", String(bad.retainedGeneration), "--file", sourceRoster, "--handoff-id", sourceBad.handoffId, "--data-dir", a.dir, "--json"], { env: { PATH: process.env.PATH, HOME: a.dir, HIVE_NO_KEYCHAIN: "1" } });
        metadata.push(stdout); const fixed: Released = JSON.parse(stdout);
        assert.equal(fixed.outcome, "restored"); assert.equal(fixed.disposition, "source_rotated"); assert.equal(refreshes.length, sourceCalls + 2);
        assert.ok(fixed.message.startsWith("Authority restored"));
        await rpc(cb, "adoptAbort", { handoffId: sourceBad.handoffId, abortReceipt: fixed.abortReceipt });
        await rpc(ca, "releasePeer", sourceBad.params); assert.equal(refreshes.length, sourceCalls + 2);
        console.log("grok source retained_unusable: committed refresh retains chain and names recovery; real CLI fresh generation rotates once, signed abort cleans returning shadow, replay no provider");
      } else {
        for (let attempt = 2; attempt <= 3; attempt++) {
          terminalExpiry = true;
          bad = await rpc<Released>(ca, "releasePeer", { ...sourceBad.params, useRetainedChain: true, retainedGeneration: bad.retainedGeneration });
          assert.equal(bad.retainedUnusableCount, attempt);
        }
        assert.equal(bad.outcome, "login_required"); assert.equal(bad.failureReason, "retained_unusable_limit");
        const beforeDiscard = refreshes.length;
        const discarded: Released = await rpc<Released>(ca, "releasePeer", { ...sourceBad.params, discardRetainedChain: true });
        assert.equal(discarded.outcome, "login_required"); assert.equal(discarded.cleanupPending, false); assert.equal(discarded.providerCalled, false);
        const sourceTerminal: { state: string; releasePeer: { mode: string } } = await rpc(ca, "handoffStatus", { handoffId: sourceBad.handoffId, role: "source" });
        assert.equal(sourceTerminal.state, "failed"); assert.equal(sourceTerminal.releasePeer.mode, "source_recovery");
        assert.ok(discarded.message.includes("provider session behind the discarded chain stays valid"));
        assert.equal((await rpc<AccountCredentialAuthority>(ca, "status", { id: sourceBad.account })).phase, "native");
        assert.equal(refreshes.length, beforeDiscard);
        console.log("grok source retained_unusable cap: three defined failures, no fourth rotation; explicit capped discard leaves same row native-login-required with provider-session warning");
      }
    }
    const released = await releaseFixture("healthy");
    const beforeRelease = refreshes.length;
    await refused(() => rpc(ca!, "releasePeer", { ...released.params, confirm: false }), "invalid_request");
    await refused(() => rpc(ca!, "releasePeer", { account: released.account, confirm: true }), "invalid_request");
    await refused(() => rpc(ca!, "releasePeer", { ...released.params, roster: { ...roster, members: [from.nodeId, to.nodeId] } }), "credential_handoff_conflict");
    await refused(() => rpc(ca!, "releasePeer", { ...released.params, roster: { ...roster, version: "bad-version" } }), "invalid_request");
    for (const lane of ["node_relay", "remote"] as const) {
      const relayedRelease = await RpcClient.connect(da.socketPath, 3000, lane);
      await refused(() => relayedRelease.request("account.credentials.releasePeer", released.params), "credential_handoff_conflict"); relayedRelease.close();
    }
    assert.equal(refreshes.length, beforeRelease);
    const rosterPath = join(a.dir, "release-roster.json"); writeFileSync(rosterPath, JSON.stringify(roster));
    const { stdout: releaseStdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../cli/src/bin.ts", import.meta.url)), "account", "credentials", "release-peer", released.account, "--confirm", "--file", rosterPath, "--handoff-id", released.handoffId, "--data-dir", a.dir, "--json"], { env: { PATH: process.env.PATH, HOME: a.dir, HIVE_NO_KEYCHAIN: "1" } });
    metadata.push(releaseStdout);
    const restored = JSON.parse(releaseStdout) as Released;
    assert.equal(restored.outcome, "restored"); assert.equal(restored.requiredEpoch, 2); assert.equal(restored.providerCalled, true);
    assert.equal(refreshes.length, beforeRelease + 1); assert.equal(valid.has(tokenOf(released.material)), false);
    assert.equal((await rpc<AccountCredentialAuthority>(ca, "status", { id: released.account })).phase, "ready");
    assert.equal((await rpc<Released>(ca, "releasePeer", released.params)).outcome, "restored"); assert.equal(refreshes.length, beforeRelease + 1);
    await rpc(cb, "adoptAbort", { handoffId: released.handoffId, abortReceipt: restored.abortReceipt });
    const restoredLease = await cb.request<{ account: MirrorAccountRow }>("account.lease.install", { id: released.account, harness, label: "release-healthy-example.com", shareId: "12345678-release-committed", authorityNodeId: from.nodeId, epoch: restored.requiredEpoch, expiresAt: Math.floor(Date.now() / 1000) + 3600, adopt: true, files: [{ homeRelPath: primary, contentB64: readFileSync(join(a.dir, "homes", released.account, primary)).toString("base64"), mode: 0o600 }] });
    assert.equal(restoredLease.account.id, released.account); assert.equal(restoredLease.account.source, "leased");
    console.log(`${harness} release-peer restored: removed roster fact persisted, CLI confirmed, one rotation, ready/access-only, epoch+1, replay no provider; old destination copy rejected`);
    const secondHandoff = randomUUID(), secondExport = await rpc<Exported>(ca, "export", { account: released.account, handoffId: secondHandoff, from, to, epoch: 3 });
    const secondPrepared = await rpc<Result>(cb, "adoptPrepare", { account: released.account, handoffId: secondHandoff, from, to, authenticatedPeer: from, epoch: 3, sourceKey: secondExport.receipt.binding.sourceKey, exportReceipt: secondExport.receipt, material: secondExport.material });
    const secondCommit = await commit(secondHandoff, secondPrepared);
    assert.equal(secondCommit.state, "committed");
    const beforeSecond = refreshes.length;
    const { stdout: secondStdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../cli/src/bin.ts", import.meta.url)), "account", "credentials", "release-peer", released.account, "--confirm", "--file", rosterPath, "--data-dir", a.dir, "--json"], { env: { PATH: process.env.PATH, HOME: a.dir, HIVE_NO_KEYCHAIN: "1" } });
    metadata.push(secondStdout);
    const secondReleased = JSON.parse(secondStdout) as Released;
    assert.equal(secondReleased.outcome, "restored"); assert.equal(secondReleased.requiredEpoch, 4);
    assert.equal(refreshes.length, beforeSecond + 1);
    console.log(`${harness} release-peer repeated account: current claim inferred over terminal history; resolved private marker permits only new higher-generation claim`);
    const rejectedRelease = await releaseFixture("rotated");
    await rpc(cb, "adopt", { account: rejectedRelease.account, handoffId: rejectedRelease.handoffId, commitReceipt: rejectedRelease.committed.receipt });
    const rejectedCalls = refreshes.length;
    const releaseRejected = await rpc<Released>(ca, "releasePeer", rejectedRelease.params);
    assert.equal(releaseRejected.outcome, "login_required"); assert.equal(releaseRejected.cleanupPending, false); assert.equal(releaseRejected.providerCalled, true);
    assert.ok(releaseRejected.message.includes(rejectedRelease.account) && releaseRejected.message.includes("removed computer still holds a working login") && releaseRejected.message.includes("signed out at the provider"));
    assert.equal(refreshes.length, rejectedCalls + 1); assert.equal((await rpc<AccountCredentialAuthority>(ca, "status", { id: rejectedRelease.account })).phase, "native");
    assert.equal((await rpc<AccountCredentialAuthority>(cb, "status", { id: rejectedRelease.account })).phase, "ready");
    assert.ok(!existsSync(join(a.dir, "vault", ".credential-authorities", rejectedRelease.account + ".json")));
    await rpc(ca, "releasePeer", rejectedRelease.params); assert.equal(refreshes.length, rejectedCalls + 1);
    console.log(`${harness} release-peer rejected: destination already rotated, source scrubbed/native-login-required, named-account warning retains removed peer login, replay no provider`);
    for (const phase of ["release-before", "response", "release-save"]) {
      const crash = await releaseFixture(phase), before = refreshes.length;
      writeCrashGate(join(a.dir, "crash-gate.json"), { phase, account: crash.account, generation: crash.material.material.generation });
      let releaseError: unknown, releaseOutcome: Released | undefined;
      const operation = waitFor(async () => {
        try { return await rpc<Released>(ca!, "releasePeer", crash.params); }
        catch (error) { if (error instanceof RpcError && error.code === "credential_handoff_unavailable") return null; throw error; }
      }, "release-peer source credential lane settled").then(result => { releaseOutcome = result; return result; }, error => { releaseError = error; return null; });
      await waitFor(() => {
        if (releaseError) throw new Error(`Release crash preflight refused: ${releaseError instanceof RpcError ? releaseError.code : "transport"}`);
        if (releaseOutcome) throw new Error(`Release crash preflight answered outcome=${releaseOutcome.outcome} providerCalled=${releaseOutcome.providerCalled}`);
        return existsSync(join(a.dir, "crash-stopped"));
      }, `release-peer source stopped at ${phase}`);
      await da.kill(); ca.close(); await operation;
      unlinkSync(join(a.dir, "crash-gate.json")); unlinkSync(join(a.dir, "crash-stopped"));
      da = await startDaemon(a.dir, { env: env(a.dir) }); ca = await da.client();
      if (phase === "release-save") {
        const primaryPath = join(a.dir, "homes", crash.account, primary), home = readFileSync(primaryPath);
        unlinkSync(primaryPath); mkdirSync(primaryPath);
        assert.equal((await rpc<Released>(ca, "releasePeer", crash.params)).outcome, "uncertain");
        const retained = readFileSync(join(a.dir, "vault", ".credential-authorities", crash.account + ".json"));
        await assert.rejects(() => rpc(ca!, "releasePeer", { ...crash.params, nativeRecovery: true }), (error: unknown) => error instanceof RpcError && error.code === "credential_handoff_decided" && error.message.includes("saved replacement chain"));
        assert.ok(readFileSync(join(a.dir, "vault", ".credential-authorities", crash.account + ".json")).equals(retained), "native recovery preserves saved private material");
        rmdirSync(primaryPath); writeFileSync(primaryPath, home, { mode: 0o600 });
      }
      const retry = await rpc<Released>(ca, "releasePeer", crash.params);
      assert.equal(retry.outcome, phase === "release-save" ? "restored" : "uncertain"); assert.equal(retry.providerCalled, false);
      assert.equal(refreshes.length, before + (phase === "release-before" ? 0 : 1));
      await rpc(ca, "releasePeer", crash.params); assert.equal(refreshes.length, before + (phase === "release-before" ? 0 : 1));
      if (phase !== "release-save") {
        if (phase === "release-before") {
          const missingPath = join(a.dir, "vault", ".credential-authorities", crash.account + ".json");
          writeFileSync(join(a.dir, "vault", ".credential-authorities", crash.account + ".previous.json"), readFileSync(missingPath), { mode: 0o600 });
          unlinkSync(missingPath);
        }
        let recovery: Released;
        if (phase === "response") {
          const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../cli/src/bin.ts", import.meta.url)), "account", "credentials", "release-peer", crash.account, "--confirm", "--native-recovery", "--file", rosterPath, "--handoff-id", crash.handoffId, "--data-dir", a.dir, "--json"], { env: { PATH: process.env.PATH, HOME: a.dir, HIVE_NO_KEYCHAIN: "1" } });
          metadata.push(stdout); recovery = JSON.parse(stdout) as Released;
        } else recovery = await rpc<Released>(ca, "releasePeer", { ...crash.params, nativeRecovery: true });
        assert.equal(recovery.outcome, "login_required"); assert.equal(recovery.providerCalled, false); assert.equal(recovery.cleanupPending, false);
        assert.equal(existsSync(join(a.dir, "vault", ".credential-authorities", crash.account + ".previous.json")), false);
        assert.ok(recovery.message.includes(crash.account) && recovery.message.includes("may still hold a working login"));
        assert.equal((await rpc<AccountCredentialAuthority>(ca, "status", { id: crash.account })).phase, "native");
        await rpc(ca, "releasePeer", { ...crash.params, nativeRecovery: true });
        assert.equal(refreshes.length, before + (phase === "release-before" ? 0 : 1));
      }
      console.log(`${harness} release-peer ${phase} SIGKILL: durable fact/attempt; retry outcome=${retry.outcome}, total provider calls=${phase === "release-before" ? 0 : 1}, no blind repeat`);
    }
    const retryableRelease = await releaseFixture("retryable"), retryableCalls = refreshes.length;
    refuseReleaseOnce = true;
    const retryable = await rpc<Released>(ca, "releasePeer", retryableRelease.params);
    assert.equal(retryable.outcome, "uncertain"); assert.equal(retryable.retryable, true);
    assert.equal(valid.has(tokenOf(retryableRelease.material)), true);
    await refused(() => rpc(ca!, "releasePeer", { ...retryableRelease.params, nativeRecovery: true }), "credential_handoff_decided");
    await da.kill(); ca.close(); da = await startDaemon(a.dir, { env: env(a.dir) }); ca = await da.client();
    assert.equal((await rpc<Released>(ca, "releasePeer", retryableRelease.params)).outcome, "restored");
    assert.equal(refreshes.length, retryableCalls + 2); assert.equal(valid.has(tokenOf(retryableRelease.material)), false);
    console.log(`${harness} release-peer known 429: unconsumed proof persisted, explicit retry after SIGKILL spends original chain once; native recovery refused while retryable`);
    if (harness !== "grok") {
      const busyAccount = await enroll("release-busy");
      const busy = await ca.request<{ beeId: string }>("spawn", { name: `release-${harness}`, agent: harness, cwd: a.dir, account: busyAccount, tags: ["autoswap=false"] });
      await waitFor(async () => ["running", "idle"].includes((await ca!.request<ViewResult>("view", { beeId: busy.beeId })).view.runtimeState!), "release-peer bee started");
      const handoffId = randomUUID(), material = await exported(busyAccount, handoffId);
      await cb.request("account.add", { id: busyAccount, harness, label: "release-busy-example.com" });
      const prepared = await prepare(busyAccount, handoffId, material);
      await rpc(ca, "exportPrepare", { handoffId, preparedReceipt: prepared.receipt, targetKey: prepared.receipt.binding.targetKey, authenticatedPeer: to });
      await refused(() => rpc(ca!, "releasePeer", { account: busyAccount, handoffId, confirm: true, roster }), "credential_handoff_fenced");
      await commit(handoffId, prepared);
      const before = refreshes.length;
      await refused(() => rpc(ca!, "releasePeer", { account: busyAccount, handoffId, confirm: true, roster }), "credential_handoff_fenced");
      assert.equal(refreshes.length, before);
      await ca.request("stop", { beeId: busy.beeId });
      await waitFor(async () => (await ca!.request<ViewResult>("view", { beeId: busy.beeId })).view.runtimeState === "stopped", "release-peer bee stopped");
      assert.equal((await rpc<Released>(ca, "releasePeer", { account: busyAccount, handoffId, confirm: true, roster })).outcome, "restored");
      console.log(`${harness} release-peer running bee refused without attempt/provider; explicit stop allows release`);
    }
    if (beeId) {
      await cb.request("stop", { beeId });
      await waitFor(async () => (await cb!.request<ViewResult>("view", { beeId })).view.runtimeState === "stopped", "leased dummy bee stopped before teardown");
    }
    ca.close(); cb.close(); await da.stop(); await db.stop();
    for (const [role, dir] of [["source", a.dir], ["destination", b.dir]] as const) {
      const ledger = new DatabaseSync(join(dir, "core.sqlite3"), { readOnly: true });
      try {
        const count = ledger.prepare("SELECT COUNT(*) AS n FROM audit WHERE kind='account.credentials.adopt_retained_discard' AND json_extract(payload,'$.handoffId')=? AND json_extract(payload,'$.role')=?").get(liveCappedHandoff, role) as { n: number };
        assert.equal(count.n, 1, `one retained-discard ledger row on ${role}, including refusals and restart/cleanup replays`);
      } finally { ledger.close(); }
    }

    const ledger = new DatabaseSync(join(a.dir, "core.sqlite3"), { readOnly: true });
    try {
      for (const handoffId of [preparedHandoff, released.handoffId, rejectedRelease.handoffId]) assert.equal((ledger.prepare("SELECT COUNT(*) AS n FROM audit WHERE kind='account.credentials.release_peer' AND json_extract(payload,'$.handoffId')=?").get(handoffId) as { n: number }).n, 1);
      const durable = JSON.parse((ledger.prepare("SELECT record FROM credential_handoffs WHERE handoff_id=? AND role='source'").get(released.handoffId) as { record: string }).record);
      assert.deepEqual(durable.releasePeer.roster, roster);
    } finally { ledger.close(); }
    console.log(`${harness} release-peer audit: one secret-free outcome ledger row, authenticated roster version/author counter persisted`);

    const blobs = [...paths(a.dir), ...paths(b.dir)].filter(path => !path.includes("/vault/") && !path.includes("/homes/")).map(path => readFileSync(path));
    blobs.push(Buffer.from(da.output()), Buffer.from(db.output()), Buffer.from(JSON.stringify(metadata)));
    assert.ok(secrets.every(secret => blobs.every(blob => !blob.includes(Buffer.from(secret)))), "logs SQLite ledgers and metadata results contain zero credential bytes");
    console.log(`${harness} 9 secret scan logs/SQLite/ledgers/RPC metadata=0; owned daemon PIDs ${da.proc.pid},${db.proc.pid} stopped; stub closed in cleanup`);
  } finally {
    await cleanup();
  }
});
