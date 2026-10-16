import assert from "node:assert/strict";
import { test } from "node:test";
import { cp, mkdir, mkdtemp, readFile, writeFile, rm, symlink, readlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { openCoreStore } from "../v2/core/src/index.ts";
import { parseRecoveryPlan } from "../src/release/index.js";
import { canonicalDigest } from "../src/comb/canonical.js";
import { parseUpdateReservation, UPDATE_RECOVERY_CONTRACT } from "../src/updateReservation.js";
import { APIARY_SWAP_CAPABILITY, parseApiarySwapAcquire, parseDurableUpdateReservation, type ApiarySwapAcquire, type ApiarySwapReservation, type ApiarySwapReceipt } from "../src/apiarySwap.js";
import { assertRuntimeUpdateAllowed } from "../src/readUpdateReservation.js";
import { deployVersion, rollbackDeploy, deployArtifact, pruneRuntimeVersions, DeployReservationHeldError } from "../src/deployRuntime.js";
import { withFileLock } from "../src/lock.js";

const exec = promisify(execFile);
const hash = (character: string) => `sha256:${character.repeat(64)}`;
const identity = { component: "honeybee" as const, version: "0.0.1", sourceRevision: "a".repeat(40), target: `${process.platform}-${process.arch}`, artifact: { url: "https://example.test/honeybee.tgz", sha256: hash("a") } };
function acquire(root: string, expectedEpoch = 0): ApiarySwapAcquire {
  const component = { protocol: "apiary/1", buildId: "previous", version: "1.0.0", target: identity.target, artifact: { url: "https://example.test/apiary.tgz", sha256: hash("b") } };
  const previous = { app: component, resident: component };
  const candidate = { app: { ...component, buildId: "candidate", version: "1.0.1", artifact: { ...component.artifact, sha256: hash("c") } }, resident: component };
  const transaction = { version: 1 as const, purpose: "apiary-swap" as const, scope: { node: hostname(), appRoot: join(root, "app"), runtimeRoot: join(root, "runtime"), storePath: join(root, "v2", "core.sqlite3") }, previous, candidate, rollback: previous, expectedHoneybeeIdentity: identity };
  return { purpose: "apiary-swap", id: "swap-a", expectedEpoch, transactionDigest: canonicalDigest(transaction), expectedHoneybeeIdentity: identity, transaction };
}
function token(held: ApiarySwapReservation) {
  return { purpose: held.purpose, id: held.id, epoch: held.epoch, transactionDigest: held.transactionDigest, expectedHoneybeeIdentity: held.expectedHoneybeeIdentity };
}
function release(held: ApiarySwapReservation, outcome: "succeeded" | "rolled-back" = "succeeded") {
  return { ...token(held), completionReceipt: { ...token(held), version: 1 as const, journalDigest: hash("d"), outcome, policy: "restored" as const } };
}
async function world(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "hb-s4-"));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("apiary reservation: durable owner, exact replay, release, abandon, recovery epoch and v1 exclusion", async () => {
  await world(async root => {
    await mkdir(join(root, "v2"));
    let store = openCoreStore(join(root, "v2", "core.sqlite3"), { ephemeral: true });
    try {
      const request = acquire(root), held = store.acquireApiarySwap(request);
      assert.deepEqual(store.acquireApiarySwap(request), held);
      assert.throws(() => store.reserveUpdate({ id: "paired", expectedEpoch: held.epoch, recoverySubjectDigest: hash("f") }), /Corrupt/);
      assert.throws(() => store.releaseUpdate({ id: held.id, epoch: held.epoch, recoverySubjectDigest: hash("f") }), /Corrupt/);
      assert.throws(() => parseUpdateReservation(held), /Corrupt/);
      store.close(); store = openCoreStore(join(root, "v2", "core.sqlite3"), { ephemeral: true });
      assert.deepEqual(store.durableUpdateReservation(), held);
      const completed = store.settleApiarySwap(release(held), "release");
      assert.deepEqual(store.settleApiarySwap(release(held), "release"), completed);
      assert.throws(() => store.settleApiarySwap(release(held, "rolled-back"), "release"), /resolution differs/);
      const second = store.acquireApiarySwap({ ...request, id: "swap-b", expectedEpoch: held.epoch });
      assert.throws(() => store.settleApiarySwap(release(held), "release"), /mismatch/);
      const abandon = { ...token(second), cancellationReceipt: { ...token(second), version: 1, journalDigest: hash("e"), outcome: "abandoned", phase: "acquired", policy: "unchanged" } };
      assert.deepEqual(store.settleApiarySwap(abandon, "abandon"), store.settleApiarySwap(abandon, "abandon"));
      const third = store.acquireApiarySwap({ ...request, id: "swap-c", expectedEpoch: second.epoch });
      const recovery = { purpose: third.purpose, id: third.id, expectedEpoch: third.epoch, transactionDigest: third.transactionDigest, expectedHoneybeeIdentity: third.expectedHoneybeeIdentity, recoveryId: "recovery-a", recoveryReceipt: { ...token(third), version: 1, journalDigest: hash("e"), outcome: "recovered", policy: "restored", coordinator: "fenced", generations: "reconciled" } };
      const recovered = store.recoverApiarySwap(recovery);
      assert.equal(recovered.epoch, third.epoch + 1); assert.equal(recovered.active, false);
      assert.deepEqual(store.recoverApiarySwap(recovery), recovered);
      assert.throws(() => store.settleApiarySwap(release(third), "release"), /mismatch/);
      const fourth = store.acquireApiarySwap({ ...request, id: "swap-d", expectedEpoch: recovered.epoch });
      assert.throws(() => store.recoverApiarySwap(recovery), /mismatch/);
      assert.equal(fourth.epoch, recovered.epoch + 1);
    } finally { store.close(); }
  });
});

