/**
 * Muse on macOS keeps ONE Keychain login per OS user, whatever account home
 * it is given, and moves any file token it reads into that item. A REAL
 * daemon process that reports darwin must therefore never execute muse (not
 * even `--version`), never run it under an account or write a Muse
 * credential into a home, and say why. It may hold a Muse account whose
 * login Honeybee performed itself (muse_oauth, vault only) and lease it.
 * The same data dir under linux behaves as before.
 * SAFETY: temp dirs and a temp HOME only; "muse" is a shell script that
 * records each run; Meta's device endpoints are a loopback fake.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RpcError, type AccountAddResult, type AccountLeaseResult, type AccountLoginGetResult, type AccountLoginStartResult, type ListResult, type NodeHarnessesResult } from "../src/protocol.ts";
import type { RpcClient } from "../../cli/src/client.ts";
import { deviceAuthorization, granted, startFakeMetaDevice } from "./fixtures/fake-meta-device.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const REASON = "Muse keeps one login per macOS user in the Keychain, so Muse accounts can't be isolated on this Mac; run Muse on a Linux node";

async function refused(client: RpcClient, verb: Parameters<RpcClient["request"]>[0], params: Record<string, unknown>, code: string, message: string | RegExp = REASON): Promise<void> {
  try {
    await client.request(verb, params);
  } catch (err) {
    assert.ok(err instanceof RpcError, `expected RpcError, got ${String(err)}`);
    assert.equal(err.code, code, `${verb}: ${err.message}`);
    if (typeof message === "string") assert.ok(err.message.includes(message), `${verb}: ${err.message}`);
    else assert.match(err.message, message, verb);
    return;
  }
  assert.fail(`${verb}: expected ${code}`);
}

test("muse on darwin: never executed, spawned, or written into a home; a Muse account is held through Honeybee's own Meta sign-in and leased; node.harnesses says why", async () => {
  const { dir, cleanup } = makeDaemonDir();
  const ran = join(dir, "muse-ran");
  const fakeMuse = join(dir, "muse");
  writeFileSync(fakeMuse, `#!/bin/sh\necho "$@" >> "${ran}"\necho "Muse Code 9.9.9"\n`);
  chmodSync(fakeMuse, 0o755);
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    ...JSON.parse(readFileSync(join(dir, "config.json"), "utf8")),
    agents: { muse: { command: fakeMuse, adapter: "muse" } },
  }));
  // The darwin daemon's HOME is a temp dir: importing "the machine's own login" reads nothing real.
  const home = join(dir, "home");
  mkdirSync(join(home, ".config"), { recursive: true });
  const meta = await startFakeMetaDevice({ authorization: deviceAuthorization({ interval: 1 }), token: [granted()] });
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
    daemon = await startDaemon(dir, { platform: "darwin", env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), HIVE_MUSE_OAUTH_URL: meta.url } });
    client = await daemon.client();
    const { harnesses } = await client.request<NodeHarnessesResult>("node.harnesses");
    muse = harnesses.find((h) => h.harness === "muse");
    assert.deepEqual(
      { present: muse?.present, path: muse?.path, version: muse?.version, unavailable: muse?.unavailable },
      { present: true, path: fakeMuse, version: null, unavailable: REASON },
    );
    assert.ok(harnesses.filter((h) => h.harness !== "muse").every((h) => h.unavailable === null));

    // Holding a record: account.add works; there is nothing on this Mac to import.
    const mac = await client.request<AccountAddResult>("account.add", { harness: "muse", label: "mac" });
    assert.deepEqual({ id: mac.account.id, status: mac.account.status, credentialHealth: mac.credentialHealth }, { id: "muse-mac", status: "auth_needed", credentialHealth: "absent" });
    await refused(client, "account.add", { harness: "muse", label: "mine", importExisting: true }, "no_credentials_to_import", /no muse credentials to import/);

    // Running muse stays refused.
    await refused(client, "spawn", { name: "auto", agent: "muse", cwd: dir }, "account_unavailable");
    await refused(client, "spawn", { name: "explicit", agent: "muse", cwd: dir, account: "muse-sub" }, "account_unavailable");
    await refused(client, "spawn", { name: "rr", agent: "muse", cwd: dir, account: "rr" }, "account_unavailable");
    assert.deepEqual((await client.request<ListResult>("list", {})).views, []);

    // Logins that run muse stay refused; Honeybee's own sign-in is the default.
    await refused(client, "account.login.start", { id: "muse-sub", methodId: "muse-device" }, "login_method_unsupported");
    await refused(client, "account.login.start", { id: "muse-sub", methodId: "muse-api-key" }, "login_method_unsupported");
    const started = await client.request<AccountLoginStartResult>("account.login.start", { id: "muse-mac", remote: true });
    assert.deepEqual(
      { methodId: started.flow.methodId, methods: started.flow.methods.map((m) => m.id), phase: started.flow.phase, url: started.flow.authorizationUrl, code: started.flow.userCode },
      { methodId: "muse-oauth", methods: ["muse-oauth"], phase: "waiting_device", url: "https://auth.meta.com/oauth/device/?code=ABCD-EFGH", code: "ABCD-EFGH" },
    );
    const done = await waitFor(async () => {
      const { flow } = await client.request<AccountLoginGetResult>("account.login.get", { flowId: started.flow.id });
      return flow.phase === "succeeded" || flow.phase === "failed" ? flow : null;
    }, "muse_oauth flow settles", 15_000, 100);
    assert.equal(done.phase, "succeeded", JSON.stringify(done.error));
    assert.equal(existsSync(join(dir, "homes", "muse-mac", "muse", "auth.json")), false, "no Muse credential in a home on darwin");
    assert.equal(existsSync(join(dir, "vault", "muse", "muse-mac", "muse", "auth.json")), true);

    // The held login is leased to Linux nodes, refresh token blanked.
    const lease = await client.request<AccountLeaseResult>("account.lease", { account: "muse-mac" });
    const shipped = JSON.parse(Buffer.from(lease.files[0]!.contentB64, "base64").toString("utf8"));
    assert.deepEqual({ mechanism: shipped.providers.meta.mechanism, refresh: shipped.providers.meta.refresh_token }, { mechanism: "oauth", refresh: "" });
    await refused(client, "spawn", { name: "held", agent: "muse", cwd: dir, account: "muse-mac" }, "account_unavailable");

    // Leasing an account with no login says so; writing into a home stays refused.
    await refused(client, "account.lease", { account: "muse-sub" }, "lease_unavailable", /no muse\/auth.json found for muse-sub/);
    const file = { homeRelPath: "muse/auth.json", mode: 0o600, contentB64: Buffer.from('{"schema_version":1,"providers":{"meta":{"api_key":"k"}}}').toString("base64") };
    await refused(client, "account.lease.install", { id: "muse-peer", shareId: "share-0001", authorityNodeId: "linux-1", harness: "muse", label: "peer", epoch: 1, expiresAt: null, files: [file] }, "lease_unsupported");
    await refused(client, "account.capture", { id: "muse-sub" }, "invalid_request", /no valid muse credential/);
    await refused(client, "account.credentialsRestored", { id: "muse-sub" }, "account_unavailable");

    assert.equal(existsSync(ran), false, "muse was never executed on darwin");
    assert.equal(existsSync(join(dir, "homes", "muse-sub", "muse", "auth.json")), false);
    assert.equal(existsSync(join(dir, "homes", "muse-peer@share-00")), false, "a refused lease install writes no home");
    assert.doesNotMatch(daemon.output(), /DUMMY-(ACCESS|REFRESH|DEVICE)/, "no token in the daemon's output");
    client.close();
  } finally {
    if (daemon) await daemon.stop().catch(() => {});
    await meta.close();
    cleanup();
  }
});
