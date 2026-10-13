/**
 * Muse on macOS keeps ONE Keychain login per OS user, whatever account home
 * it is given, and moves any file token it reads into that item. A REAL
 * daemon process that reports darwin must therefore never execute muse (not
 * even `--version`), never run it under an account or write a Muse
 * credential into a home, and say why. It may hold a Muse account whose
 * login Honeybee performed itself (muse_oauth, vault only) and lease it.
 * Muse runs there only as the user's own login (This Mac, or unbound), with
 * no home env; its version is read from the launcher's stamp.
 * The same data dir under linux behaves as before.
 * SAFETY: temp dirs and a temp HOME only; "muse" is a shell script that
 * records each run; Meta's device endpoints are a loopback fake.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcError, type AccountAddResult, type AccountCredentialsRestoredResult, type AccountGetResult, type AccountLeaseResult, type AccountLoginGetResult, type AccountLoginStartResult, type ListResult, type NodeHarnessesResult, type SpawnResult } from "../src/protocol.ts";
import type { RpcClient } from "../../cli/src/client.ts";
import { deviceAuthorization, granted, startFakeMetaDevice } from "./fixtures/fake-meta-device.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const REASON = "Muse keeps one login per macOS user in the Keychain, so Muse accounts can't be isolated on this Mac; use This Mac (your own `muse login`) or run Muse on a Linux node";

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

test("muse on darwin: never executed for a probe, spawned under a held account, or written into a home; a Muse account is held through Honeybee's own Meta sign-in and leased", async () => {
  const { dir, cleanup } = makeDaemonDir();
  const ran = join(dir, "muse-ran");
  const fakeMuse = join(dir, "muse");
  writeFileSync(fakeMuse, `#!/bin/sh\necho "$@" >> "${ran}"\necho "Muse Code 9.9.9"\n`);
  chmodSync(fakeMuse, 0o755);
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    ...JSON.parse(readFileSync(join(dir, "config.json"), "utf8")),
    agents: { muse: { command: fakeMuse, adapter: "muse" } },
  }));
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
    daemon = await startDaemon(dir, { platform: "darwin", env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), HIVE_TEST_META_URL: meta.url } });
    client = await daemon.client();
    const { harnesses } = await client.request<NodeHarnessesResult>("node.harnesses");
    muse = harnesses.find((h) => h.harness === "muse");
    assert.deepEqual(
      { present: muse?.present, path: muse?.path, version: muse?.version, unavailable: muse?.unavailable },
      { present: true, path: fakeMuse, version: null, unavailable: null },
    );
    assert.ok(harnesses.filter((h) => h.harness !== "muse").every((h) => h.unavailable === null));

    const mac = await client.request<AccountAddResult>("account.add", { harness: "muse", label: "mac" });
    assert.deepEqual({ id: mac.account.id, status: mac.account.status, credentialHealth: mac.credentialHealth }, { id: "muse-mac", status: "auth_needed", credentialHealth: "absent" });
    await refused(client, "account.add", { harness: "muse", label: "mine", importExisting: true }, "no_credentials_to_import", /no muse credentials to import/);

    await refused(client, "spawn", { name: "auto", agent: "muse", cwd: dir }, "account_unavailable");
    await refused(client, "spawn", { name: "explicit", agent: "muse", cwd: dir, account: "muse-sub" }, "account_unavailable");
    await refused(client, "spawn", { name: "rr", agent: "muse", cwd: dir, account: "rr" }, "account_unavailable");
    assert.deepEqual((await client.request<ListResult>("list", {})).views, []);

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

    const lease = await client.request<AccountLeaseResult>("account.lease", { account: "muse-mac" });
    const shipped = JSON.parse(Buffer.from(lease.files[0]!.contentB64, "base64").toString("utf8"));
    assert.deepEqual({ mechanism: shipped.providers.meta.mechanism, refresh: shipped.providers.meta.refresh_token }, { mechanism: "oauth", refresh: "" });
    await refused(client, "spawn", { name: "held", agent: "muse", cwd: dir, account: "muse-mac" }, "account_unavailable");

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

const THIS_MAC = "This Mac: uses your own Muse sign-in (`muse login`) on this computer. Every Muse session on this Mac shares it. Honeybee never copies or changes it.";
const FAKE_MUSE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "driver-hsr", "test-agent", "fake-muse.mjs");
const USAGE_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "adapters", "tests", "fixtures", "muse-usage-changed.jsonl");

function treeOf(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string): void => {
    if (!existsSync(at)) return;
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[path.slice(root.length + 1)] = readFileSync(path, "utf8");
    }
  };
  walk(root);
  return out;
}

test("muse on darwin: This Mac is the machine's own `muse login` — added once with no login, never signed in, copied or leased; Muse bees run on it with no home env; its state never runs muse or security", async () => {
  const { dir, cleanup } = makeDaemonDir();
  // Sentinels first on PATH: any run of `muse` or `security` is recorded and fails.
  const bin = join(dir, "sentinel-bin");
  const sentinelLog = join(dir, "sentinel.log");
  mkdirSync(bin, { recursive: true });
  for (const name of ["muse", "security"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${sentinelLog}"\nexit 1\n`);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(bin, ".muse-version"), "1.4.7-R6101.1\n");
  const [usageLine] = readFileSync(USAGE_FIXTURE, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const observedAtMs = Date.now() - 60_000;
  usageLine.params = { ...usageLine.params, observedAtMs, window: { ...usageLine.params.window, resetsAtMs: Date.now() + 3_600_000 } };
  const recorded = join(dir, "recorded.jsonl");
  writeFileSync(recorded, `${JSON.stringify(usageLine)}\n`);
  const envOut = join(dir, "muse-env.json");
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    ...JSON.parse(readFileSync(join(dir, "config.json"), "utf8")),
    agents: {
      muse: { command: process.execPath, args: [FAKE_MUSE, "serve"], adapter: "muse", env: { MUSE_NO_AUTO_UPDATE: "1", FAKE_MUSE_NATIVE: "1", FAKE_MUSE_ENV_OUT: envOut, FAKE_MUSE_RECORDED: recorded } },
      "muse-cli": { command: "muse", adapter: "muse", env: { MUSE_NO_AUTO_UPDATE: "1" }, versionStamps: [".muse-version"] },
    },
  }));
  const home = join(dir, "home");
  const config = join(home, ".config");
  mkdirSync(home, { recursive: true });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir, { platform: "darwin", env: { HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` } });
    const client = await daemon.client();

    // node.harnesses: Muse runs on this Mac; its version comes from the launcher's stamp.
    const { harnesses } = await client.request<NodeHarnessesResult>("node.harnesses");
    const cli = harnesses.find((h) => h.harness === "muse-cli");
    assert.deepEqual({ path: cli?.path, version: cli?.version, unavailable: cli?.unavailable }, { path: join(bin, "muse"), version: "1.4.7-R6101.1", unavailable: null });
    assert.equal(harnesses.find((h) => h.harness === "muse")?.unavailable, null);

    await refused(client, "spawn", { name: "early", agent: "muse", cwd: dir }, "account_unavailable", /Add This Mac with: hive account add muse --native/);

    // Added once, with no login: it is the user's own sign-in, which is not there yet.
    const added = await client.request<AccountAddResult>("account.add", { harness: "muse", native: true });
    assert.deepEqual(
      { id: added.account.id, label: added.account.label, home: added.account.homePath, status: added.account.status, health: added.credentialHealth, native: added.account.nativeLogin },
      { id: "muse-this-mac", label: "This Mac", home: config, status: "auth_needed", health: "absent", native: THIS_MAC },
    );
    await refused(client, "account.add", { harness: "muse", native: true, label: "Second" }, "invalid_request", /already has its native muse account: muse-this-mac/);
    await refused(client, "account.add", { harness: "muse", label: "mine", homePath: config }, "invalid_request", /add it with native: true/);
    await refused(client, "account.add", { harness: "claude", native: true }, "account_unavailable", /claude has no native account/);
    await refused(client, "spawn", { name: "unsigned", agent: "muse", cwd: dir, account: "muse-this-mac" }, "account_auth_needed", /needs its sign-in. Run `muse login` in Terminal on this Mac/);

    // The user runs `muse login` in Terminal; Muse leaves a Keychain pointer.
    mkdirSync(join(config, "muse"), { recursive: true });
    writeFileSync(join(config, "muse", "auth.json"), JSON.stringify({ schema_version: 2, providers: { meta: { mechanism: "oauth", obtained_via: "device_code", storage: "keychain", expires_at: 4102444800000 } } }));
    const restored = await client.request<AccountCredentialsRestoredResult>("account.credentialsRestored", { id: "muse-this-mac" });
    assert.equal(restored.account.status, "ok");
    const before = treeOf(home);

    // Never signed in, copied, leased or written by Honeybee.
    const never = /This Mac is this computer's own muse sign-in; Honeybee never signs it in, copies, leases or changes it/;
    await refused(client, "account.login.start", { id: "muse-this-mac" }, "login_method_unsupported", never);
    await refused(client, "account.lease", { account: "muse-this-mac" }, "lease_unsupported", never);
    await refused(client, "account.capture", { id: "muse-this-mac" }, "invalid_request", never);
    await refused(client, "account.config.preview", { id: "muse-this-mac" }, "config_import_refused", never);
    const file = { homeRelPath: "muse/auth.json", mode: 0o600, contentB64: Buffer.from('{"schema_version":1,"providers":{"meta":{"api_key":"k"}}}').toString("base64") };
    await refused(client, "account.lease.install", { id: "muse-this-mac", shareId: "share-0001", authorityNodeId: "linux-1", harness: "muse", label: "this-mac", epoch: 1, expiresAt: null, files: [file], adopt: "explicit" }, "lease_unsupported");

    // A Honeybee-held account still never runs here.
    await client.request<AccountAddResult>("account.add", { harness: "muse", label: "held" });
    await refused(client, "spawn", { name: "held", agent: "muse", cwd: dir, account: "muse-held" }, "account_unavailable", REASON);

    // Auto picks This Mac; the bee runs with the user's HOME and no XDG overrides.
    const spawned = await client.request<SpawnResult>("spawn", { name: "native", agent: "muse", cwd: dir, prompt: "hello" });
    assert.deepEqual({ account: spawned.account, reason: spawned.accountReason }, { account: "muse-this-mac", reason: THIS_MAC });
    const ran = await waitFor(() => existsSync(envOut) ? JSON.parse(readFileSync(envOut, "utf8")) as { argv: string[]; env: Record<string, string> } : null, "native muse serve starts", 15_000);
    assert.equal(ran.argv[0], "serve");
    const inherited = (key: string) => process.env[key] === undefined ? {} : { [key]: process.env[key] };
    assert.deepEqual(ran.env, { HOME: home, MUSE_NO_AUTO_UPDATE: "1", ...inherited("XDG_CONFIG_HOME"), ...inherited("XDG_DATA_HOME"), ...inherited("TBH_CREDENTIAL_BACKEND") }, "Honeybee sets no XDG pair or credential backend for This Mac");

    // The live session's usage lands on This Mac's limits row.
    const limits = await waitFor(async () => {
      const row = (await client.request<AccountGetResult>("account.get", { id: "muse-this-mac" })).limits;
      return row?.readable ? row : null;
    }, "usage/changed lands on This Mac", 15_000);
    assert.equal(limits.fetchedAt, observedAtMs);

    // `--account none` still runs unbound.
    const unbound = await client.request<SpawnResult>("spawn", { name: "unbound", agent: "muse", cwd: dir, account: null });
    assert.equal(unbound.account ?? null, null);

    assert.deepEqual(treeOf(home), before, "the machine's own Muse files are untouched");
    assert.equal(existsSync(join(dir, "vault", "muse", "muse-this-mac")), false, "nothing reaches the vault");
    assert.equal(existsSync(sentinelLog), false, "neither muse nor security was ever executed");
    assert.doesNotMatch(daemon.output(), /DUMMY-(ACCESS|REFRESH)|"(access|refresh)_token"\s*:\s*"[^"]/);
    client.close();
  } finally {
    if (daemon) await daemon.stop().catch(() => {});
    cleanup();
  }
});
