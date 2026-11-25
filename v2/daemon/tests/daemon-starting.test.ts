import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { inspectProcess, verifyProcessIdentity, type ProcessIdentity } from "../../driver-hsr/src/psutil.ts";
import { RpcClient } from "../../cli/src/client.ts";
import { SCHEMA_VERSION } from "../../core/src/schema.ts";
import { makeDaemonDir, waitFor } from "./helpers.ts";
import type { HealthResponse, SendRpcResult, SpawnResult, StartingHealthResult, ViewResult } from "../src/protocol.ts";

const fixture = fileURLToPath(new URL("./fixtures/starting-daemon.mjs", import.meta.url));

function identity(pid: number): ProcessIdentity {
  const value = inspectProcess(pid);
  if (value.kind !== "present") throw new Error(`process ${pid} has no birth identity`);
  return { pid, birth: value.birth, bootId: value.bootId };
}
const alive = (p: ProcessIdentity) => verifyProcessIdentity(p.pid, p);

function stampPreviousSchema(storePath: string): void {
  const db = new DatabaseSync(storePath);
  try {
    db.exec("ALTER TABLE flags DROP COLUMN error");
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION - 1));
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally { db.close(); }
}

const messageLines = (logPath: string, messageId: number) => readFileSync(logPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as { type?: string; id?: number }).filter(entry => entry.type === "message" && entry.id === messageId);