test("apiary reservation: closed transaction/receipt binding refuses corruption and ambiguous cancellation", async () => {
  await world(async root => {
    await mkdir(join(root, "v2"));
    const store = openCoreStore(join(root, "v2", "core.sqlite3"), { ephemeral: true });
    try {
      const request = acquire(root), held = store.acquireApiarySwap(request);
      for (const mutation of [ { ...request, purpose: "unknown" }, { ...request, transactionDigest: hash("f") }, { ...request, expectedEpoch: -1 }, { ...request, transaction: { ...request.transaction, version: 2 } }, { ...request, transaction: { ...request.transaction, rollback: request.transaction.candidate } } ]) assert.throws(() => store.acquireApiarySwap(mutation));
      assert.throws(() => parseDurableUpdateReservation({ ...held, recoverySubjectDigest: hash("f") }), /unknown/);
      assert.throws(() => store.settleApiarySwap({ ...release(held), completionReceipt: null }, "release"));
      assert.throws(() => store.settleApiarySwap({ ...token(held), cancellationReceipt: { ...release(held).completionReceipt, outcome: "abandoned", phase: "suppressed", policy: "unchanged" } }, "abandon"));
      assert.throws(() => store.recoverApiarySwap({ ...token(held), expectedEpoch: held.epoch, recoveryId: "bad", recoveryReceipt: { ...release(held).completionReceipt, outcome: "recovered" } }));
      assert.deepEqual(store.durableUpdateReservation(), held);
    } finally { store.close(); }
  });
});

const phases = ["acquired", "suppressed", "app-exited", "resident-stopped", "lock-converted", "generation-swapped", "ready", "relaunch-receipt", "policy-restored"];
test("apiary reservation: coordinator crash at every S4 boundary stays held across reopen without expiry", async () => {
  await world(async root => {
    await mkdir(join(root, "v2"));
    for (const phase of phases) {
      const path = join(root, "v2", `${phase}.sqlite3`);
      let store = openCoreStore(path, { ephemeral: true });
      const held = store.acquireApiarySwap(acquire(root));
      store.close(); store = openCoreStore(path, { ephemeral: true });
      try {
        assert.deepEqual(store.durableUpdateReservation(), held, phase);
        assert.throws(() => store.settleApiarySwap({ ...token(held), completionReceipt: undefined }, "release"));
        assert.throws(() => store.acquireApiarySwap({ ...acquire(root), id: "other" }), /epoch|reserved/);
      } finally { store.close(); }
    }
  });
});

