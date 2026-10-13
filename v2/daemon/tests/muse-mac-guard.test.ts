/**
 * Muse on macOS keeps ONE Keychain login per OS user, whatever account home
 * it is given, and moves any file token it reads into that item. A REAL
 * daemon process that reports darwin must therefore never execute muse (not
 * even `--version`), never hold a Muse account, and say why — while the same
 * data dir under linux behaves as before.
 * SAFETY: temp dirs only; "muse" is a shell script that records each run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RpcError, type AccountAddResult, type AccountListResult, type ListResult, type NodeHarnessesResult } from "../src/protocol.ts";
import type { RpcClient } from "../../cli/src/client.ts";
import { makeDaemonDir, startDaemon, type DaemonHandle } from "./helpers.ts";

const REASON = "Muse keeps one login per macOS user in the Keychain, so Muse accounts can't be isolated on this Mac; run Muse on a Linux node";

async function refused(client: RpcClient, verb: Parameters<RpcClient["request"]>[0], params: Record<string, unknown>, code: string): Promise<void> {
  try {
    await client.request(verb, params);
  } catch (err) {
    assert.ok(err instanceof RpcError, `expected RpcError, got ${String(err)}`);
    assert.equal(err.code, code, `${verb}: ${err.message}`);
    assert.ok(err.message.includes(REASON), `${verb}: ${err.message}`);
    return;
  }
  assert.fail(`${verb}: expected ${code}`);
}

test("muse on darwin: never executed, no account added, spawned, logged in, captured or leased; node.harnesses says why", async () => {
  const { dir, cleanup } = makeDaemonDir();
  const ran = join(dir, "muse-ran");
  const fakeMuse = join(dir, "muse");
  writeFileSync(fakeMuse, `#!/bin/sh\necho "$@" >> "${ran}"\necho "Muse Code 9.9.9"\n`);
  chmodSync(fakeMuse, 0o755);
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    ...JSON.parse(readFileSync(join(dir, "config.json"), "utf8")),
    agents: { muse: { command: fakeMuse, adapter: "muse" } },
  }));
  let daemon: DaemonHandle | null = null;
  try {
    // linux: the fact row is plain, the version probe runs, an account can exist.
    daemon = await startDaemon(dir, { platform: "linux" });
    let client = await daemon.client();
    let muse = (await client.request<NodeHarnessesResult>("node.harnesses")).harnesses.find((h) => h.harness === "muse");
    assert.deepEqual({ present: muse?.present, version: muse?.version, unavailable: muse?.unavailable }, { present: true, version: "Muse Code 9.9.9", unavailable: null });
    assert.equal(existsSync(ran), true);
    const added = await client.request<AccountAddResult>("account.add", { harness: "muse", label: "sub" });
    assert.equal(added.account.id, "muse-sub");
    client.close();
    await daemon.stop();
    rmSync(ran);

    // darwin, same data dir: the account row predates the guard.
    daemon = await startDaemon(dir, { platform: "darwin" });
    client = await daemon.client();
    const { harnesses } = await client.request<NodeHarnessesResult>("node.harnesses");
    muse = harnesses.find((h) => h.harness === "muse");
    assert.deepEqual(
      { present: muse?.present, path: muse?.path, version: muse?.version, unavailable: muse?.unavailable },
      { present: true, path: fakeMuse, version: null, unavailable: REASON },
    );
    assert.ok(harnesses.filter((h) => h.harness !== "muse").every((h) => h.unavailable === null));

    await refused(client, "account.add", { harness: "muse", label: "mac" }, "account_unavailable");
    await refused(client, "account.add", { harness: "muse", label: "mac", importExisting: true }, "account_unavailable");
    assert.deepEqual((await client.request<AccountListResult>("account.list", {})).accounts.map((a) => a.id), ["muse-sub"]);
    assert.equal(existsSync(join(dir, "homes", "muse-mac")), false);

    await refused(client, "spawn", { name: "auto", agent: "muse", cwd: dir }, "account_unavailable");
    await refused(client, "spawn", { name: "explicit", agent: "muse", cwd: dir, account: "muse-sub" }, "account_unavailable");
    await refused(client, "spawn", { name: "rr", agent: "muse", cwd: dir, account: "rr" }, "account_unavailable");
    assert.deepEqual((await client.request<ListResult>("list", {})).views, []);

    await refused(client, "account.login.start", { id: "muse-sub" }, "login_method_unsupported");
    await refused(client, "account.login.start", { id: "muse-sub", methodId: "muse-api-key" }, "login_method_unsupported");
    await refused(client, "account.lease", { account: "muse-sub" }, "lease_unsupported");
    const file = { homeRelPath: "muse/auth.json", mode: 0o600, contentB64: Buffer.from('{"schema_version":1,"providers":{"meta":{"api_key":"k"}}}').toString("base64") };
    await refused(client, "account.lease.install", { id: "muse-peer", shareId: "share-0001", authorityNodeId: "linux-1", harness: "muse", label: "peer", epoch: 1, expiresAt: null, files: [file] }, "lease_unsupported");
    await refused(client, "account.capture", { id: "muse-sub" }, "invalid_request");
    await refused(client, "account.credentialsRestored", { id: "muse-sub" }, "account_unavailable");

    assert.equal(existsSync(ran), false, "muse was never executed on darwin");
    assert.equal(existsSync(join(dir, "homes", "muse-sub", "muse", "auth.json")), false);
    assert.equal(existsSync(join(dir, "vault", "muse")), false);
    assert.equal(existsSync(join(dir, "homes", "muse-peer@share-00")), false, "a refused lease install writes no home");
    client.close();
  } finally {
    if (daemon) await daemon.stop().catch(() => {});
    cleanup();
  }
});