test("first start after a schema bump answers health while it backs up, refuses the rest, and keeps two live sessions", { timeout: 180_000 }, async () => {
  const rig = makeDaemonDir();
  const home = join(rig.dir, "throwaway-home");
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), HIVE_GATEWAYS_DISABLE: "1", HIVE_NO_KEYCHAIN: "1", HIVE_TEST_REAP_RUNTIMES_ON_SHUTDOWN: "0" };
  for (const path of [home, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME]) mkdirSync(path, { recursive: true });
  const children: ChildProcess[] = [];
  const runners: ProcessIdentity[] = [];
  let client: RpcClient | null = null;
  const socketPath = join(rig.dir, "hived.sock");
  const launch = (mode: "natural" | "gated") => {
    const child = spawn(process.execPath, [fixture, rig.dir, mode], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout!.on("data", chunk => output += chunk);
    child.stderr!.on("data", chunk => output += chunk);
    children.push(child);
    return { child, output: () => output };
  };
  const connect = (what: string, timeoutMs = 15_000, acceptStarting = false) => waitFor(async () => {
    try {
      const candidate = await RpcClient.connect(socketPath);
      if (acceptStarting || candidate.boot === null) return candidate;
      candidate.close();
      return null;
    } catch { return null; }
  }, what, timeoutMs);
  const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;
  try {
    const first = launch("natural");
    client = await connect("first daemon socket");
    const bees: string[] = [];
    for (const name of ["survivor-a", "survivor-b"]) {
      const spawned = await client.request<SpawnResult>("spawn", { name, agent: "stub", substrate: "hsr", cwd: rig.dir });
      bees.push(spawned.beeId);
      await waitFor(async () => (await client!.request<ViewResult>("view", { beeId: spawned.beeId })).view.runtimeState === "idle", `${name} idle`, 20_000);
    }
    const [beeA, beeB] = bees as [string, string];
    for (const file of readdirSync(join(rig.dir, "runners")).filter(file => file.endsWith(".status.json"))) {
      const row = JSON.parse(readFileSync(join(rig.dir, "runners", file), "utf8"));
      runners.push(identity(row.hostPid), identity(row.agentPid));
    }
    assert.equal(runners.length, 4);
    const turnRelease = join(rig.dir, "turn.release");
    const inFlight = await client.request<SendRpcResult>("send", { beeId: beeA, body: `across the upgrade @wait-file:${turnRelease}` });
    await waitFor(async () => (await client!.request<ViewResult>("view", { beeId: beeA })).view.runtimeState === "running", "bee A mid-turn", 15_000);
    client.close(); client = null;
    first.child.kill("SIGTERM");
    await waitFor(() => exited(first.child), `first daemon exits: ${first.output()}`, 10_000);
    assert.ok(runners.every(alive), "runners survive the old daemon");

    stampPreviousSchema(join(rig.dir, "core.sqlite3"));

    const backups = join(rig.dir, "core.sqlite3.backups");
    const killed = launch("gated");
    await waitFor(() => existsSync(join(rig.dir, "upgrade.held")), `killed successor reaches the backup: ${killed.output()}`, 30_000);
    killed.child.kill("SIGKILL");
    await waitFor(() => exited(killed.child), "killed successor exits", 10_000);
    rmSync(join(rig.dir, "upgrade.held"));
    const orphans = readdirSync(backups).filter(name => name.endsWith(".partial"));
    assert.equal(orphans.length, 1, "a daemon killed mid-backup leaves its partial copy");
    const orphanBytes = statSync(join(backups, orphans[0]!)).size;
    assert.ok(orphanBytes > 0);
    assert.ok(runners.every(alive), "runners survive a killed start");

    const aborted = launch("gated");
    await waitFor(() => existsSync(join(rig.dir, "upgrade.held")), `aborted successor reaches the backup: ${aborted.output()}`, 30_000);
    aborted.child.kill("SIGTERM");
    await waitFor(() => exited(aborted.child), `aborted successor exits: ${aborted.output()}`, 10_000);
    assert.equal(aborted.child.exitCode, 0);
    assert.equal(existsSync(socketPath), false, "an aborted start removes its socket");
    assert.deepEqual(readdirSync(backups), [], "the next start removed the killed run's partial and the aborted run discarded its own; nothing else was there");
    assert.match(readFileSync(join(rig.dir, "hived.log"), "utf8"), new RegExp(`store\\.backup\\.partial_removed name=${orphans[0]!.replaceAll(".", "\\.")} bytes=${orphanBytes}`));
    assert.ok(runners.every(alive), "runners survive an aborted start");
    rmSync(join(rig.dir, "upgrade.held"));

    const successor = launch("gated");
    client = await connect(`successor socket during the backup: ${successor.output()}`, 30_000, true);
    await waitFor(() => existsSync(join(rig.dir, "upgrade.held")), "successor holds the backup", 30_000);
    client.close();
    client = await connect("successor socket while held", 10_000, true);
    assert.equal(client.boot?.state, "starting", "the hello says the daemon is starting");
    assert.equal(client.boot?.phase, "store_backup_verify");
    const health = await client.request<HealthResponse>("health");
    assert.equal(health.boot?.state, "starting");
    const starting = health as StartingHealthResult;
    assert.equal(starting.boot.phase, "store_backup_verify");
    assert.equal(starting.boot.schemaFrom, SCHEMA_VERSION - 1);
    assert.equal(starting.boot.schemaTo, SCHEMA_VERSION);
    assert.equal(starting.boot.progress, null);
    assert.equal(typeof starting.pid, "number");
    assert.equal(typeof starting.boot.phaseStartedAt, "number");
    assert.ok("etaMs" in starting.boot);
    for (const [verb, params] of [["send", { beeId: beeB, body: "too early" }], ["list", {}], ["view", { beeId: beeA }], ["watch", {}]] as const) {
      await assert.rejects(client.request(verb, params), (error: { code?: string; message?: string; details?: { boot?: { state?: string; phase?: string } } }) => {
        assert.equal(error.code, "daemon_starting", `${verb} is refused while starting`);
        assert.equal(error.details?.boot?.state, "starting");
        assert.equal(error.details?.boot?.phase, "store_backup_verify");
        assert.match(error.message ?? "", /verifying the store backup before the schema \d+→\d+ upgrade/);
        return true;
      });
    }
    writeFileSync(turnRelease, "go");
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.ok(runners.every(alive), "runners stay alive while the daemon is starting");
    writeFileSync(join(rig.dir, "upgrade.release"), "go");
    await waitFor(() => existsSync(join(rig.dir, "daemon.ready")), `successor ready: ${successor.output()}`, 60_000);
    const ready = await client.request<HealthResponse>("health");
    assert.equal(ready.boot?.state, "ready");
    assert.deepEqual(readdirSync(backups).map(name => name.replace(/^.*\./, "")).sort(), ["json", "sqlite3"], "after the next start the backups folder holds exactly one completed backup");
    const receipts = readdirSync(backups).filter(name => name.endsWith(".json")).map(name => JSON.parse(readFileSync(join(backups, name), "utf8")) as { schemaVersion: number; integrityCheck: string; sha256: string });
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!.schemaVersion, SCHEMA_VERSION - 1);
    assert.equal(receipts[0]!.integrityCheck, "ok");
    assert.match(receipts[0]!.sha256, /^[0-9a-f]{64}$/);

    for (const beeId of bees) {
      await waitFor(async () => (await client!.request<ViewResult>("view", { beeId })).view.runtimeState === "idle", "successor re-adopts the same runtime", 20_000);
      assert.equal((await client.request<ViewResult>("view", { beeId })).view.generation, 1);
    }
    assert.ok(runners.every(alive), "the successor keeps the exact original processes");
    const logA = join(rig.dir, "session-logs", `${beeA}.jsonl`);
    await waitFor(() => readFileSync(logA, "utf8").includes("echo:across the upgrade"), "the turn finished during the upgrade reaches the transcript", 15_000);
    assert.equal(messageLines(logA, inFlight.messageId).length, 1, "the in-flight message was delivered exactly once");
    const after = await client.request<SendRpcResult>("send", { beeId: beeB, body: "after the upgrade" });
    const logB = join(rig.dir, "session-logs", `${beeB}.jsonl`);
    await waitFor(() => readFileSync(logB, "utf8").includes("echo:after the upgrade"), "bee B works new mail on the same runtime", 15_000);
    assert.equal(messageLines(logB, after.messageId).length, 1);
    assert.equal((await client.request<ViewResult>("view", { beeId: beeB })).view.generation, 1);

    for (const beeId of bees) await client.request("stop", { beeId });
    await waitFor(() => runners.every(row => !alive(row)), "owned fixture processes stopped", 15_000);
    client.close(); client = null;
    successor.child.kill("SIGTERM");
    await waitFor(() => exited(successor.child), "successor exits", 10_000);
  } finally {
    client?.close();
    for (const child of children) if (!exited(child)) child.kill("SIGKILL");
    for (const row of runners) if (alive(row)) { try { process.kill(row.pid, "SIGKILL"); } catch {} }
    rig.cleanup();
  }
});

