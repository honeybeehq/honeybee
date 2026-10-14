import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { AccountCredentialAuthority } from "../../core/src/index.ts";
import { RpcError, type AccountAddResult } from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, type DaemonHandle } from "./helpers.ts";
import type { RpcClient } from "../../cli/src/client.ts";

test("account.lease carries retryAt for the mint floor and for every request during provider backoff", { timeout: 60_000 }, async () => {
  const source = makeDaemonDir();
  const bootstrap = randomUUID();
  const keys: string[] = [];
  const throttleBody = `throttled ${randomUUID()}`;
  let throttle = false, throttled = 0;
  const server = createServer(async (request, response) => {
    for await (const _ of request) void _;
    if (throttle) {
      throttled++;
      response.writeHead(429, { "retry-after": "120", "content-type": "text/plain" });
      response.end(throttleBody);
      return;
    }
    const key = randomUUID(); keys.push(key);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ api_key: key, base_url: "https://api.meta.ai/muse-code", expires_in: 600 }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const id = "muse-paced";
  const vault = join(source.dir, "vault", "muse", id, "muse", "auth.json");
  const clock = join(source.dir, "clock-offset");
  writeFileSync(clock, "0");
  const preload = join(source.dir, "clock-preload.mjs");
  writeFileSync(preload, `import fs from "node:fs";const now=Date.now;Date.now=()=>now()+Number(fs.readFileSync(${JSON.stringify(clock)},"utf8"));`);
  let daemon: DaemonHandle | null = null;
  let client: RpcClient | null = null;
  const refused = async (): Promise<RpcError> => {
    const error = await client!.request("account.lease", { account: id }).then(() => null, (caught: unknown) => caught);
    assert.ok(error instanceof RpcError, "account.lease is refused with a typed RPC error");
    const wire = JSON.stringify({ code: error.code, message: error.message, details: error.details });
    assert.ok(!wire.includes(bootstrap) && keys.every(key => !wire.includes(key)) && !wire.includes(throttleBody));
    return error;
  };
  try {
    daemon = await startDaemon(source.dir, { env: { HIVE_TEST_META_URL: url, NODE_OPTIONS: `--import=${preload}` } });
    client = await daemon.client();
    assert.equal((await client.request<AccountAddResult>("account.add", { harness: "muse", label: "paced" })).account.id, id);
    mkdirSync(join(vault, ".."), { recursive: true });
    writeFileSync(vault, JSON.stringify({ schema_version: 1, providers: { meta: { mechanism: "oauth", access_token: bootstrap, obtained_via: "device_code", expires_at: 1 } } }));
    const enabledAt = Date.now();
    await client.request<AccountCredentialAuthority>("account.credentials.enable", { id, idempotencyKey: "enable" });
    assert.equal(keys.length, 1);

    const floor = await refused();
    assert.equal(floor.code, "account_unavailable");
    assert.equal(floor.details?.reason, "operation_in_progress");
    assert.equal(typeof floor.details?.retryAt, "number");
    assert.ok((floor.details!.retryAt as number) >= enabledAt + 300_000 && (floor.details!.retryAt as number) <= Date.now() + 300_000);
    assert.equal(floor.details?.failure, undefined);
    assert.equal(keys.length, 1, "the floor refuses without a provider call");

    writeFileSync(clock, "300001");
    throttle = true;
    const first = await refused();
    assert.equal(throttled, 1);
    const later = await refused();
    const last = await refused();
    assert.equal(throttled, 1, "requests during backoff never reach the provider");
    for (const error of [first, later, last]) {
      assert.equal(error.code, "account_unavailable");
      assert.deepEqual(error.details, { reason: "operation_in_progress", retryAt: first.details!.retryAt, failure: { outcome: "retryable", httpStatus: 429, error: null } });
    }
    const retryAt = first.details!.retryAt as number;
    assert.ok(retryAt > Date.now() + 300_001 + 100_000 && retryAt <= Date.now() + 300_001 + 120_000);
    assert.equal(keys.length, 1);
    const output = daemon.output();
    assert.ok(!output.includes(bootstrap) && keys.every(key => !output.includes(key)) && !output.includes(throttleBody));
  } finally {
    client?.close();
    await daemon?.stop().catch(async () => { await daemon?.kill(); });
    await new Promise<void>(resolve => server.close(() => resolve()));
    source.cleanup();
  }
});
