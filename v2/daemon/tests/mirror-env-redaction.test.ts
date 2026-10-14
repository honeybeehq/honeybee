import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { openCoreStore, SCHEMA_VERSION } from "../../core/src/index.ts";
import type { RenameResult, SnapshotResult, SpawnResult, ViewResult, WatchFrame } from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const TOKEN = "fake-h18b-token-DEADBEEF";
const DSN = "postgres://fake-h18b-user:fake-h18b-pass@db.invalid/app";
const REDACTED = "<redacted>";
const RAW_ENV = { APIARY_AGENT_TOKEN: TOKEN, DATABASE_URL: DSN, CODEX_HOME: "/tmp/h18b-codex", GROK_HOME: "/tmp/h18b-grok" };
const MIRROR_ENV = { APIARY_AGENT_TOKEN: REDACTED, DATABASE_URL: REDACTED, CODEX_HOME: "/tmp/h18b-codex", GROK_HOME: "/tmp/h18b-grok" };

test("mirror-env.int.1: snapshot and watch rows carry redacted bee env while the store keeps it raw", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const worker = await daemon.client();
    const first = await worker.request<SpawnResult>("spawn", { name: "first", agent: "stub", cwd: "/tmp", env: RAW_ENV });

    const watcher = await daemon.client();
    const frames: WatchFrame[] = [];
    watcher.onEvent = (frame: WatchFrame) => { frames.push(frame); };
    const watched = await watcher.request<SnapshotResult>("watch");
    assert.deepEqual(watched.views.find((row) => row.view.beeId === first.beeId)?.bee?.env, MIRROR_ENV);
    assert.equal(JSON.stringify(watched).includes(TOKEN), false);
    assert.equal(JSON.stringify(watched).includes(DSN), false);

    const second = await worker.request<SpawnResult>("spawn", { name: "second", agent: "stub", cwd: "/tmp", env: RAW_ENV });
    const created = await waitFor(() => {
      for (const frame of frames) {
        if (frame.type !== "delta") continue;
        const event = frame.events.find((row) => row.kind === "bee.created" && row.beeId === second.beeId);
        if (event) return event;
      }
      return null;
    }, "bee.created delta");
    assert.deepEqual((created.payload.bee as { env: unknown }).env, MIRROR_ENV);
    assert.equal((created.payload.bee as { name: unknown }).name, "second");

    const snapshot = await worker.request<SnapshotResult>("snapshot");
    assert.equal(snapshot.views.length, 2);
    for (const row of snapshot.views) assert.deepEqual(row.bee?.env, MIRROR_ENV);
    assert.equal(JSON.stringify(snapshot).includes(TOKEN), false);
    assert.equal(JSON.stringify(frames).includes(TOKEN), false);
    assert.equal(JSON.stringify(frames).includes(DSN), false);

    const view = await worker.request<ViewResult>("view", { beeId: second.beeId, revealEnv: true });
    assert.deepEqual(view.bee?.env, RAW_ENV);

    watcher.close();
    worker.close();
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("mirror-env.int.2: a store seeded with a raw idempotency row is migrated at daemon start and replays redacted", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    const storePath = join(dir, "core.sqlite3");
    const store = openCoreStore(storePath, { ephemeral: true });
    const { bee } = store.createBee({ name: "seeded", agent: "stub", substrate: "hsr", cwd: "/tmp", env: RAW_ENV });
    store.close();
    const stored = { bee, applied: true };
    const seed = new DatabaseSync(storePath);
    seed.prepare("INSERT INTO rpc_idempotency(key, verb, command_id, result, created_at) VALUES(?, ?, ?, ?, ?)").run("k-seeded", "bee.rename", null, JSON.stringify(stored), 5);
    seed.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(39));
    seed.close();

    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const replay = await client.request<RenameResult>("bee.rename", { beeId: bee.id, name: "other", idempotencyKey: "k-seeded" });
    assert.equal(replay.deduped, true);
    assert.equal(replay.applied, true);
    assert.equal(replay.bee.name, "seeded");
    assert.deepEqual(replay.bee.env, { ...RAW_ENV, APIARY_AGENT_TOKEN: REDACTED });
    assert.deepEqual(Object.keys(replay).sort(), ["applied", "bee", "deduped"]);
    assert.deepEqual(Object.keys(replay.bee).sort(), Object.keys(bee).sort());
    client.close();
    await daemon.stop();
    daemon = null;

    const check = new DatabaseSync(storePath, { readOnly: true });
    const row = check.prepare("SELECT key, verb, command_id, result, created_at FROM rpc_idempotency WHERE key = 'k-seeded'").get() as { verb: string; command_id: number | null; result: string; created_at: number };
    const version = check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
    check.close();
    assert.equal(row.verb, "bee.rename");
    assert.equal(row.command_id, null);
    assert.equal(row.created_at, 5);
    assert.equal(row.result.includes(TOKEN), false);
    assert.equal(version.value, String(SCHEMA_VERSION));

    const log = readFileSync(join(dir, "hived.log"), "utf8");
    const receipts = log.split("\n").filter((line) => line.includes("store.migration.rpc_idempotency_env"));
    assert.equal(receipts.length, 1);
    assert.match(JSON.parse(receipts[0]!).op, /^store\.migration\.rpc_idempotency_env seen=1 redacted=1 skipped_unparseable=0 skipped_unrecognised=0 complete=true ms=\d+$/);
    assert.equal(log.includes(TOKEN), false);

    daemon = await startDaemon(dir);
    await daemon.stop();
    daemon = null;
    const again = readFileSync(join(dir, "hived.log"), "utf8");
    assert.equal(again.split("\n").filter((line) => line.includes("store.migration.rpc_idempotency_env")).length, 1);
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});
