/**
 * H5 Champions in the REAL daemon: the verbs refuse while the flag is off; a
 * champion.put prepares an immutable home; champion.start spawns the
 * incarnation in that home with the Apiary tags and binds it; the bee's
 * direct archive is refused (resident lifecycle); a turn end bundles the home
 * into the object store; a second daemon sharing that store restores the home
 * before its first runtime (executor swap by revive); archive and delete keep
 * the home. Temp dirs and stub agents only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DAEMON_CAPABILITIES, RPC_VERBS, RpcError, type ChampionFenceResult, type ChampionGetResult, type ChampionListResult, type ChampionPutResult, type ChampionStartResult, type SendRpcResult, type SnapshotResult, type TemplatePutResult, type ViewResult } from "../src/protocol.ts";
import type { RpcClient } from "../../cli/src/client.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CELL_AGENT_PATH = join(here, "..", "..", "driver-cell", "test-agent", "agent.mjs");

function makeRig(root: string, champions: Record<string, unknown>, storeDir: string) {
  const { dir, cleanup } = makeDaemonDir({
    bootHangTimeoutMs: 60_000,
    champions,
    transcripts: { segments: { storeDir } },
    agents: {
      cellstub: { command: process.execPath, args: [CELL_AGENT_PATH], adapter: "stub" },
    },
  });
  return { dir, cleanup };
}

async function shIn(client: RpcClient, beeId: string, cmd: string): Promise<void> {
  const before = (await client.request<ViewResult>("view", { beeId })).view;
  const sent = await client.request<SendRpcResult>("send", { beeId, body: `@sh ${cmd}` });
  await waitFor(async () => {
    const v = (await client.request<ViewResult>("view", { beeId })).view;
    return v.runtimeState === "idle" && (v.lastOutputAt ?? 0) > (before.lastOutputAt ?? 0);
  }, `turn ended: ${cmd} (message ${sent.messageId})`, 30_000);
}

async function idle(client: RpcClient, beeId: string): Promise<ViewResult> {
  return waitFor(async () => {
    const v = await client.request<ViewResult>("view", { beeId });
    return v.view.runtimeState === "idle" ? v : null;
  }, "idle", 60_000);
}

test("champions.0: verbs and capability are published; everything but list/get refuses while the flag is off", { timeout: 120_000 }, async () => {
  for (const verb of ["champion.put", "champion.get", "champion.list", "champion.start", "champion.archive", "champion.delete"]) assert.ok(RPC_VERBS.includes(verb as (typeof RPC_VERBS)[number]), verb);
  assert.ok(DAEMON_CAPABILITIES.includes("champions.v1"));
  const root = mkdtempSync(join(tmpdir(), "hb-v2-champ-off-"));
  const rig = makeRig(root, {}, join(root, "objects"));
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(rig.dir);
    const client = await daemon.client();
    assert.deepEqual(await client.request<ChampionListResult>("champion.list", {}), { champions: [] });
    await assert.rejects(client.request("champion.put", { name: "Vera", agent: "cellstub", idempotencyKey: "p1" }), (err: unknown) => err instanceof RpcError && err.code === "capability_missing");
    const snapshot = await client.request<SnapshotResult>("snapshot", {});
    assert.equal(snapshot.champions, undefined, "the snapshot carries no champions table while the flag is off");
  } finally {
    await daemon?.stop();
    rig.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("champions.1: put prepares the home, start spawns in it with the Apiary tags, the incarnation is resident, a turn end bundles the home, a second daemon restores it before its first runtime, archive and delete keep the home", { timeout: 300_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-v2-champ-"));
  const objects = join(root, "shared-objects");
  mkdirSync(objects, { recursive: true });
  const rigA = makeRig(root, { enabled: true, homeSync: true, homesDir: join(root, "homes-a") }, objects);
  const rigB = makeRig(root, { enabled: true, homeSync: true, homesDir: join(root, "homes-b") }, objects);
  let a: DaemonHandle | null = null;
  let b: DaemonHandle | null = null;
  try {
    a = await startDaemon(rigA.dir, { env: { HIVE_TEST_CHAMPION_HOME_MIN_INTERVAL_MS: "0", HIVE_TEST_TRANSCRIPT_SWEEP_DELAY_MS: "0" } });
    const client = await a.client();
    mkdirSync(join(objects, "blobs", "champion-homes"), { recursive: true });
    const orphan = join(objects, "blobs", "champion-homes", "f".repeat(64));
    writeFileSync(orphan, "stale");
    const old = Date.now() - 3 * 60 * 60_000;
    const { utimesSync } = await import("node:fs");
    utimesSync(orphan, old / 1000, old / 1000);
    const put = await client.request<ChampionPutResult>("champion.put", { name: "Vera Lund", agent: "cellstub", model: "stub-1", idempotencyKey: "put-1" });
    assert.equal(put.outcome, "created");
    assert.equal(put.champion.id, "vera-lund");
    assert.equal(put.champion.home, join(root, "homes-a", "vera-lund"));
    assert.equal(readFileSync(join(put.champion.home, "MEMORY.md"), "utf8"), "# Memory\n");
    assert.ok(existsSync(join(put.champion.home, "memory")));
    const again = await client.request<ChampionPutResult>("champion.put", { name: "Vera Lund", agent: "cellstub", model: "stub-1", idempotencyKey: "put-2" });
    assert.equal(again.outcome, "unchanged");
    await assert.rejects(client.request("champion.put", { id: "vera-lund", name: "Vera Lund", agent: "cellstub", home: join(root, "elsewhere"), idempotencyKey: "put-3" }), (err: unknown) => err instanceof RpcError && err.code === "invalid_request" && /immutable/.test(err.message));
    await assert.rejects(client.request("champion.put", { name: "Greedy", agent: "cellstub", home: rigA.dir, idempotencyKey: "put-greedy" }), (err: unknown) => err instanceof RpcError && err.code === "invalid_request" && /must not hold the hive data dir/.test(err.message));
    await assert.rejects(client.request("champion.put", { name: "Greedier", agent: "cellstub", home: dirname(rigA.dir), idempotencyKey: "put-greedier" }), (err: unknown) => err instanceof RpcError && err.code === "invalid_request" && /must not hold/.test(err.message));

    const template = await client.request<TemplatePutResult>("template.put", { fields: { name: "crew-role", agent: "cellstub", prompt: "You are the crew." }, idempotencyKey: "tpl-1" });
    await client.request<ChampionPutResult>("champion.put", { id: "vera-lund", name: "Vera Lund", templateId: template.template.id, idempotencyKey: "put-tpl" });
    await assert.rejects(client.request("template.delete", { id: template.template.id, idempotencyKey: "tpl-del" }), (err: unknown) => err instanceof RpcError && err.code === "invalid_request" && /bound by Champion/.test(err.message));
    await client.request<ChampionPutResult>("champion.put", { id: "vera-lund", name: "Vera Lund", templateId: null, idempotencyKey: "put-untpl" });
    await client.request("template.delete", { id: template.template.id, idempotencyKey: "tpl-del-2" });
    const started = await client.request<ChampionStartResult>("champion.start", { id: "vera-lund", prompt: "hello", idempotencyKey: "start-1" });
    assert.equal(started.started, "spawned");
    assert.equal(started.epoch, 0);
    const view = await idle(client, started.beeId);
    assert.equal(view.bee?.cwd, put.champion.home, "the incarnation runs in the Champion's home");
    assert.ok(view.bee?.tags.includes("apiary:champion=vera-lund") && view.bee?.tags.includes("apiary:role=champion"), JSON.stringify(view.bee?.tags));
    assert.deepEqual(view.bee?.args, ["--model", "stub-1"]);
    const got = await client.request<ChampionGetResult>("champion.get", { id: "vera-lund" });
    assert.equal(got.champion.currentBeeId, started.beeId);
    const snapshot = await client.request<SnapshotResult>("snapshot", {});
    assert.equal(snapshot.champions?.[0]?.id, "vera-lund", "the snapshot carries the champions table");
    await assert.rejects(client.request("archive", { beeId: started.beeId, idempotencyKey: "arch-direct" }), (err: unknown) => err instanceof RpcError && err.code === "invalid_request" && /champion\.archive/.test(err.message));
    const running = await client.request<ChampionStartResult>("champion.start", { id: "vera-lund", idempotencyKey: "start-2" });
    assert.equal(running.started, "running");
    assert.equal(running.beeId, started.beeId, "start on a live incarnation is a no-op");

    await shIn(client, started.beeId, "printf 'TOKEN=1\\n' > .env && printf 'Vera remembers the lab.\\n' >> MEMORY.md && printf 'fact\\n' > memory/lab.md");
    await waitFor(async () => (/champion\.home\.push_refused id=vera-lund reason=secrets paths=\[\\?".env\\?"\]/.test(readFileSync(join(rigA.dir, "hived.log"), "utf8")) ? true : null), "a home holding a secret is refused", 30_000);
    assert.equal((await client.request<ChampionGetResult>("champion.get", { id: "vera-lund" })).homeObjects.some((o) => o.files >= 2), false, "nothing with the secret was bundled");
    await shIn(client, started.beeId, "rm .env");
    const bundled = await waitFor(async () => {
      const g = await client.request<ChampionGetResult>("champion.get", { id: "vera-lund" });
      return g.homeObjects.some((o) => o.files >= 2) ? g : null;
    }, "the turn end bundled the home with the new memory", 30_000);
    const object = bundled.homeObjects[0]!;
    assert.ok(object.files >= 2 && object.bytes > 0, JSON.stringify(object));
    assert.ok(existsSync(join(objects, "blobs", "champion-homes", object.ref)), "the bundle is in the shared object store");
    assert.equal(object.epoch, 0);
    await waitFor(async () => (!existsSync(orphan) ? true : null), "the daily sweep removed the planted orphan bundle", 30_000);
    assert.ok(existsSync(join(objects, "blobs", "champion-homes", object.ref)), "referenced bundles survive the sweep");

    await a.kill();
    a = null;

    b = await startDaemon(rigB.dir, { env: { HIVE_TEST_CHAMPION_HOME_MIN_INTERVAL_MS: "0" } });
    const clientB = await b.client();
    assert.deepEqual(await clientB.request<ChampionListResult>("champion.list", {}), { champions: [] }, "the second executor starts with no Champions of its own");
    const putB = await clientB.request<ChampionPutResult>("champion.put", { id: "vera-lund", name: "Vera Lund", agent: "cellstub", idempotencyKey: "put-b" });
    assert.equal(putB.champion.home, join(root, "homes-b", "vera-lund"));
    const homeObjectsBefore = (await clientB.request<ChampionGetResult>("champion.get", { id: "vera-lund" })).homeObjects;
    assert.equal(homeObjectsBefore.length, 0, "the second store knows no bundles yet");
    await assert.rejects(clientB.request("champion.start", { id: "vera-lund", homeRef: "0".repeat(64), idempotencyKey: "start-b0" }), (err: unknown) => err instanceof RpcError && err.code === "invalid_request" && /not in the object store/.test(err.message));
    const startedB = await clientB.request<ChampionStartResult>("champion.start", { id: "vera-lund", homeRef: object.ref, epoch: object.epoch, idempotencyKey: "start-b" });
    assert.equal(startedB.started, "spawned");
    assert.equal(startedB.homeRestored, true, "the Home's pointer restores the bundle before the first runtime");
    assert.equal(startedB.epoch, 1, "the takeover owns the next epoch");
    assert.equal(readFileSync(join(putB.champion.home, "MEMORY.md"), "utf8"), "# Memory\nVera remembers the lab.\n", "the memory the first executor wrote is in the new home");
    assert.equal(readFileSync(join(putB.champion.home, "memory", "lab.md"), "utf8"), "fact\n");
    await idle(clientB, startedB.beeId);
    const seeded = await clientB.request<ChampionGetResult>("champion.get", { id: "vera-lund" });
    assert.equal(seeded.champion.currentBeeId, startedB.beeId);
    assert.ok(seeded.homeObjects.some((o) => o.ref === object.ref), "the restored bundle is recorded as a pointer on this store");
    await shIn(clientB, startedB.beeId, "cat MEMORY.md > seen.txt");
    assert.equal(readFileSync(join(putB.champion.home, "seen.txt"), "utf8"), "# Memory\nVera remembers the lab.\n", "the incarnation reads its restored memory");
    const epochBundle = await waitFor(async () => {
      const g = await clientB.request<ChampionGetResult>("champion.get", { id: "vera-lund" });
      return g.homeObjects.find((o) => o.epoch === 1) ?? null;
    }, "B's bundles carry B's epoch", 30_000);
    assert.ok(epochBundle);

    a = await startDaemon(rigA.dir, { env: { HIVE_TEST_CHAMPION_HOME_MIN_INTERVAL_MS: "0" } });
    const clientA = await a.client();
    const stale = await clientA.request<ChampionGetResult>("champion.get", { id: "vera-lund" });
    assert.equal(stale.champion.epoch, 0, "the dead executor comes back believing it still owns the incarnation");
    await assert.rejects(clientA.request("champion.fence", { id: "vera-lund", epoch: -1, idempotencyKey: "fence-bad" }), (err: unknown) => err instanceof RpcError && err.code === "invalid_request");
    const fenced = await clientA.request<ChampionFenceResult>("champion.fence", { id: "vera-lund", epoch: 1, idempotencyKey: "fence-1" });
    assert.equal(fenced.champion.epoch, 1);
    assert.ok(fenced.champion.fencedAt != null);
    await assert.rejects(clientA.request("champion.start", { id: "vera-lund", idempotencyKey: "start-a-fenced" }), (err: unknown) => err instanceof RpcError && err.code === "champion_fenced");
    await assert.rejects(clientA.request("champion.start", { id: "vera-lund", epoch: 0, idempotencyKey: "start-a-old" }), (err: unknown) => err instanceof RpcError && err.code === "champion_fenced", "an older handover epoch cannot take the incarnation back");
    await assert.rejects(clientA.request("champion.fence", { id: "vera-lund", epoch: 0, idempotencyKey: "fence-old" }), (err: unknown) => err instanceof RpcError && err.code === "champion_fenced");
    await a.stop();
    a = null;

    await clientB.request("stop", { beeId: startedB.beeId, idempotencyKey: "stop-b" });
    await waitFor(async () => (await clientB.request<ViewResult>("view", { beeId: startedB.beeId })).view.runtimeState === "stopped", "stopped");
    const revived = await clientB.request<ChampionStartResult>("champion.start", { id: "vera-lund", prompt: "back", idempotencyKey: "start-b2" });
    assert.equal(revived.started, "revived");
    assert.equal(revived.beeId, startedB.beeId);
    await idle(clientB, startedB.beeId);

    const archived = await clientB.request<{ champion: { archivedAt: number | null }; commandId: number | null }>("champion.archive", { id: "vera-lund", idempotencyKey: "arch-b" });
    assert.ok(archived.champion.archivedAt != null && archived.commandId != null);
    await waitFor(async () => (await clientB.request<ViewResult>("view", { beeId: startedB.beeId })).view.lifecycle === "archived" ? true : null, "incarnation archived");
    await assert.rejects(clientB.request("champion.start", { id: "vera-lund", idempotencyKey: "start-b3" }), (err: unknown) => err instanceof RpcError && /archived/.test(err.message));
    const deleted = await clientB.request<{ champion: { home: string } }>("champion.delete", { id: "vera-lund", idempotencyKey: "del-b" });
    assert.ok(existsSync(join(deleted.champion.home, "MEMORY.md")), "delete removes the row, never the home");
    assert.deepEqual(await clientB.request<ChampionListResult>("champion.list", {}), { champions: [] });
  } finally {
    await a?.stop();
    await b?.stop();
    rigA.cleanup();
    rigB.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
