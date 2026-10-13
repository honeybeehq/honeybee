import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AccountCredentialAuthority, CredentialHandoffReceipt, MirrorAccountRow } from "../../core/src/index.ts";
import type { RpcClient } from "../../cli/src/client.ts";
import { RpcError, type RpcVerb, type ViewResult } from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, waitFor, sleep, type DaemonHandle } from "./helpers.ts";

type Exported = { receipt: CredentialHandoffReceipt; material: { generation: number; document: Record<string, unknown> } };
type Result = { handoffId: string; state: string; receipt: CredentialHandoffReceipt; generation: number; expiresAt: number };
const from = { nodeId: "dummy-node-A", deviceKey: "dummy-device-A" };
const to = { nodeId: "dummy-node-B", deviceKey: "dummy-device-B" };
const scope = "https://auth.x.ai::fixture-public-client";
function paths(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? paths(join(root, entry.name)) : entry.isFile() ? [join(root, entry.name)] : []);
}
function jwt(): string { return `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, fixture: randomUUID() })).toString("base64url")}.${randomUUID()}`; }

for (const harness of ["claude", "codex", "grok"]) test(`credential handoff ${harness}: two isolated daemons, durable prepare/commit, rotation, scrub, abort, TTL, replay and failures`, async () => {
  const a = makeDaemonDir({ accounts: { centralRefreshAheadMs: 0, centralRefreshRetryBaseMs: 60_000 } });
  const b = makeDaemonDir({ accounts: { centralRefreshAheadMs: 0, centralRefreshRetryBaseMs: 60_000 } });
  const valid = new Set<string>(), secrets: string[] = [], refreshes: string[] = [], metadata: unknown[] = [];
  let rejectToken: string | null = null, loseResponse = false, unusableResponse = false, terminalExpiry = false;
  let corruptOnReject: string | null = null;
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
  const env = (dir: string) => {
    const preload = join(dir, "no-provider.mjs");
    writeFileSync(preload, `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';import{join}from'node:path';const f=globalThis.fetch;globalThis.fetch=(url,o)=>{if(String(url).startsWith('http://127.0.0.1:'))return f(url,o);throw new Error('External provider forbidden in isolated handoff');};const rename=fs.renameSync;fs.renameSync=(a,b)=>{const root=${JSON.stringify(dir)};const gate=join(root,'crash-gate.json');const rule=fs.existsSync(gate)?JSON.parse(fs.readFileSync(gate,'utf8')):null;if(rule&&rule.phase==='preparing'&&String(b).endsWith('/'+rule.account+'.json')){const value=JSON.parse(fs.readFileSync(a,'utf8'));if(value.generation===rule.generation){fs.writeFileSync(join(root,'crash-stopped'),'');process.kill(process.pid,'SIGSTOP');}}rename(a,b);if(rule&&rule.phase!=='preparing'&&String(b).endsWith('/'+rule.account+'.json')){const value=JSON.parse(fs.readFileSync(b,'utf8'));if(value.generation>rule.generation){fs.writeFileSync(join(root,'crash-stopped'),'');process.kill(process.pid,'SIGSTOP');}}};syncBuiltinESMExports();`);
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
  const prepare = (id: string, handoffId: string, value: Exported) => rpc<Result>(cb!, "adoptPrepare", { account: id, handoffId, from, to, epoch: 1, sourceKey: value.receipt.binding.sourceKey, exportReceipt: value.receipt, material: value.material });
  const commit = async (handoffId: string, prepared: Result) => {
    await rpc(ca!, "exportPrepare", { handoffId, preparedReceipt: prepared.receipt });
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
    assert.ok(ca.capabilities.includes("account.credentials.handoff.v1"));
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
    await sleep(80);
    assert.equal((await rpc<AccountCredentialAuthority>(ca, "status", { id })).phase, "handing_off");
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
    const prepared = await prepare(target, handoffId, value);
    assert.equal(refreshes.length, count);
    const replay = await prepare(target, handoffId, value);
    assert.equal(replay.receipt.binding.claimId, prepared.receipt.binding.claimId);
    await db.kill(); cb.close(); db = await startDaemon(b.dir, { env: env(b.dir) }); cb = await db.client();
    const resumedPrepare = await prepare(target, handoffId, value);
    assert.equal(resumedPrepare.receipt.binding.claimId, prepared.receipt.binding.claimId);
    await rpc(ca, "exportPrepare", { handoffId, preparedReceipt: prepared.receipt });
    await refused(() => rpc(ca!, "exportAbort", { handoffId }), "credential_handoff_decided");
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
    await sleep(100);
    assert.equal(refreshes.length, afterRejectedProbe);
    await refused(() => ca!.request("account.lease", { account: id }), "credential_handoff_decided");
    await ca.request("account.limits", { id, refresh: true });
    assert.equal(refreshes.length, afterRejectedProbe);
    const newAccess = readFileSync(join(b.dir, "homes", target, primary), "utf8");
    const oldPeer = await ca.request<{ account: MirrorAccountRow }>("account.lease.install", { id, harness, label: "test-example.com", shareId: "12345678-new-authority", authorityNodeId: to.nodeId, epoch: 1, expiresAt: Math.floor(Date.now() / 1000) + 3600, adopt: true, files: [{ homeRelPath: primary, contentB64: Buffer.from(newAccess).toString("base64"), mode: 0o600 }] });
    assert.equal(oldPeer.account.id, id); assert.equal(oldPeer.account.source, "leased");
    console.log(`${harness} 3 confirm: authority removed, homes/vault/mirrors refresh-byte hits=0; source provider calls=0; old row accepts new authority lease in place`);
    const savedId = await enroll("saved"), savedHandoff = randomUUID(), savedExport = await exported(savedId, savedHandoff);
    await cb.request("account.add", { id: savedId, harness, label: "saved-example.com" });
    const savedPrepared = await prepare(savedId, savedHandoff, savedExport), savedCommit = await commit(savedHandoff, savedPrepared);
    writeFileSync(join(b.dir, "crash-gate.json"), JSON.stringify({ account: savedId, generation: savedExport.material.generation }));
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
    writeFileSync(join(b.dir, "crash-gate.json"), JSON.stringify({ account: preparingId, generation: preparingExport.material.generation, phase: "preparing" }));
    const pendingPrepare = prepare(preparingId, preparingHandoff, preparingExport).catch(() => null);
    await waitFor(() => existsSync(join(b.dir, "crash-stopped")) ? true : null, "B stopped before prepared material rename");
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
    await refused(() => rpc(ca!, "exportPrepare", { handoffId: abortHandoff, preparedReceipt: abandonedPrepared.receipt }), "credential_handoff_decided");
    await rpc(cb, "adoptAbort", { handoffId: abortHandoff, abortReceipt: aborted.receipt });
    await refused(() => rpc(cb!, "adopt", { account: abortId, handoffId: abortHandoff, commitReceipt: committed.receipt }), "credential_handoff_conflict");
    await rpc(ca, "refresh", { id: abortId, idempotencyKey: randomUUID() });
    console.log(`${harness} 5 abort restores A; delayed prepare cannot commit; signed abort cleans B; delayed adopt refused`);
    const ttlId = await enroll("ttl"), ttlHandoff = randomUUID(), ttlExport = await exported(ttlId, ttlHandoff, 1000);
    await sleep(1050);
    await waitFor(async () => (await rpc<AccountCredentialAuthority>(ca!, "status", { id: ttlId })).phase === "ready" ? true : null, "expired unprepared export auto-aborted");
    await da.kill(); ca.close(); da = await startDaemon(a.dir, { env: env(a.dir) }); ca = await da.client();
    assert.equal((await rpc<AccountCredentialAuthority>(ca, "status", { id: ttlId })).phase, "ready");
    assert.equal((await rpc<Result>(ca, "handoffStatus", { handoffId: ttlHandoff })).state, "aborted");
    await cb.request("account.add", { id: ttlId, harness, label: "ttl-example.com" });
    await refused(() => prepare(ttlId, ttlHandoff, ttlExport), "credential_handoff_expired");
    await rpc(ca, "exportAbort", { handoffId: ttlHandoff });
    console.log(`${harness} TTL unprepared export auto-aborts, survives restart, signed abort receipt available; late prepare refused`);
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
    await refused(() => rpc(cb!, "adopt", { account: retainedId, handoffId: retainedHandoff, commitReceipt: retainedCommit.receipt }), "credential_handoff_uncertain");
    const retainedDocument = JSON.parse(readFileSync(join(b.dir, "vault", ".credential-authorities", `${retainedId}.json`), "utf8")).document;
    const retainedRefresh = tokenOf({ ...retainedExport, material: { ...retainedExport.material, document: retainedDocument } });
    assert.ok(retainedRefresh !== tokenOf(retainedExport) && valid.has(retainedRefresh), "known new refresh chain retained despite missing access");
    const retainedAdopt = await rpc<Result>(cb, "adopt", { account: retainedId, handoffId: retainedHandoff, commitReceipt: retainedCommit.receipt });
    assert.ok(refreshes.at(-1) === retainedRefresh, "retry spends the new chain");
    assert.equal(refreshes.filter(value => value === tokenOf(retainedExport)).length, 1);
    await rpc(ca, "exportConfirm", { handoffId: retainedHandoff, adoptedReceipt: retainedAdopt.receipt });
    console.log(`${harness} known rotated chain with missing access: saved privately, uncertain; retry uses NEW chain; old exported chain spent once`);
    if (harness === "grok") {
      const terminalId = await enroll("terminal"), terminalHandoff = randomUUID(), terminalExport = await exported(terminalId, terminalHandoff);
      await cb.request("account.add", { id: terminalId, harness, label: "terminal-example.com" });
      const terminalPrepared = await prepare(terminalId, terminalHandoff, terminalExport), terminalCommit = await commit(terminalHandoff, terminalPrepared);
      terminalExpiry = true;
      await refused(() => rpc(cb!, "adopt", { account: terminalId, handoffId: terminalHandoff, commitReceipt: terminalCommit.receipt }), "credential_handoff_unusable_access");
      const retained = JSON.parse(readFileSync(join(b.dir, "vault", ".credential-authorities", `${terminalId}.json`), "utf8"));
      assert.ok(valid.has(tokenOf({ ...terminalExport, material: { ...terminalExport.material, document: retained.document } })), "terminal malformed expiry retains the new chain");
      const terminalCount = refreshes.length;
      await sleep(100);
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
    console.log(`${harness} unknown response: durable uncertain destination, private material retained, source committed fence held`);
    const beforeStandDown = refreshes.length;
    await rpc(ca, "standDown", { account: unknownId, epoch: 2 });
    assert.equal(refreshes.length, beforeStandDown);
    for (const path of paths(a.dir).filter(path => path.startsWith(join(a.dir, "homes")) || path.startsWith(join(a.dir, "vault")))) assert.ok(!readFileSync(path).includes(Buffer.from(tokenOf(unknownExport))));
    console.log(`${harness} 8 standDown scrubs without provider call`);
    if (beeId) await cb.request("stop", { beeId });
    ca.close(); cb.close(); await da.stop(); await db.stop();
    const blobs = [...paths(a.dir), ...paths(b.dir)].filter(path => !path.includes("/vault/") && !path.includes("/homes/")).map(path => readFileSync(path));
    blobs.push(Buffer.from(da.output()), Buffer.from(db.output()), Buffer.from(JSON.stringify(metadata)));
    assert.ok(secrets.every(secret => blobs.every(blob => !blob.includes(Buffer.from(secret)))), "logs SQLite ledgers and metadata results contain zero credential bytes");
    console.log(`${harness} 9 secret scan logs/SQLite/ledgers/RPC metadata=0; owned daemon PIDs ${da.proc.pid},${db.proc.pid} stopped; stub closed in cleanup`);
  } finally {
    ca?.close(); cb?.close();
    if (da && da.proc.exitCode === null && da.proc.signalCode === null) await da.stop();
    if (db && db.proc.exitCode === null && db.proc.signalCode === null) await db.stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
    a.cleanup(); b.cleanup();
  }
});