test("a long migration written as batches keeps health answering store_migrate the whole time, with bounded latency", { timeout: 120_000 }, async () => {
  const rig = makeDaemonDir();
  const home = join(rig.dir, "throwaway-home");
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), HIVE_GATEWAYS_DISABLE: "1", HIVE_NO_KEYCHAIN: "1", HIVE_TEST_REAP_RUNTIMES_ON_SHUTDOWN: "0", HON47_MIGRATE_HOLD_MS: "3000" };
  for (const path of [home, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME]) mkdirSync(path, { recursive: true });
  const socketPath = join(rig.dir, "hived.sock");
  const children: ChildProcess[] = [];
  const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;
  const launch = (mode: "natural" | "migrate-held") => {
    const child = spawn(process.execPath, [fixture, rig.dir, mode], { env, stdio: ["ignore", "ignore", "ignore"] });
    children.push(child);
    return child;
  };
  let client: RpcClient | null = null;
  try {
    const first = launch("natural");
    client = await waitFor(async () => { try { const c = await RpcClient.connect(socketPath); if (c.boot === null) return c; c.close(); } catch {} return null; }, "first daemon ready", 30_000);
    client.close(); client = null;
    first.kill("SIGTERM");
    await waitFor(() => exited(first), "first daemon exits", 10_000);
    stampPreviousSchema(join(rig.dir, "core.sqlite3"));

    launch("migrate-held");
    client = await waitFor(async () => { try { return await RpcClient.connect(socketPath); } catch { return null; } }, "held daemon socket", 30_000);
    const answers: Array<{ phase: string; ms: number; at: number }> = [];
    for (;;) {
      const started = performance.now();
      const health = await client.request<HealthResponse>("health", {}, 3000);
      const phase = health.boot?.state === "starting" ? (health as StartingHealthResult).boot.phase : "ready";
      answers.push({ phase, ms: performance.now() - started, at: Date.now() });
      if (phase === "ready") break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const migrating = answers.filter(answer => answer.phase === "store_migrate");
    assert.ok(migrating.length >= 20, `health answered during the migration: ${JSON.stringify(answers.map(a => a.phase))}`);
    assert.ok(migrating.at(-1)!.at - migrating[0]!.at >= 2_000, "the migrate phase was observed for most of its 3 s hold");
    const slowest = Math.max(...answers.map(answer => answer.ms));
    assert.ok(slowest < 1_000, `health answered within a second throughout the start; slowest ${Math.round(slowest)} ms`);
    assert.equal(answers.at(-1)!.phase, "ready");
  } finally {
    client?.close();
    for (const child of children) if (!exited(child)) child.kill("SIGTERM");
    await waitFor(() => children.every(exited), "fixture daemons exit", 10_000).catch(() => { for (const child of children) if (!exited(child)) child.kill("SIGKILL"); });
    rig.cleanup();
  }
});
