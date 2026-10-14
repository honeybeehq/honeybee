import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CLAUDE_REFRESH_LOCK_STALE_MS, claudeRefreshLockPaths } from "../src/claudeRefreshLock.ts";
import { RpcClient } from "../../cli/src/client.ts";
import { type AccountLeaseInstallResult, type AccountLeaseRemoveResult, type AuditTailResult, RpcError } from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, forceStopTestDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

test("lease remove native guard RPC/CLI: local confirmation, read-only preview, SIGKILL before deletion and one durable authorisation", { timeout: 180_000 }, async t => {
  const root = makeDaemonDir();
  const handles: DaemonHandle[] = [], clients: RpcClient[] = [];
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => cleanupPromise ??= (async () => { clients.forEach(client => client.close()); await Promise.allSettled(handles.map(forceStopTestDaemon)); root.cleanup(); })();
  t.after(cleanup); t.signal.addEventListener("abort", () => { void cleanup(); }, { once: true });
  const gate = join(root.dir, "remove-gate.json"), marker = join(root.dir, "remove-held"), preload = join(root.dir, "remove-preload.mjs");
  writeFileSync(preload, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const original=fs.rmSync; fs.rmSync=function(path,...args){let rule=null;try{rule=JSON.parse(fs.readFileSync(${JSON.stringify(gate)},'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}if(rule?.path===String(path)){fs.writeFileSync(${JSON.stringify(marker)},'held');process.kill(process.pid,'SIGSTOP')}return original.call(this,path,...args)};syncBuiltinESMExports();`);
  let daemon: DaemonHandle, client: RpcClient;
  const open = async () => { daemon = await startDaemon(root.dir, { env: { NODE_OPTIONS: `--import=${preload}` }, stopTimeoutMs: 30_000 }); handles.push(daemon); client = await daemon.client(); clients.push(client); };
  try {
    await open();
    assert.ok(client!.capabilities.includes("account.lease.remove_native_guard.v1"));
    const token = randomUUID(), refresh = randomUUID();
    const doc = { claudeAiOauth: { accessToken: token, refreshToken: "", expiresAt: Date.now() + 3_600_000 } };
    const installed = await client!.request<AccountLeaseInstallResult>("account.lease.install", { id: "claude-remove-test", harness: "claude", label: "test", shareId: "share-test", authorityNodeId: "authority-test", epoch: 1, generation: 1, expiresAt: Math.floor(Date.now() / 1000) + 3500, files: [{ homeRelPath: ".credentials.json", contentB64: Buffer.from(JSON.stringify(doc)).toString("base64"), mode: 0o600 }] });
    const id = installed.account.id, path = join(installed.account.homePath, ".credentials.json");
    const native = Buffer.from(JSON.stringify({ claudeAiOauth: { ...doc.claudeAiOauth, refreshToken: refresh } })); writeFileSync(path, native);
    const check = await client!.request<AccountLeaseRemoveResult>("account.lease.remove", { id, checkOnly: true });
    assert.equal(check.disposition, "native_preserved"); assert.equal(check.nativeChain.account, id);
    await assert.rejects(client!.request("account.lease.remove", { id }), error => error instanceof RpcError && error.code === "account_lease_native_present" && error.details?.account === id);
    for (const lane of ["node_relay", "remote"] as const) {
      const other = await RpcClient.connect(daemon!.socketPath, 1000, lane); clients.push(other);
      assert.equal((await other.request<AccountLeaseRemoveResult>("account.lease.remove", { id, checkOnly: true })).nativeChain.present, true);
      await assert.rejects(other.request("account.lease.remove", { id, discardNative: true, confirm: true }), error => error instanceof RpcError && error.details?.reason === "local_required");
    }
    const bin = fileURLToPath(new URL("../../cli/src/bin.ts", import.meta.url));
    const runCli = (args: string[]) => promisify(execFile)(process.execPath, [bin, "account", "lease", "remove", id, ...args, "--data-dir", root.dir, "--json"], { env: { ...process.env, HOME: join(root.dir, "cli-home") } });
    await assert.rejects(runCli(["--discard-native"]), error => error instanceof Error && /--confirm/.test((error as Error & { stderr?: string }).stderr ?? ""));
    const cliCheck = await runCli(["--check-only"]); assert.equal((JSON.parse(cliCheck.stdout) as AccountLeaseRemoveResult).disposition, "native_preserved");
    rmSync(join(root.dir, "vault", ".lease-material-provenance.key"));
    writeFileSync(gate + ".tmp", JSON.stringify({ path })); const fs = await import("node:fs"); fs.renameSync(gate + ".tmp", gate);
    const attempt = client!.request("account.lease.remove", { id, discardNative: true, confirm: true }, 60_000).catch(() => null);
    await waitFor(() => existsSync(marker), "native discard stopped before first rm", 30_000);
    assert.ok(readFileSync(path).equals(native), "native bytes unchanged before removal");
    await daemon!.kill(); await attempt;
    rmSync(gate);
    const stale = new Date(Date.now() - CLAUDE_REFRESH_LOCK_STALE_MS - 1000);
    for (const lock of Object.values(claudeRefreshLockPaths(installed.account.homePath))) if (existsSync(lock)) utimesSync(lock, stale, stale);
    await open();
    assert.ok(readFileSync(path).equals(native), "native survives physical kill");
    const beforeRetry = await client!.request<AuditTailResult>("audit.tail", { after: 0, limit: 10000 });
    assert.equal(beforeRetry.rows.filter(row => row.kind === "account.lease.native_discard_authorised").length, 1, "authorisation survived SIGKILL before any retry");
    await assert.rejects(client!.request("account.lease.remove", { id }), error => error instanceof RpcError && error.code === "account_lease_native_present");
    const cli = await runCli(["--discard-native", "--confirm"]); const result = JSON.parse(cli.stdout) as AccountLeaseRemoveResult;
    assert.equal(result.nativeChain.discarded, true); assert.match(result.message, /stays valid until signed out at the provider/);
    const audit = await client!.request<AuditTailResult>("audit.tail", { after: 0, limit: 10000 });
    assert.equal(audit.rows.filter(row => row.kind === "account.lease.native_discard_authorised").length, 1);
    assert.ok(!JSON.stringify(audit).includes(refresh)); assert.ok(!daemon!.output().includes(refresh));
    assert.equal(existsSync(path), false);
  } finally { await cleanup(); }
});
