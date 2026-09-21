/**
 * Real RPC transport + HiveDaemon dispatch + persistent SQLite owner, without
 * HiveDaemon.start(): startup constructs OS drivers and starts background work.
 * This fixture supplies only the dispatch dependencies and an inert FakeDriver.
 * Effects: fresh temp SQLite, Unix socket, deploy lock and installation fixtures.
 * No daemon lifecycle loops, service manager, keychain or live runtime. The real
 * lock may attempt a bounded read-only /bin/ps probe of this test process; the
 * containment profile denies it and the lock supports unknown birth identity.
 *
 * Source execution cannot prove successful release: BUILD_IDENTITY correctly
 * has no verified release identity. These tests prove that even plausible
 * installed evidence cannot release a source daemon's reservation. Successful
 * release is store-tested; clean-release RPC/installed-only mismatch coverage
 * requires a separately built, isolated release fixture.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore, SCHEMA_VERSION, type CoreStore } from "../../core/src/index.ts";
import { HiveDaemon } from "../src/daemon.ts";
import { BUILD_IDENTITY, RpcError, UPDATE_RECOVERY_CONTRACT } from "../src/protocol.ts";
import { RpcServer, type RpcDispatch } from "../src/rpc.ts";
import { RpcClient } from "../../cli/src/client.ts";
import type { UpdateReservation } from "../../../src/updateReservation.ts";
import { FakeDriver } from "./helpers.ts";

const request = { id: "update-a", recoverySubjectDigest: `sha256:${"a".repeat(64)}`, expectedEpoch: 0 };
type Status = {
  contract: string; schemaVersion: number; runtimeRoot: string; storePath: string;
  identity: typeof BUILD_IDENTITY; reservation: UpdateReservation;
  blockers: Array<{ account: string; phase: string }>;
};

async function fixture(t: TestContext, customStore = false) {
  const root = mkdtempSync(join(tmpdir(), "hb-update-rpc-"));
  const dataDir = join(root, "v2");
  const runtimeRoot = join(root, "runtime");
  const storePath = join(dataDir, customStore ? "custom.sqlite3" : "core.sqlite3");
  mkdirSync(dataDir); mkdirSync(runtimeRoot);
  const driver = new FakeDriver(() => 1_000);
  // Deliberately do not call the constructor/start/stop: those own unrelated
  // production services. Only these three verbs are admitted by this fixture.
  const daemon = Object.create(HiveDaemon.prototype) as {
    cfg: { dataDir: string; storePath: string }; store: CoreStore;
    stopping: boolean; driver: FakeDriver; dispatch: RpcDispatch;
  };
  daemon.cfg = { dataDir, storePath };
  daemon.store = openCoreStore(storePath, { ephemeral: true });
  daemon.stopping = false;
  daemon.driver = driver;
  const server = new RpcServer({
    socketPath: join(root, "rpc.sock"), log: () => {},
    dispatch: (verb, params, conn) => {
      assert.ok(["update.status", "update.reserve", "update.release"].includes(verb));
      return daemon.dispatch(verb, params, conn);
    },
  });
  let client: RpcClient | undefined;
  t.after(async () => {
    client?.close();
    await server.close();
    daemon.store.close();
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(driver.starts, [], "update RPC must not start a bee");
    assert.equal(driver.procs.size, 0);
  });
  await server.listen();
  client = await RpcClient.connect(join(root, "rpc.sock"));
  return {
    root, runtimeRoot, storePath, client,
    get store() { return daemon.store; },
    status: () => client!.request<Status>("update.status"),
    reopenStore() {
      daemon.store.close();
      daemon.store = openCoreStore(storePath, { ephemeral: true });
    },
  };
}

async function refused(action: Promise<unknown>, message: RegExp) {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof RpcError);
    assert.equal(error.code, "invalid_request");
    assert.match(error.message, message);
    return true;
  });
}

test("update RPC status reads live credential blockers and reserve refuses them", async (t) => {
  const f = await fixture(t);
  const initial = await f.status();
  assert.equal(initial.contract, UPDATE_RECOVERY_CONTRACT);
  assert.equal(initial.schemaVersion, SCHEMA_VERSION);
  assert.equal(initial.runtimeRoot, f.runtimeRoot);
  assert.equal(initial.storePath, f.storePath);
  assert.deepEqual(initial.identity, BUILD_IDENTITY);
  assert.deepEqual(initial.blockers, []);
  assert.deepEqual(initial.reservation, { epoch: 0, id: "", recoverySubjectDigest: "", active: false });
  f.store.createAccount({ id: "a", label: "fixture", harness: "claude", homePath: join(f.root, "account") });
  const authority = { account: "a", generation: 1, expiresAt: null, operationKey: null };
  f.store.putAccountCredentialAuthority({ ...authority, phase: "enrolling" });
  assert.deepEqual((await f.status()).blockers, [{ account: "a", phase: "enrolling" }]);
  await refused(f.client.request("update.reserve", request), /credential authority/);
  assert.deepEqual((await f.status()).reservation, initial.reservation);
  f.store.putAccountCredentialAuthority({ ...authority, phase: "disabled" });
  assert.deepEqual((await f.status()).blockers, []);
  const held = await f.client.request<UpdateReservation>("update.reserve", request);
  assert.equal(held.active, true);
  assert.throws(() => f.store.putAccountCredentialAuthority({ ...authority, phase: "enrolling" }), /update.*reserved/i);
  assert.deepEqual((await f.status()).reservation, held);
});

test("update RPC reserve retries require exact prior epoch and survive reopening SQLite", async (t) => {
  const f = await fixture(t);
  const held = await f.client.request<UpdateReservation>("update.reserve", request);
  assert.deepEqual(held, { epoch: 1, id: request.id, recoverySubjectDigest: request.recoverySubjectDigest, active: true });
  assert.deepEqual(await f.client.request("update.reserve", request), held);
  await refused(f.client.request("update.reserve", { ...request, expectedEpoch: held.epoch }), /reserved/);
  await refused(f.client.request("update.reserve", { ...request, id: "update-b" }), /epoch/);
  await refused(f.client.request("update.reserve", { ...request, recoverySubjectDigest: `sha256:${"b".repeat(64)}` }), /epoch/);
  for (const expectedEpoch of ["0", -1, 0.5]) {
    await refused(f.client.request("update.reserve", { ...request, expectedEpoch }), /expectedEpoch|Invalid update reservation/);
  }
  f.reopenStore();
  assert.deepEqual((await f.status()).reservation, held);
  assert.deepEqual(await f.client.request("update.reserve", request), held);
});

test("update RPC cannot release a source daemon even with clean-looking installed evidence", async (t) => {
  assert.equal(BUILD_IDENTITY.release, false, "This source test must not use manufactured running-release evidence");
  const f = await fixture(t);
  const held = await f.client.request<UpdateReservation>("update.reserve", request);
  const revision = "1".repeat(40);
  const target = `${process.platform}-${process.arch}`;
  const expected = { component: "honeybee", version: "1.2.3", sourceRevision: revision, target,
    artifact: { url: "https://fixtures.invalid/honeybee.tgz", sha256: `sha256:${"c".repeat(64)}` } };
  const installed = join(f.runtimeRoot, revision);
  mkdirSync(join(installed, "dist"), { recursive: true });
  writeFileSync(join(installed, "dist", "build-identity.json"), JSON.stringify({
    schemaVersion: 1, ...expected, packageVersion: expected.version, dirty: false, release: true,
  }));
  writeFileSync(join(installed, ".honeybee-deployment.json"), JSON.stringify({
    schemaVersion: 1, runtime: "v2", recoveryContract: UPDATE_RECOVERY_CONTRACT, identity: expected,
  }));
  symlinkSync(revision, join(f.runtimeRoot, "current"));
  const variants = [undefined, BUILD_IDENTITY, expected,
    { ...expected, component: "apiary" }, { ...expected, version: "9.9.9" },
    { ...expected, sourceRevision: "2".repeat(40) }, { ...expected, target: "different-target" },
    { ...expected, artifact: { ...expected.artifact, sha256: `sha256:${"d".repeat(64)}` } }];
  for (const expectedIdentity of variants) {
    await refused(f.client.request("update.release", { ...held, expectedIdentity }), /Running identity/);
    assert.deepEqual((await f.status()).reservation, held);
  }
  unlinkSync(join(f.runtimeRoot, "current"));
  symlinkSync("2".repeat(40), join(f.runtimeRoot, "current"));
  await refused(f.client.request("update.release", { ...held, expectedIdentity: expected }), /Running identity/);
  f.reopenStore();
  assert.deepEqual((await f.status()).reservation, held, "every refusal preserves the durable reservation");
});

test("update RPC reports a custom store but refuses to reserve or release it", async (t) => {
  const f = await fixture(t, true);
  assert.equal((await f.status()).storePath, f.storePath);
  await refused(f.client.request("update.reserve", request), /Custom stores/);
  await refused(f.client.request("update.release", { ...request, epoch: 1 }), /Custom stores/);
  assert.equal((await f.status()).reservation.active, false);
});