async function seed(root: string) {
  await mkdir(join(root, "v2"), { recursive: true });
  const store = openCoreStore(join(root, "v2", "core.sqlite3"), { ephemeral: true });
  try { return store.acquireApiarySwap(acquire(root)); } finally { store.close(); }
}
async function repo(root: string) {
  const path = join(root, "repo");
  await mkdir(path);
  await exec("git", ["init", "-q", path]);
  await writeFile(join(path, "test"), "one");
  await exec("git", ["-C", path, "add", "."]);
  await exec("git", ["-C", path, "-c", "user.name=lab", "-c", "user.email=lab@test", "commit", "-qm", "one"]);
  return path;
}

test("apiary reservation: shared guard excludes deploy rollback restart artifact fresh/replay and pruning", async () => {
  await world(async root => {
    const held = await seed(root), runtime = join(root, "runtime"), repoRoot = await repo(root);
    const old = "b".repeat(40); await mkdir(join(runtime, old), { recursive: true });
    const hooks = { async buildArtifact(): Promise<never> { assert.fail("build"); }, async restartDaemon() { assert.fail("restart"); } };
    for (const operation of ["deploy", "rollback", "restart", "artifact", "prune"] as const) await assert.rejects(assertRuntimeUpdateAllowed(runtime, operation), DeployReservationHeldError);
    await assert.rejects(deployVersion({ root: runtime, repoRoot, hooks }), DeployReservationHeldError);
    await assert.rejects(rollbackDeploy({ root: runtime, hooks }), DeployReservationHeldError);
    await assert.rejects(pruneRuntimeVersions(runtime, { keep: 1 }), DeployReservationHeldError);
    for (const expectedCurrent of [null, identity.sourceRevision]) {
      await assert.rejects(deployArtifact({ root: runtime, archive: join(root, "nonexistent"), identity, expectedCurrent, admission: { fresh: true }, hooks }), DeployReservationHeldError);
      await assert.rejects(deployArtifact({ root: runtime, archive: join(root, "nonexistent"), identity, expectedCurrent, admission: { reservation: { id: held.id, epoch: held.epoch, active: true, recoverySubjectDigest: held.transactionDigest }, recovery: parseRecoveryPlan(JSON.parse(await readFile(new URL("../contracts/release/v1/fixtures/recovery-plan.json", import.meta.url), "utf8"))) }, hooks }), DeployReservationHeldError);
    }
    assert.equal(existsSync(join(runtime, old)), true);
    const db = new DatabaseSync(join(root, "v2", "core.sqlite3")); db.prepare("UPDATE meta SET value=? WHERE key='coordinated_update'").run(JSON.stringify({ ...held, active: false, resolution: { kind: "released", receiptDigest: hash("f") } })); db.close();
    await assertRuntimeUpdateAllowed(runtime);
  });
});

