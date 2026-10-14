import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { AccountCredentialAuthority } from "../../core/src/index.ts";
import { RpcError, type AccountLeaseResult, type AccountAddResult } from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";
import { RpcClient } from "../../cli/src/client.ts";

for (const platform of ["linux", "darwin"] as const) test(`Muse central ${platform}: real socket, fake Meta, key-only renewal and durable saved mint across SIGKILL`, { timeout: 120_000 }, async () => {
  const source = makeDaemonDir({ accounts: { centralRefreshAheadMs: 0 } });
  const target = makeDaemonDir();
  const bootstrap = randomUUID();
  const keys: string[] = [];
  let validRequests = true;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    validRequests &&= request.url === "/muse-code/key" && request.method === "POST" && request.headers.authorization === `Bearer ${bootstrap}` && request.headers["x-api-version"] === "1.0.0" && Buffer.concat(chunks).toString() === '{"onboard":false}';
    const key = randomUUID(); keys.push(key);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ api_key: key, base_url: "https://api.meta.ai/muse-code" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const id = "muse-authority";
  const vault = join(source.dir, "vault", "muse", id, "muse", "auth.json");
  const clock = join(source.dir, "clock-offset"), gate = join(source.dir, "publication-gate"), marker = join(source.dir, "publication-held");
  writeFileSync(clock, "0");
  const preload = join(source.dir, "owned-preload.mjs");
  writeFileSync(preload, `import fs from "node:fs";import{syncBuiltinESMExports}from"node:module";const now=Date.now;Date.now=()=>now()+Number(fs.readFileSync(${JSON.stringify(clock)},"utf8"));const rename=fs.renameSync;fs.renameSync=(from,to)=>{if(String(to)===${JSON.stringify(vault)}&&fs.existsSync(${JSON.stringify(gate)})){fs.writeFileSync(${JSON.stringify(marker)},"held");process.kill(process.pid,"SIGSTOP");}return rename(from,to)};syncBuiltinESMExports();`);
  const env = { HIVE_TEST_META_URL: url, NODE_OPTIONS: `--import=${preload}` };
  let daemon: DaemonHandle | null = null, receiver: DaemonHandle | null = null;
  let client: RpcClient | null = null, peer: RpcClient | null = null;
  try {
    daemon = await startDaemon(source.dir, { platform, env });
    client = await daemon.client();
    const added = await client.request<AccountAddResult>("account.add", { harness: "muse", label: "authority" });
    assert.equal(added.account.id, id);
    mkdirSync(join(vault, ".."), { recursive: true });
    writeFileSync(vault, JSON.stringify({ schema_version: 1, providers: { meta: { mechanism: "oauth", access_token: bootstrap, obtained_via: "device_code", expires_at: 1 } } }));
    assert.ok(client.capabilities.includes("account.credentials.muse_authority.v1"));
    const ready = await client.request<AccountCredentialAuthority>("account.credentials.enable", { id, idempotencyKey: "enable" });
    assert.equal(keys.length, 1);
    for (const lane of ["remote", "node_relay"] as const) {
      const remote = await RpcClient.connect(daemon.socketPath, 3000, lane);
      try {
        for (const verb of ["account.credentials.enable", "account.credentials.refresh", "account.credentials.disable"] as const) await assert.rejects(remote.request(verb, { id, ingress: "local_unix", idempotencyKey: `${lane}:${verb}` }), error => error instanceof RpcError && error.code === "account_unavailable" && error.details?.reason === "local_required");
      } finally { remote.close(); }
    }
    assert.equal(keys.length, 1);
    const lease = await client.request<AccountLeaseResult>("account.lease", { account: id });
    assert.equal(keys.length, 1);
    assert.ok(lease.authorityInstanceId === ready.authorityInstanceId && lease.generation === ready.generation);
    const publicRaw = Buffer.from(lease.files[0]!.contentB64, "base64").toString();
    assert.ok(!publicRaw.includes(bootstrap) && !publicRaw.includes("access_token") && !publicRaw.includes("refresh_token"));
    assert.equal(existsSync(join(source.dir, "homes", id, "muse", "auth.json")), platform === "linux");
    await assert.rejects(client.request("account.credentials.refresh", { id, idempotencyKey: "paced" }), error => error instanceof RpcError && error.code === "account_unavailable" && typeof error.details?.retryAt === "number");
    assert.equal(keys.length, 1);
    for (const verb of ["account.credentials.export", "account.credentials.adoptPrepare", "account.credentials.adopt", "account.credentials.standDownReceipt", "account.credentials.standDown", "account.credentials.releasePeer", "account.credentials.operatorTakeover"] as const) {
      await assert.rejects(client.request(verb, { account: id, confirm: true }), error => error instanceof RpcError && error.code === "credential_handoff_unsupported");
    }
    receiver = await startDaemon(target.dir);
    peer = await receiver.client();
    const input = { id: "muse-holder", harness: "muse", label: "holder", shareId: "fixture-share", authorityNodeId: "fixture-authority", epoch: 1, generation: lease.generation, authorityInstanceId: lease.authorityInstanceId, expiresAt: lease.expiresAt, files: lease.files };
    const installed = await peer.request<{ account: { id: string; homePath: string } }>("account.lease.install", input);
    const holderId = installed.account.id;
    const holderFile = join(installed.account.homePath, "muse", "auth.json");
    writeFileSync(holderFile, JSON.stringify({ schema_version: 1, providers: { meta: { api_key: "holder-local-rewrite" } } }));
    writeFileSync(clock, "300001");
    writeFileSync(gate, "hold");
    void client.request("account.credentials.refresh", { id, idempotencyKey: "rotate-once" }, 60_000).catch(() => undefined);
    await waitFor(() => existsSync(marker), "mint saved before publication", 15_000);
    assert.equal(keys.length, 2);
    await daemon.kill();
    client.close(); client = null;
    rmSync(gate);
    daemon = await startDaemon(source.dir, { platform, env });
    client = await daemon.client();
    const recovered = await client.request<AccountLeaseResult>("account.lease", { account: id });
    assert.equal(keys.length, 2, "saved result republishes without a third mint");
    assert.equal(recovered.generation, ready.generation + 1);
    assert.equal(recovered.authorityInstanceId, ready.authorityInstanceId);
    await peer.request("account.lease.install", { ...input, generation: recovered.generation, expiresAt: recovered.expiresAt, files: recovered.files });
    assert.ok(JSON.parse(readFileSync(holderFile, "utf8")).providers.meta.api_key === keys[1]);
    await assert.rejects(peer.request("account.capture", { id: holderId }), error => error instanceof RpcError && error.code === "account_leased");
    await assert.rejects(peer.request("account.lease.export", { id: holderId }), error => error instanceof RpcError && error.code === "account_lease_export_refused" && error.details?.reason === "unsupported");
    const facts = JSON.stringify(await client.request("snapshot"));
    assert.ok(!facts.includes(bootstrap) && keys.every(key => !facts.includes(key)));
    assert.ok(!daemon.output().includes(bootstrap) && keys.every(key => !daemon!.output().includes(key)));
    assert.equal(validRequests, true);
    client.close(); client = null; peer.close(); peer = null;
  } finally {
    client?.close(); peer?.close();
    await daemon?.stop().catch(async () => { await daemon?.kill(); });
    await receiver?.stop().catch(async () => { await receiver?.kill(); });
    await new Promise<void>(resolve => server.close(() => resolve()));
    source.cleanup(); target.cleanup();
  }
});
