import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { openCoreStore } from "../../v2/core/src/index.ts";
import { RpcClient } from "../../v2/cli/src/client.ts";
import { startDaemon, waitFor, AGENT_PATH } from "../../v2/daemon/tests/helpers.ts";

const here = fileURLToPath(import.meta.url);
function schema(db) {
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS state(node TEXT PRIMARY KEY,cursor TEXT NOT NULL); CREATE TABLE IF NOT EXISTS applied(node TEXT,seq INTEGER,PRIMARY KEY(node,seq)); CREATE TABLE IF NOT EXISTS receipts(node TEXT,id TEXT,bee TEXT,kind TEXT,value TEXT,PRIMARY KEY(node,id)); CREATE TABLE IF NOT EXISTS bees(node TEXT,id TEXT,name TEXT,PRIMARY KEY(node,id)); CREATE TABLE IF NOT EXISTS fences(node TEXT,id TEXT,value TEXT,PRIMARY KEY(node,id));");
}
function receipt(db, node, kind, value) {
  db.prepare("INSERT OR REPLACE INTO receipts VALUES(?,?,?,?,?)").run(node, value.id, value.beeId, kind, JSON.stringify(value));
}
function apply(db, node, row) {
  if (db.prepare("SELECT 1 FROM applied WHERE node=? AND seq=?").get(node, row.seq)) return;
  db.prepare("INSERT INTO applied VALUES(?,?)").run(node, row.seq);
  const p = row.payload;
  if (row.kind === "bee.epoch") db.prepare("INSERT OR REPLACE INTO fences VALUES(?,?,?)").run(node, row.beeId, JSON.stringify({ beeId: p.beeId, epoch: p.epoch, fencedAt: p.fencedAt }));
  if (row.kind === "bee.created") db.prepare("INSERT OR REPLACE INTO bees VALUES(?,?,?)").run(node, row.beeId, p.bee.name);
  if (row.kind === "bee.renamed") db.prepare("UPDATE bees SET name=? WHERE node=? AND id=?").run(p.name, node, row.beeId);
  if (row.kind === "bee.deleted") {
    db.prepare("DELETE FROM bees WHERE node=? AND id=?").run(node, row.beeId);
    db.prepare("DELETE FROM receipts WHERE node=? AND bee=?").run(node, row.beeId);
  }
  if (row.kind === "bee_resume_bundle.put") receipt(db, node, "bundle", p.bundle);
  if (row.kind === "bee_resume_bundle.removed") db.prepare("DELETE FROM receipts WHERE node=? AND id=?").run(node, p.id);
  if (row.kind === "transcript_segment_object.put") receipt(db, node, "segment", p.segment);
  if (row.kind === "transcript.segment.ready") for (const segment of p.segments) receipt(db, node, "segment", segment);
}
function baseline(db, node, result) {
  db.exec("BEGIN IMMEDIATE");
  for (const table of ["bees", "receipts", "applied", "fences"]) db.prepare(`DELETE FROM ${table} WHERE node=?`).run(node);
  for (const view of result.snapshot.views) db.prepare("INSERT INTO bees VALUES(?,?,?)").run(node, view.bee.id, view.bee.name);
  for (const value of result.receipts.beeEpochs) db.prepare("INSERT INTO fences VALUES(?,?,?)").run(node, value.beeId, JSON.stringify(value));
  for (const value of result.receipts.resumeBundles) receipt(db, node, "bundle", value);
  for (const value of result.receipts.segmentObjects) receipt(db, node, "segment", value);
  db.prepare("INSERT OR REPLACE INTO state VALUES(?,?)").run(node, JSON.stringify(result.cursor));
  db.exec("COMMIT");
}
async function consumer() {
  const [path, node, socket] = process.argv.slice(3);
  const db = new DatabaseSync(path);
  schema(db);
  const stage = async value => { process.send(value); await once(process, "message"); };
  await stage("before-fetch");
  const client = await RpcClient.connect(socket, 3000, undefined, { capabilities: ["mirror.changes.v1"] });
  try {
    const cursor = JSON.parse(db.prepare("SELECT cursor FROM state WHERE node=?").get(node).cursor);
    const result = await client.request("mirror.changes", { cursor, limit: 3 });
    if (result.status !== "ok") { process.send({ resync: result.reason }); return; }
    await stage("before-apply");
    db.exec("BEGIN IMMEDIATE");
    for (let i = 0; i < result.events.length; i++) {
      apply(db, node, result.events[i]);
      if (i === 0) await stage("mid-apply");
    }
    await stage("after-apply-before-cursor");
    db.prepare("UPDATE state SET cursor=? WHERE node=?").run(JSON.stringify(result.cursor), node);
    db.exec("COMMIT");
    await stage("after-commit");
    process.send({ done: true });
  } finally { client.close(); db.close(); process.disconnect(); }
}
if (process.argv[2] === "--consumer") {
  await consumer();
} else {
  const arg = (key, fallback) => { const i = process.argv.indexOf(key); return i < 0 ? fallback : process.argv[i + 1]; };
  const seed = Number(arg("--seed", "71941"));
  const rounds = Number(arg("--rounds", "40"));
  assert.ok(Number.isSafeInteger(seed) && Number.isSafeInteger(rounds) && rounds > 0);
  let random = seed >>> 0;
  const next = n => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % n; };
  const root = resolve(arg("--root", `.proof/cs-${seed}-${process.pid}`));
  mkdirSync(root, { recursive: true });
  const replica = join(root, "replica.sqlite");
  const report = { seed, rounds, root, schedule: [], crashes: {}, refusals: {}, unchanged: { calls: 0, events: 0, receiptRefs: 0 }, comparisons: 0, missedUpdates: 0, doubleApplies: 0, staleRows: 0 };
  const nodes = [];
  let db = new DatabaseSync(replica);
  schema(db);
  function mutate(node, round) {
    const store = openCoreStore(join(node.dir, "core.sqlite3"), { now: () => Date.now() + node.skew });
    try {
      const beeId = `b-${round}`;
      store.createBee({ id: beeId, name: beeId, handle: `CS.${round}`, agent: "stub", substrate: "hsr", cwd: node.dir });
      store.updateRuntimeState(beeId, 1, "stopped", { exitCause: "clean" });
      for (let j = 0; j < 4; j++) store.putBeeResumeBundle({ beeId, generation: 1, harness: "stub", providerSessionId: "generated", cwd: node.dir, stateKey: null, scope: null, ref: `ref-${round}-${j}`, digest: "generated", keyId: "fixture", bytes: 10, size: 10, files: 1, closedAt: round * 10 + j, epoch: 0 }, { keep: 2 });
      store.fenceBee(beeId, round + 1);
      if (round === 0) store.takeoverBee(beeId, round + 1);
      store.putTranscriptSegmentObjects([{ segment: { beeId, firstLine: 0, lastLine: 1, byteStart: 0, byteEnd: 10, harness: "stub", rawRef: `raw-${round}`, rawSize: 10, rawBytes: 10, projectedRef: `proj-${round}`, projectedSize: 10, projectedBytes: 10, projectionVersion: 1, digest: "generated", closedAt: round, epoch: "fixture", path: "generated", logSegmentId: null }, cursor: { path: "generated", lineNo: 1, byteOffset: 10, epoch: "fixture", projectorCheckpoint: null } }], { reason: "turn_ended", rowAudit: false });
      const old = store.listBees().find(row => row.id !== beeId);
      if (old && round % 3 === 0) store.deleteBee(old.id);
    } finally { store.close(); }
  }
  async function start(node) {
    node.daemon = await startDaemon(node.dir, { socketPath: node.socket, env: { NODE_OPTIONS: `--import=${node.clock}` } });
  }
  async function call(node, verb, params = {}) {
    const client = await RpcClient.connect(node.socket, 3000, undefined, { capabilities: ["mirror.changes.v1"] });
    try { return await client.request(verb, params, 30000); } finally { client.close(); }
  }
  async function crashStep(node, killAt) {
    db.close();
    const home = join(root, "consumer-home");
    mkdirSync(home, { recursive: true });
    const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"), HIVE_V2_DATA_DIR: join(home, "hive"), APIARY_DATA_DIR: home };
    const child = fork(here, ["--consumer", replica, node.id, node.socket], { env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let errors = "";
    child.stderr.on("data", data => errors += data);
    const closed = once(child, "exit");
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
    child.on("message", value => {
      if (typeof value === "string") {
        if (value === killAt) { report.crashes[value] = (report.crashes[value] ?? 0) + 1; child.kill("SIGKILL"); }
        else child.send("continue");
      }
    });
    const [code, signal] = await closed;
    clearTimeout(timer);
    assert.ok(code === 0 || signal === "SIGKILL", errors);
    db = new DatabaseSync(replica);
    schema(db);
  }
  function validatePage(cursor, result) {
    assert.equal(result.coverage.fromSeq, cursor.seq);
    assert.equal(result.coverage.throughSeq, result.cursor.seq);
    assert.equal(result.events.length, result.cursor.seq - cursor.seq);
    result.events.forEach((event, index) => assert.equal(event.seq, cursor.seq + index + 1));
  }
  async function drain(node) {
    let throughSeq;
    let pages = 0;
    for (;;) {
      assert.ok(++pages < 10000, "bounded replay must make progress");
      const cursor = JSON.parse(db.prepare("SELECT cursor FROM state WHERE node=?").get(node.id).cursor);
      const result = await call(node, "mirror.changes", { cursor, limit: 3, ...(throughSeq === undefined ? {} : { throughSeq }) });
      if (result.status !== "ok") {
        report.refusals[result.reason] = (report.refusals[result.reason] ?? 0) + 1;
        baseline(db, node.id, await call(node, "mirror.snapshot"));
        throughSeq = undefined;
        continue;
      }
      throughSeq ??= result.coverage.headSeq;
      validatePage(cursor, result);
      if (result.events.length > 1) assert.throws(() => validatePage(cursor, { ...result, events: [...result.events].reverse() }));
      db.exec("BEGIN IMMEDIATE");
      for (const event of result.events) apply(db, node.id, event);
      for (const event of [...result.events].reverse()) apply(db, node.id, event);
      db.prepare("UPDATE state SET cursor=? WHERE node=?").run(JSON.stringify(result.cursor), node.id);
      db.exec("COMMIT");
      if (!result.hasMore) break;
      if (next(4) === 0) await call(node, "bee.rename", { beeId: node.latest, name: `concurrent-${next(100000)}` });
    }
    const cursor = JSON.parse(db.prepare("SELECT cursor FROM state WHERE node=?").get(node.id).cursor);
    const ready = await call(node, "mirror.watchSince", { cursor, limit: 1000 });
    if (!ready.subscribed || ready.events?.length) {
      throughSeq = undefined;
      return drain(node);
    }
    const truth = await call(node, "mirror.snapshot");
    const expectedBees = truth.snapshot.views.map(row => [row.bee.id, row.bee.name]).sort();
    const actualBees = db.prepare("SELECT id,name FROM bees WHERE node=? ORDER BY id").all(node.id).map(row => [row.id, row.name]);
    assert.deepEqual(actualBees, expectedBees);
    const expectedReceipts = [...truth.receipts.resumeBundles, ...truth.receipts.segmentObjects].map(row => [row.id, JSON.stringify(row)]).sort();
    const actualReceipts = db.prepare("SELECT id,value FROM receipts WHERE node=? ORDER BY id").all(node.id).map(row => [row.id, row.value]);
    assert.deepEqual(actualReceipts, expectedReceipts);
    assert.deepEqual(db.prepare("SELECT id,value FROM fences WHERE node=? ORDER BY id").all(node.id).map(row => [row.id, row.value]), truth.receipts.beeEpochs.map(row => [row.beeId, JSON.stringify(row)]).sort());
    report.comparisons++;
    const empty = await call(node, "mirror.changes", { cursor: truth.cursor });
    assert.equal(empty.status, "ok");
    assert.deepEqual(empty.events, []);
    assert.equal(empty.hasMore, false);
    report.unchanged.calls++;
    report.unchanged.events += empty.events.length;
  }
  try {
    for (let i = 0; i < 3; i++) {
      const dir = join(root, `n${i}`);
      mkdirSync(dir, { recursive: true });
      const node = { id: `node-${i}`, dir, socket: `/tmp/hb-cs-${process.pid}-${i}.sock`, skew: (i - 1) * 4 * 3600_000, clock: join(dir, "clock.mjs"), latest: "b-0" };
      assert.ok(Buffer.byteLength(node.socket) < 100, "Use a shorter --root for Unix socket paths");
      writeFileSync(node.clock, `const real = Date.now; Date.now = () => real() + ${node.skew};`);
      writeFileSync(join(dir, "config.json"), JSON.stringify({ tickMs: 50, naming: { auto: false }, idleWindowMs: 0, agents: { stub: { command: process.execPath, args: [AGENT_PATH], adapter: "stub", env: { STUB_TURN_MS: "10" } } }, accounts: { vaultDir: join(dir, "vault"), homesDir: join(dir, "homes"), limitsRefreshMs: 0 } }));
      nodes.push(node);
      if (i === 0) {
        const emptyStore = openCoreStore(join(dir, "core.sqlite3"));
        assert.equal(emptyStore.mirrorCursor().seq, 0);
        assert.deepEqual(emptyStore.mirrorChanges(emptyStore.mirrorCursor()).events, []);
        emptyStore.close();
        await start(node);
        const emptySnapshot = await call(node, "mirror.snapshot");
        assert.deepEqual(emptySnapshot.snapshot.views, []);
        assert.deepEqual((await call(node, "mirror.changes", { cursor: emptySnapshot.cursor })).events, []);
        report.emptyAuthority = true;
        await node.daemon.stop();
        node.daemon = null;
      }
      mutate(node, 0);
      if (i === 0) {
        const probe = openCoreStore(join(dir, "core.sqlite3"));
        let perBeeQueries = 0;
        const statement = probe.stmt.bind(probe);
        probe.stmt = sql => new Proxy(statement(sql), { get(target, key) {
          const value = Reflect.get(target, key);
          if (["get", "all", "run"].includes(key)) return (...args) => {
            if (/\b(bees|bee_resume_bundles|transcript_segment_objects|bee_epochs)\b/.test(sql)) perBeeQueries++;
            return value.apply(target, args);
          };
          return value;
        } });
        assert.deepEqual(probe.mirrorChanges(probe.mirrorCursor()).events, []);
        assert.equal(perBeeQueries, 0);
        report.unchanged.perBeeQueries = perBeeQueries;
        probe.close();
      }
      await start(node);
      const initial = await call(node, "mirror.snapshot");
      node.epoch = initial.cursor.epoch;
      baseline(db, node.id, initial);
      await drain(node);
    }
    const watcher = await RpcClient.connect(nodes[0].socket, 3000, undefined, { capabilities: ["mirror.changes.v1"] });
    try {
      const cursor = (await call(nodes[0], "mirror.snapshot")).cursor;
      const paging = await watcher.request("mirror.watchSince", { cursor: { ...cursor, seq: 0 }, limit: 1 });
      assert.equal(paging.subscribed, false);
      assert.equal(paging.hasMore, true);
      const frames = [];
      watcher.onEvent = frame => frames.push(frame);
      const attached = await watcher.request("mirror.watchSince", { cursor });
      assert.equal(attached.subscribed, true);
      await call(nodes[0], "bee.rename", { beeId: nodes[0].latest, name: "live-watch-evidence" });
      const live = await waitFor(() => frames.find(frame => frame.type === "delta"), "live watch delta", 10000);
      assert.equal(live.baseSeq, attached.cursor.seq);
      assert.ok(live.events.some(event => event.kind === "bee.renamed"));
      live.events.forEach((event, index) => assert.equal(event.seq, live.baseSeq + index + 1));
      report.liveWatch = { attached: true, contiguous: true, events: live.events.length };
    } finally { watcher.close(); }
    await drain(nodes[0]);
    const lifecycleNode = nodes[1];
    await call(lifecycleNode, "archive", { beeId: lifecycleNode.latest });
    const archived = await waitFor(async () => { const row = await call(lifecycleNode, "view", { beeId: lifecycleNode.latest }); return row.bee.lifecycle === "archived" ? row : null; }, "bee archived", 30000);
    assert.equal(archived.bee.lifecycle, "archived");
    const sent = await call(lifecycleNode, "send", { beeId: lifecycleNode.latest, body: "Generated archived delivery evidence", urgency: "next" });
    await waitFor(async () => {
      const mailbox = await call(lifecycleNode, "mailbox", { beeId: lifecycleNode.latest });
      return mailbox.messages.find(row => row.id === sent.messageId)?.deliveredAt != null;
    }, "archived send delivered", 30000);
    const delivered = await call(lifecycleNode, "view", { beeId: lifecycleNode.latest });
    assert.equal(delivered.bee.lifecycle, "active");
    report.archivedSend = { beeId: lifecycleNode.latest, messageId: sent.messageId, lifecycle: delivered.bee.lifecycle, delivered: true };
    await call(lifecycleNode, "stop", { beeId: lifecycleNode.latest });
    await waitFor(async () => (await call(lifecycleNode, "view", { beeId: lifecycleNode.latest })).view.runtimeState === "stopped", "stub stopped", 30000);
    await drain(lifecycleNode);
    const stages = ["before-fetch", "before-apply", "mid-apply", "after-apply-before-cursor", "after-commit"];
    for (let round = 1; round <= rounds; round++) {
      const node = nodes[next(nodes.length)];
      const fault = round % 8;
      report.schedule.push({ round, node: node.id, fault });
      if (node.daemon) { await node.daemon.kill(); node.daemon = null; }
      mutate(node, round);
      node.latest = `b-${round}`;
      if (fault === 1 || fault === 2 || fault === 3) {
        const raw = new DatabaseSync(join(node.dir, "core.sqlite3"));
        if (fault === 1) raw.prepare("UPDATE meta SET value=? WHERE key='mirror_epoch'").run(`fixture-epoch-${round}`);
        if (fault === 2) raw.exec("DELETE FROM audit WHERE seq < (SELECT MAX(seq) FROM audit)");
        if (fault === 3) raw.exec("DELETE FROM audit WHERE seq = (SELECT MAX(seq) FROM audit)");
        raw.close();
      }
      if (fault === 4) {
        assert.equal(node.daemon, null);
        for (const peer of nodes.filter(value => value.daemon)) await drain(peer);
        continue;
      }
      await start(node);
      const observedEpoch = (await call(node, "mirror.changes")).cursor.epoch;
      assert.equal(observedEpoch, fault === 1 ? `fixture-epoch-${round}` : node.epoch);
      node.epoch = observedEpoch;
      await crashStep(node, stages[(round - 1) % stages.length]);
      await drain(node);
    }
    for (const node of nodes) { if (!node.daemon) await start(node); await drain(node); }
    assert.deepEqual(Object.keys(report.crashes).sort(), stages.sort());
    assert.ok(report.refusals.too_old > 0 && report.refusals.epoch_changed > 0);
    report.ok = true;
  } catch (error) { report.error = String(error.stack ?? error); throw error; }
  finally {
    db.close();
    for (const node of nodes) if (node.daemon) await node.daemon.stop();
    writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  }
}