async function releasedRpc(root: string) {
  const fixture = join(root, "fixture"), out = join(fixture, "dist", "v2", "fixture.mjs");
  await mkdir(join(fixture, "dist", "v2"), { recursive: true });
  await cp(resolve("contracts"), join(fixture, "contracts"), { recursive: true });
  const buildIdentity = { schemaVersion: 1, component: identity.component, version: identity.version, packageVersion: identity.version, sourceRevision: identity.sourceRevision, dirty: false, release: true, target: identity.target };
  await writeFile(join(fixture, "dist", "build-identity.json"), JSON.stringify(buildIdentity));
  await build({ stdin: { contents: `export { runV2Cli } from ${JSON.stringify(resolve("v2/cli/src/main.ts"))}; export { HiveDaemon } from ${JSON.stringify(resolve("v2/daemon/src/daemon.ts"))}; export { RpcServer } from ${JSON.stringify(resolve("v2/daemon/src/rpc.ts"))}; export { RpcClient } from ${JSON.stringify(resolve("v2/cli/src/client.ts"))}; export { openCoreStore } from ${JSON.stringify(resolve("v2/core/src/index.ts"))}; export { BUILD_IDENTITY, DAEMON_CAPABILITIES } from ${JSON.stringify(resolve("v2/daemon/src/protocol.ts"))};`, resolveDir: process.cwd(), loader: "ts" }, bundle: true, platform: "node", format: "esm", outfile: out, banner: { js: 'import { createRequire as fixtureCreateRequire } from "node:module"; const require = fixtureCreateRequire(import.meta.url);' }, external: ["node-pty"], alias: { "jsonc-parser": resolve("node_modules/jsonc-parser/lib/esm/main.js") }, logLevel: "silent" });
  const api = await import(pathToFileURL(out).href);
  assert.equal(api.BUILD_IDENTITY.release, true);
  await mkdir(join(root, "runtime", identity.sourceRevision, "dist"), { recursive: true });
  await mkdir(join(root, "v2"), { recursive: true });
  await writeFile(join(root, "runtime", identity.sourceRevision, "dist", "build-identity.json"), JSON.stringify(buildIdentity));
  await writeFile(join(root, "runtime", identity.sourceRevision, ".honeybee-deployment.json"), JSON.stringify({ schemaVersion: 1, runtime: "v2", recoveryContract: UPDATE_RECOVERY_CONTRACT, identity }));
  await symlink(identity.sourceRevision, join(root, "runtime", "current"));
  let store = api.openCoreStore(join(root, "v2", "core.sqlite3"), { ephemeral: true });
  const daemon = Object.create(api.HiveDaemon.prototype);
  daemon.cfg = { dataDir: join(root, "v2"), storePath: join(root, "v2", "core.sqlite3") };
  daemon.store = store;
  daemon.stopping = false;
  const socket = join(root, "v2", "hived.sock");
  const calls: string[] = [];
  let onAcquire: (() => void) | undefined;
  const newServer = () => new api.RpcServer({ socketPath: socket, log() {}, dispatch: (verb: string, params: Record<string, unknown>, conn: unknown) => { calls.push(verb); if (verb === "update.apiarySwap.acquire") onAcquire?.(); return daemon.dispatch(verb, params, conn); } });
  let server = newServer();
  await server.listen();
  let client = await api.RpcClient.connect(socket);
  const statusCli = `void (async () => { const {RpcClient} = await import(${JSON.stringify(pathToFileURL(out).href)}); const client = await RpcClient.connect(${JSON.stringify(socket)}); try { console.log(JSON.stringify(await client.request("update.status"))); } finally { client.close(); } })().catch(error => { console.error(error.message); process.exitCode = 1; });`;
  await mkdir(join(root, "runtime", identity.sourceRevision, "dist", "v2"));
  await writeFile(join(root, "runtime", identity.sourceRevision, "dist", "v2", "cli.js"), statusCli);
  return { get client() { return client; }, calls, daemon, api, socket, statusCli,
    async restart() {
      client.close(); await server.close(); store.close();
      store = api.openCoreStore(join(root, "v2", "core.sqlite3"), { ephemeral: true }); daemon.store = store;
      server = newServer(); await server.listen(); client = await api.RpcClient.connect(socket);
    },
    nextAcquire() { return new Promise<void>(resolveSeen => { onAcquire = resolveSeen; }); },
    reopen() { store.close(); store = api.openCoreStore(join(root, "v2", "core.sqlite3"), { ephemeral: true }); daemon.store = store; },
    async close() { client.close(); await server.close(); store.close(); },
  };
}

