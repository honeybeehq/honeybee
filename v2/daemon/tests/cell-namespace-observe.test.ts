import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore } from "../../core/src/index.ts";
import { HiveDaemon } from "../src/daemon.ts";

test("Cell runtime readiness records the namespace fail-closed when the Cell row cannot be resolved", {skip: process.platform !== "linux"}, () => {
  const dir = mkdtempSync(join(tmpdir(), "cell-namespace-"));
  const store = openCoreStore(join(dir, "core.sqlite3"), { ephemeral: true });
  try {
    const fixture = (cellSandbox: boolean | null) => {
      const logs: string[] = [];
      const owner = Object.create(HiveDaemon.prototype) as Record<string, unknown>;
      Object.assign(owner, { store, cfg: { nodeKind: "satellite", cellSandbox }, cellNamespaces: new Map(), confinementReasons: new Set(), log: (line: string) => logs.push(line) });
      const observe = (beeId: string) => (owner.observeCellRuntimeNamespace as (beeId: string, pid: number | null) => void).call(owner, beeId, process.pid);
      return { observe, logs, namespaces: owner.cellNamespaces as Map<string, string>, reasons: owner.confinementReasons as Set<string> };
    };
    const cell = (name: string, sandbox: boolean | null) => {
      const bee = store.createBee({ name, agent: "stub", substrate: "cell", cwd: dir }).bee;
      store.putCell({ id: `cell-${name}`, sourceBeeId: bee.id, originRepo: dir, sha: "a".repeat(40), wrapper: "wrap", spaceName: `wrap--repo--${name}`, spaceDir: join(dir, name), gitCommonDirRealpath: dir, objectFormat: "sha1", sandbox });
      return bee.id;
    };
    const missing = store.createBee({ name: "missing", agent: "stub", substrate: "cell", cwd: dir }).bee.id;
    const removed = cell("removed", true);
    store.markCellRemoved("cell-removed");
    for (const beeId of [missing, removed]) {
      const f = fixture(false);
      assert.doesNotThrow(() => f.observe(beeId));
      assert.equal(f.namespaces.has(beeId), true);
      assert.equal(f.reasons.has("cell_userns_unisolated"), true);
      assert.ok(f.logs.includes("security.confinement cell_sandbox_unresolved assumed=sandboxed"));
    }
    const open = cell("open", false), sandboxed = cell("sandboxed", true), inherited = cell("inherited", null);
    const f = fixture(false);
    f.observe(open);
    f.observe(inherited);
    assert.equal(f.namespaces.size, 0);
    assert.equal(f.reasons.size, 0);
    f.observe(sandboxed);
    assert.equal(f.namespaces.has(sandboxed), true);
    assert.equal(f.reasons.has("cell_userns_unisolated"), true);
    assert.equal(f.logs.some(line => line.includes("cell_sandbox_unresolved")), false);
    const node = fixture(null);
    node.observe(inherited);
    assert.equal(node.namespaces.has(inherited), true);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a Cell bee with no resolvable Cell row still spawns and adopts through the real HSR readiness callback", {skip: process.platform !== "linux", timeout: 60_000}, async () => {
  const { HsrDriver } = await import("../../driver-hsr/src/index.ts");
  const { stubAdapter } = await import("../../adapters/src/index.ts");
  const { fixtureRuntimeIdentity, persistFixtureProcess, AGENT_PATH, drainUntil } = await import("../../driver-hsr/tests/helpers.ts");
  const dir = mkdtempSync(join(tmpdir(), "cell-namespace-hsr-"));
  const store = openCoreStore(join(dir, "core.sqlite3"), { ephemeral: true });
  const beeId = store.createBee({ name: "rowless", agent: "stub", substrate: "cell", cwd: dir }).bee.id;
  const owner = Object.create(HiveDaemon.prototype) as Record<string, unknown>;
  const logs: string[] = [];
  Object.assign(owner, { store, cfg: { nodeKind: "satellite", cellSandbox: null }, cellNamespaces: new Map(), confinementReasons: new Set(), log: (line: string) => logs.push(line) });
  const namespaces = owner.cellNamespaces as Map<string, string>;
  const onRuntimeReady = (id: string, pid: number | null) => (owner.observeCellRuntimeNamespace as (beeId: string, pid: number | null) => void).call(owner, id, pid);
  const adapter = { ...stubAdapter, readyAtSpawn: true, parseLine: () => [] };
  const driver = () => new HsrDriver({ onRuntimeReady, runtimeIdentity: fixtureRuntimeIdentity(dir), sessionLogDir: join(dir, "logs"), stopKillGraceMs: 400, resolve: () => ({ adapter, command: process.execPath, args: [AGENT_PATH], cwd: dir, env: { ...process.env, STUB_TURN_MS: "5" } }) });
  const first = driver();
  let second: InstanceType<typeof HsrDriver> | undefined;
  try {
    first.start(beeId, 1);
    await drainUntil(first, events => events.some(event => event.kind === "booted"));
    assert.equal(namespaces.has(beeId), true);
    const runtime = first.procOf(beeId, 1)!;
    persistFixtureProcess(dir, beeId, 1, runtime);
    first.detachAll();
    namespaces.clear();
    second = driver();
    assert.equal(second.adopt(beeId, 1, runtime.pid, runtime.pidStartedAt, "idle", 0), true);
    assert.equal(namespaces.has(beeId), true);
    assert.equal((owner.confinementReasons as Set<string>).has("cell_userns_unisolated"), true);
    assert.ok(logs.includes("security.confinement cell_sandbox_unresolved assumed=sandboxed"));
  } finally { second?.disposeAll(); first.disposeAll(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("Cell runtime readiness racing daemon stop never touches the store and never throws", {skip: process.platform !== "linux"}, () => {
  const dir = mkdtempSync(join(tmpdir(), "cell-namespace-stop-"));
  const store = openCoreStore(join(dir, "core.sqlite3"), { ephemeral: true });
  try {
    const beeId = store.createBee({ name: "stopping", agent: "stub", substrate: "cell", cwd: dir }).bee.id;
    let reads = 0;
    const counted = new Proxy(store, { get: (target, key, receiver) => { reads++; return Reflect.get(target, key, receiver); } });
    for (const state of [{ store: counted, stopping: true }, { store: null, stopping: false }, { store: null, stopping: true }]) {
      const owner = Object.create(HiveDaemon.prototype) as Record<string, unknown>;
      Object.assign(owner, { ...state, cfg: { nodeKind: "satellite", cellSandbox: null }, cellNamespaces: new Map(), confinementReasons: new Set(), log: () => {} });
      assert.doesNotThrow(() => (owner.observeCellRuntimeNamespace as (beeId: string, pid: number | null) => void).call(owner, beeId, process.pid));
      assert.equal((owner.cellNamespaces as Map<string, string>).size, 0);
    }
    assert.equal(reads, 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("runtime readiness fired during daemon stop through the real HSR driver leaves the process exiting 0", {skip: process.platform !== "linux", timeout: 60_000}, async () => {
  const { spawnSync } = await import("node:child_process");
  const { writeFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const dir = mkdtempSync(join(tmpdir(), "cell-namespace-stop-hsr-"));
  const at = (path: string) => JSON.stringify(fileURLToPath(new URL(path, import.meta.url)));
  const script = join(dir, "stop-race.mts");
  writeFileSync(script, `import { HiveDaemon } from ${at("../src/daemon.ts")};
import { HsrDriver } from ${at("../../driver-hsr/src/index.ts")};
import { stubAdapter } from ${at("../../adapters/src/index.ts")};
import { fixtureRuntimeIdentity, persistFixtureProcess, AGENT_PATH, drainUntil } from ${at("../../driver-hsr/tests/helpers.ts")};
const dir = ${JSON.stringify(dir)};
let storeReads = 0;
const store = new Proxy({}, { get: () => { storeReads++; throw new Error("store accessed during stop"); } });
const owner = Object.create(HiveDaemon.prototype);
Object.assign(owner, { store, stopping: true, cfg: { nodeKind: "satellite", cellSandbox: null }, cellNamespaces: new Map(), confinementReasons: new Set(), log: () => {} });
let readies = 0;
const onRuntimeReady = (id, pid) => { readies++; owner.observeCellRuntimeNamespace(id, pid); };
const adapter = { ...stubAdapter, readyAtSpawn: true, parseLine: () => [] };
const driver = () => new HsrDriver({ onRuntimeReady, runtimeIdentity: fixtureRuntimeIdentity(dir), sessionLogDir: dir + "/logs", stopKillGraceMs: 400, resolve: () => ({ adapter, command: process.execPath, args: [AGENT_PATH], cwd: dir, env: { ...process.env, STUB_TURN_MS: "5" } }) });
const first = driver();
first.start("stopping-cell", 1);
await drainUntil(first, events => events.some(event => event.kind === "booted"));
const runtime = first.procOf("stopping-cell", 1);
persistFixtureProcess(dir, "stopping-cell", 1, runtime);
first.detachAll();
const second = driver();
if (!second.adopt("stopping-cell", 1, runtime.pid, runtime.pidStartedAt, "idle", 0)) throw new Error("adopt failed");
second.disposeAll(); first.disposeAll();
console.log(JSON.stringify({ readies, storeReads, namespaces: owner.cellNamespaces.size }));
`);
  try {
    const child = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 45_000 });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim().split("\n").at(-1)!);
    assert.ok(result.readies >= 2);
    assert.equal(result.storeReads, 0);
    assert.equal(result.namespaces, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