test("apiary RPC: released identity, acquire/release/abandon/recover lost replies and unchanged identity fencing", async () => {
  await world(async root => {
    const f = await releasedRpc(root);
    try {
      assert.ok(f.api.DAEMON_CAPABILITIES.includes(APIARY_SWAP_CAPABILITY));
      const status = await f.client.request("update.apiarySwap.status");
      assert.equal(status.schemaVersion, 44); assert.equal(status.storageSupported, true); assert.deepEqual(status.installedIdentity, identity);
      const request = acquire(root);
      await f.client.request("update.apiarySwap.acquire", request);
      const held = (await f.client.request("update.apiarySwap.status")).reservation;
      assert.deepEqual(await f.client.request("update.apiarySwap.acquire", request), held);
      await f.restart();
      assert.deepEqual((await f.client.request("update.apiarySwap.status")).reservation, held);
      await assert.rejects(f.client.request("update.reserve", { id: "paired", expectedEpoch: held.epoch, recoverySubjectDigest: hash("f") }), /Corrupt/);
      const lines: string[] = [], errors: string[] = [];
      const io = { out: (line: string) => lines.push(line), err: (line: string) => errors.push(line) };
      assert.equal(await f.api.runV2Cli(["update-owner", "apiary-swap", "status", "--data-dir", join(root, "v2"), "--socket", f.socket], io), 0, errors.join("\n"));
      assert.deepEqual(JSON.parse(lines.pop()!).reservation, held);
      const repoRoot = await repo(root), hooks = { async buildArtifact(): Promise<never> { assert.fail("reserved build"); }, async restartDaemon() { assert.fail("reserved restart"); } };
      await assert.rejects(deployVersion({ root: join(root, "runtime"), repoRoot, hooks }), DeployReservationHeldError);
      await assert.rejects(rollbackDeploy({ root: join(root, "runtime"), hooks }), DeployReservationHeldError);
      assert.equal(await f.api.runV2Cli(["update-owner", "status", "--data-dir", join(root, "v2"), "--socket", f.socket], io), 0);
      assert.deepEqual(JSON.parse(lines.pop()!).reservation, held);
      const completionFile = join(root, "completion.json");
      await writeFile(completionFile, JSON.stringify(release(held)));
      assert.equal(await f.api.runV2Cli(["update-owner", "apiary-swap", "release", completionFile, "--data-dir", join(root, "v2"), "--socket", f.socket], io), 0, errors.join("\n"));
      const inactive = (await f.client.request("update.apiarySwap.status")).reservation;
      assert.equal(inactive.active, false);
      assert.deepEqual(await f.client.request("update.apiarySwap.release", release(held)), inactive);
      const second = await f.client.request("update.apiarySwap.acquire", { ...request, id: "second", expectedEpoch: inactive.epoch });
      const cancellation = { ...token(second), cancellationReceipt: { ...token(second), version: 1, journalDigest: hash("e"), outcome: "abandoned", phase: "acquired", policy: "unchanged" } };
      await f.client.request("update.apiarySwap.abandon", cancellation);
      assert.equal((await f.client.request("update.apiarySwap.status")).reservation.active, false);
      assert.equal((await f.client.request("update.apiarySwap.abandon", cancellation)).active, false);
      const third = await f.client.request("update.apiarySwap.acquire", { ...request, id: "third", expectedEpoch: second.epoch });
      const recovery = { purpose: third.purpose, id: third.id, expectedEpoch: third.epoch, transactionDigest: third.transactionDigest, expectedHoneybeeIdentity: third.expectedHoneybeeIdentity, recoveryId: "rpc-recovery", recoveryReceipt: { ...token(third), version: 1, journalDigest: hash("e"), outcome: "recovered", policy: "restored", coordinator: "fenced", generations: "reconciled" } };
      await f.client.request("update.apiarySwap.recover", recovery);
      const tombstone = (await f.client.request("update.apiarySwap.status")).reservation;
      assert.equal(tombstone.epoch, third.epoch + 1); assert.equal(tombstone.active, false);
      assert.deepEqual(await f.client.request("update.apiarySwap.recover", recovery), tombstone);
      await assert.rejects(f.client.request("update.apiarySwap.release", release(third)), /mismatch/);
      await assert.rejects(f.client.request("update.apiarySwap.acquire", { ...request, expectedEpoch: tombstone.epoch, transactionDigest: hash("f") }), /digest/);
      const wrongScope = { ...request.transaction, scope: { ...request.transaction.scope, node: "wrong-node" } };
      await assert.rejects(f.client.request("update.apiarySwap.acquire", { ...request, expectedEpoch: tombstone.epoch, transaction: wrongScope, transactionDigest: canonicalDigest(wrongScope) }), /scope/);
      f.daemon.cfg.storePath = join(root, "v2", "custom.sqlite3");
      await assert.rejects(f.client.request("update.apiarySwap.acquire", { ...request, expectedEpoch: tombstone.epoch }), /unsupported storage/);
      f.daemon.cfg.storePath = join(root, "v2", "core.sqlite3");
      await writeFile(join(root, "runtime", identity.sourceRevision, "dist", "build-identity.json"), JSON.stringify({ ...f.api.BUILD_IDENTITY, version: "wrong" }));
      await assert.rejects(f.client.request("update.apiarySwap.acquire", { ...request, expectedEpoch: tombstone.epoch }), /identity differs/);
    } finally { await f.close(); }
  });
});

const gateBase = resolve("..", "base");
test("apiary compatibility: unmodified 0507721a deploy refuses a format-2 reservation", { skip: !existsSync(join(gateBase, "src", "deployRuntime.ts")) ? "requires masked gate base 0507721a export" : false }, async () => {
  const config = JSON.parse(await readFile(resolve("..", "config.json"), "utf8"));
  assert.equal(config.shas.base, "0507721a5f3f80a83c18d51144eca4cb04210171");
  await world(async root => {
    await seed(root);
    const fixture = join(root, "fixture"), out = join(fixture, "dist", "v2", "old-deploy.mjs");
    await cp(resolve("contracts"), join(fixture, "contracts"), { recursive: true });
    await build({ entryPoints: [join(gateBase, "src", "deployRuntime.ts")], bundle: true, platform: "node", format: "esm", outfile: out, banner: { js: 'import { createRequire as fixtureCreateRequire } from "node:module"; const require = fixtureCreateRequire(import.meta.url);' }, logLevel: "silent" });
    const old = await import(pathToFileURL(out).href), runtime = join(root, "runtime"), repoRoot = await repo(root);
    await assert.rejects(old.deployVersion({ root: runtime, repoRoot, hooks: { buildArtifact() { assert.fail("old build"); }, restartDaemon() { assert.fail("old restart"); } } }), /Corrupt coordinated update reservation/);
    assert.equal(existsSync(join(runtime, "current")), false);
  });
});

test("apiary schema: current 44 remains unchanged and newer storage refuses", async () => {
  await world(async root => {
    await seed(root);
    const db = new DatabaseSync(join(root, "v2", "core.sqlite3"));
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value, "44");
    db.exec("UPDATE meta SET value='999' WHERE key='schema_version'"); db.close();
    assert.throws(() => openCoreStore(join(root, "v2", "core.sqlite3"), { ephemeral: true }), /newer store/);
  });
});

for (const operation of ["deploy", "rollback"] as const) {
  test(`apiary race: ${operation} holds deploy lock through effects before queued acquire checks identity`, async () => {
    await world(async root => {
      const f = await releasedRpc(root), runtime = join(root, "runtime"), repoRoot = await repo(root);
      let acquisition: Promise<unknown> | undefined;
      const queueAcquire = async () => {
        const seen = f.nextAcquire();
        const pending: Promise<unknown> = f.client.request("update.apiarySwap.acquire", acquire(root));
        acquisition = pending;
        void pending.catch(() => {});
        await seen;
      };
      try {
        if (operation === "deploy") {
          await deployVersion({ root: runtime, repoRoot, allowNonDescendant: true, hooks: {
            async buildArtifact({ workDir }) {
              await queueAcquire();
              const artifactDir = join(workDir, "stage"); await mkdir(join(artifactDir, "dist", "v2"), { recursive: true });
              await writeFile(join(artifactDir, "dist", "v2", "cli.js"), f.statusCli);
              await writeFile(join(artifactDir, "dist", "cli.js"), "console.log('lab');");
              await writeFile(join(artifactDir, "package.json"), '{"name":"honeybee","version":"0.0.1"}');
              return { artifactDir };
            }, async restartDaemon() {},
          } });
        } else {
          const previous = "b".repeat(40);
          await mkdir(join(runtime, previous, "dist"), { recursive: true });
          await writeFile(join(runtime, previous, "dist", "cli.js"), "console.log('previous');");
          await writeFile(join(runtime, "deploys.json"), JSON.stringify({ schemaVersion: 1, entries: [{ sha: previous, at: "2026-01-01T00:00:00Z", artifactHash: hash("b"), by: "lab" }, { sha: identity.sourceRevision, at: "2026-01-02T00:00:00Z", artifactHash: hash("a"), by: "lab" }] }));
          await rollbackDeploy({ root: runtime, hooks: { async restartDaemon() { await queueAcquire(); } } });
          assert.equal(await readlink(join(runtime, "current")), previous);
        }
        assert.ok(acquisition);
        await assert.rejects(acquisition, /identity differs/);
        assert.equal((await f.client.request("update.apiarySwap.status")).reservation.epoch, 0);
      } finally { await f.close(); }
    });
  });
}
