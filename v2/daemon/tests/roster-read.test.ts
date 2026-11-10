import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openCoreStore } from "../../core/src/index.ts";
import { RpcClient } from "../../cli/src/client.ts";
import { RpcError, type ListResult, type SnapshotResult, type ViewResult, type WatchFrame } from "../src/protocol.ts";
import { localTrustMessage, type LocalTrustChallenge } from "../src/localRpcTrust.ts";
import { archivedCursor, archivedCursorText, snapshotLifecycle } from "../src/rosterRead.ts";
import { ConfinedAdmission } from "../src/confinedPeer.ts";
import { runV2Cli } from "../../cli/src/main.ts";
import { stripAnsi } from "../../cli/src/style.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const invalid = (error: unknown): boolean => error instanceof RpcError && error.code === "invalid_request";
const ids = (views: ViewResult[]): string[] => views.map(row => row.bee!.id);
const withoutCapacity = ({ capacity: _capacity, ...rest }: SnapshotResult): Omit<SnapshotResult, "capacity"> => rest;

test("roster cursor and scope parameters are closed", () => {
  const cursor = { archivedAt: 1_794_000_000_000, id: "bee-ø/1" };
  assert.deepEqual(archivedCursor(archivedCursorText(cursor)), cursor);
  for (const value of [undefined, null, 7, "", "not-a-cursor", Buffer.from("[1]").toString("base64url"), Buffer.from("[\"1\",\"x\"]").toString("base64url"), Buffer.from("{}").toString("base64url"), "a".repeat(2000)]) {
    assert.throws(() => archivedCursor(value), invalid);
  }
  assert.equal(snapshotLifecycle("watch", {}), undefined);
  assert.equal(snapshotLifecycle("watch", { lifecycle: null }), undefined);
  assert.equal(snapshotLifecycle("watch", { lifecycle: "active" }), "active");
  for (const lifecycle of ["archived", "deleted", "", 1, true]) assert.throws(() => snapshotLifecycle("snapshot", { lifecycle }), invalid);
});

test("roster reads over RPC: lifecycle scope, archived pages, scoped snapshot and unscoped deltas", async () => {
  const { dir, cleanup } = makeDaemonDir({ rpcLocalTrust: { requireObservationCaller: true } });
  const clients: RpcClient[] = [];
  let daemon: DaemonHandle | null = null;
  try {
    let clock = 1_000_000;
    const store = openCoreStore(join(dir, "core.sqlite3"), { ephemeral: true, now: () => (clock += 10) });
    const env = { CODEX_HOME: join(dir, "codex-fixture") };
    for (let i = 0; i < 7; i++) {
      const { bee } = store.createBee({ id: `bee-${i}`, name: `worker-${i}`, agent: "stub", substrate: "hsr", cwd: dir, env });
      store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "clean" });
      store.createSeal(bee.id, { id: `seal-${i}`, title: `result ${i}`, body: "body" });
      store.askQuestion(bee.id, { id: `question-${i}`, text: `question ${i}` });
    }
    for (const [index, id] of ["bee-5", "bee-1", "bee-3", "bee-6"].entries()) {
      clock = 2_000_000 + index * 1_000;
      store.archiveBee(id);
    }
    store.close();
    const newestArchivedFirst = ["bee-6", "bee-3", "bee-1", "bee-5"];
    const active = ["bee-0", "bee-2", "bee-4"];

    daemon = await startDaemon(dir);
    const client = await daemon.client(); clients.push(client);
    assert.ok(client.capabilities.includes("roster.read.v1"));

    const all = await client.request<ListResult>("list");
    assert.equal(all.views.length, 7);
    assert.equal("next" in all, false);
    assert.deepEqual(await client.request<ListResult>("list", { lifecycle: null }), all);
    const byId = new Map(all.views.map(row => [row.bee!.id, row]));
    const activeList = await client.request<ListResult>("list", { lifecycle: "active" });
    assert.deepEqual(activeList, { views: active.map(id => byId.get(id)) });
    const archivedList = await client.request<ListResult>("list", { lifecycle: "archived" });
    assert.deepEqual(archivedList, { views: ["bee-1", "bee-3", "bee-5", "bee-6"].map(id => byId.get(id)) });

    const walked: ViewResult[] = [];
    let after: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await client.request<ListResult>("list", { lifecycle: "archived", limit: 3, ...(after === undefined ? {} : { after }) });
      pages += 1;
      walked.push(...page.views);
      if (page.next === null) break;
      assert.equal(typeof page.next, "string");
      assert.equal(page.views.length, 3);
      after = page.next!;
    }
    assert.equal(pages, 2);
    assert.deepEqual(ids(walked), newestArchivedFirst);
    assert.deepEqual(walked, newestArchivedFirst.map(id => byId.get(id)));
    const exact = await client.request<ListResult>("list", { lifecycle: "archived", limit: 4 });
    assert.deepEqual(ids(exact.views), newestArchivedFirst);
    assert.equal(exact.next, null);
    const one = await client.request<ListResult>("list", { lifecycle: "archived", limit: 1 });
    assert.deepEqual(ids(one.views), ["bee-6"]);
    assert.deepEqual(ids((await client.request<ListResult>("list", { lifecycle: "archived", limit: 1, after: one.next })).views), ["bee-3"]);

    for (const params of [
      { limit: 2 }, { lifecycle: "active", limit: 2 }, { lifecycle: "archived", limit: 0 }, { lifecycle: "archived", limit: 1001 },
      { lifecycle: "archived", limit: 1.5 }, { lifecycle: "archived", limit: "2" }, { lifecycle: "archived", after: one.next },
      { lifecycle: "archived", limit: 2, after: "garbage" }, { lifecycle: "deleted" }, { lifecycle: 3 },
    ]) await assert.rejects(client.request("list", params), invalid, JSON.stringify(params));

    assert.deepEqual(await client.request<ListResult>("list", { refs: ["bee-3"] }), { views: [byId.get("bee-3")] });
    assert.deepEqual(await client.request<ListResult>("list", { refs: ["worker-5"] }), { views: [byId.get("bee-5")] });
    assert.deepEqual(await client.request<ListResult>("list", { refs: ["worker-5", "bee-0", "nobody", "bee-0"] }), { views: [byId.get("bee-0"), byId.get("bee-5")] });
    assert.deepEqual(await client.request<ListResult>("list", { refs: ["bee"] }), all);
    assert.deepEqual(await client.request<ListResult>("list", { refs: ["nobody"] }), { views: [] });
    assert.ok(client.capabilities.includes("roster.read.refs_limit.v1"));
    const boundedPrefix = await client.request<ListResult>("list", { refs: ["bee"], limit: 3 });
    assert.deepEqual(boundedPrefix, { views: ["bee-0", "bee-1", "bee-2"].map(id => ({ ...byId.get(id)!, refMatch: "prefix" })), matched: 7, truncated: true });
    const exactFirst = await client.request<ListResult>("list", { refs: ["bee", "worker-5"], limit: 2 });
    assert.deepEqual(exactFirst, { views: [{ ...byId.get("bee-5")!, refMatch: "exact" }, { ...byId.get("bee-0")!, refMatch: "prefix" }], matched: 7, truncated: true });
    assert.deepEqual(await client.request<ListResult>("list", { refs: ["worker-5"], limit: 5 }), { views: [{ ...byId.get("bee-5")!, refMatch: "exact" }], matched: 1, truncated: false });
    assert.deepEqual(await client.request<ListResult>("list", { refs: ["nobody"], limit: 5 }), { views: [], matched: 0, truncated: false });
    assert.deepEqual(new ConfinedAdmission().admit("list", { refs: ["bee"], limit: 2 }, { beeId: "bee-0", generation: 1, parentId: null, canSend: () => false }), { refs: ["bee"], limit: 2 });
    for (const params of [{ refs: [] }, { refs: "bee-3" }, { refs: [""] }, { refs: [7] }, { refs: ["x".repeat(600)] }, { refs: Array.from({ length: 17 }, () => "bee-3") }, { refs: ["bee-3"], lifecycle: "active" }, { refs: ["bee-3"], limit: 0 }, { refs: ["bee-3"], limit: 1001 }, { refs: ["bee-3"], limit: 1.5 }, { refs: ["bee-3"], limit: "2" }, { refs: ["bee-3"], after: one.next }]) {
      await assert.rejects(client.request("list", params), invalid, JSON.stringify(params).slice(0, 80));
    }
    const confined = new ConfinedAdmission();
    const identity = { beeId: "bee-0", generation: 1, parentId: null, canSend: () => false };
    assert.deepEqual(confined.admit("list", { refs: ["bee-3"] }, identity), { refs: ["bee-3"] });
    assert.throws(() => confined.admit("list", { lifecycle: "active" }, identity), error => error instanceof RpcError && error.code === "confined_peer_refused");

    const cli = async (...argv: string[]): Promise<{ code: number; json: ListResult & { view?: { beeId: string } }; text: string }> => {
      const out: string[] = [];
      const code = await runV2Cli([...argv, "--data-dir", dir], { out: line => out.push(stripAnsi(line)), err: line => out.push(stripAnsi(line)) });
      const text = out.join("\n");
      return { code, json: argv.includes("--json") && code === 0 ? JSON.parse(out[0] ?? "{}") : { views: [] }, text };
    };
    const firstPage = await cli("list", "--archived", "--limit", "3", "--json");
    assert.deepEqual(ids(firstPage.json.views), newestArchivedFirst.slice(0, 3));
    const secondPage = await cli("list", "--archived", "--limit", "3", "--after", firstPage.json.next!, "--json");
    assert.deepEqual(ids(secondPage.json.views), newestArchivedFirst.slice(3));
    assert.equal(secondPage.json.next, null);
    assert.match((await cli("list", "--archived", "--limit", "3")).text, /next page: --after \S+/);
    assert.doesNotMatch((await cli("list", "--archived", "--limit", "4")).text, /next page/);
    assert.equal((await cli("list", "--limit", "3")).code, 1);
    assert.equal((await cli("list", "--archived", "--after", firstPage.json.next!)).code, 1);
    assert.equal((await cli("view", "worker-5", "--json")).json.view?.beeId, "bee-5");
    assert.equal((await cli("view", "bee-", "--json")).code, 1);

    const { full, scoped } = await waitFor(async () => {
      const whole = await client.request<SnapshotResult>("snapshot");
      const part = await client.request<SnapshotResult>("snapshot", { lifecycle: "active" });
      return part.seq === whole.seq ? { full: whole, scoped: part } : null;
    }, "a full and an active snapshot at one seq");
    const members = new Set(active);
    assert.deepEqual(scoped.views, full.views.filter(row => members.has(row.bee!.id)));
    assert.deepEqual(scoped.seals, full.seals.filter(row => members.has(row.beeId)));
    assert.deepEqual(scoped.questions, full.questions.filter(row => members.has(row.beeId)));
    assert.deepEqual(scoped.transcriptSegments, full.transcriptSegments.filter(row => members.has(row.beeId)));
    assert.equal(scoped.seals.length, 3);
    assert.equal(scoped.questions.length, 3);
    assert.equal(scoped.transcriptSegments.length, 3);
    for (const key of ["templates", "accounts", "accountLimits", "accountAdmissions", "loginFlows"] as const) assert.deepEqual(scoped[key], full[key]);
    assert.deepEqual(Object.keys(scoped).sort(), Object.keys(full).sort());
    await waitFor(async () => {
      const whole = await client.request<SnapshotResult>("snapshot");
      const unscoped = await client.request<SnapshotResult>("snapshot", { lifecycle: null });
      if (unscoped.seq !== whole.seq) return null;
      assert.deepEqual(withoutCapacity(unscoped), withoutCapacity(whole));
      return true;
    }, "a null lifecycle is the unscoped snapshot");
    for (const verb of ["snapshot", "watch", "mirror.local.snapshot", "mirror.local.watch"] as const) {
      await assert.rejects(client.request(verb, { lifecycle: "archived" }), invalid, verb);
    }

    const frames: WatchFrame[] = [];
    const watcher = await daemon.client(); clients.push(watcher);
    watcher.onEvent = frame => { frames.push(frame); };
    const watched = await watcher.request<SnapshotResult>("watch", { lifecycle: "active" });
    assert.deepEqual(ids(watched.views), active);
    const seen = (kind: string, beeId: string): boolean => frames.some(frame => frame.type === "delta" && frame.events.some(event => event.kind === kind && event.beeId === beeId));
    await client.request("bee.rename", { beeId: "bee-1", name: "renamed-while-archived" });
    await waitFor(() => seen("bee.renamed", "bee-1"), "delta for an archived bee reaches the active-scope watcher");
    await client.request("unarchive", { beeId: "bee-3" });
    await waitFor(() => seen("bee.unarchived", "bee-3"), "unarchive delta reaches the active-scope watcher");
    const deltas = frames.filter(frame => frame.type === "delta");
    assert.equal(deltas[0]!.baseSeq, watched.seq);
    for (let i = 1; i < deltas.length; i++) assert.equal(deltas[i]!.baseSeq, deltas[i - 1]!.seq);
    const entered = await client.request<ViewResult>("view", { beeId: "bee-3" });
    assert.equal(entered.bee!.lifecycle, "active");
    assert.deepEqual(ids((await client.request<SnapshotResult>("snapshot", { lifecycle: "active" })).views), ["bee-0", "bee-2", "bee-3", "bee-4"]);
    assert.equal(frames.some(frame => frame.type === "gap"), false);

    const beforeTrust = await client.request<SnapshotResult>("mirror.local.snapshot", { lifecycle: "active" });
    assert.equal(beforeTrust.views.some(row => "operatorLocalHomes" in (row.bee as object)), false);
    const challenge = await client.request<LocalTrustChallenge>("rpc.localTrust.challenge");
    const secret = readFileSync(join(dir, "rpc-private", "registration.key"));
    const token = createHmac("sha256", secret).update(localTrustMessage(challenge)).digest("hex"); secret.fill(0);
    await client.request("rpc.localTrust.register", { pid: process.pid, challengeId: challenge.challengeId, token });
    for (const verb of ["mirror.local.snapshot", "mirror.local.watch"] as const) {
      const local = await client.request<SnapshotResult>(verb, { lifecycle: "active" });
      assert.deepEqual(ids(local.views), ["bee-0", "bee-2", "bee-3", "bee-4"]);
      for (const row of local.views) assert.deepEqual((row.bee as unknown as { operatorLocalHomes: unknown }).operatorLocalHomes, { codexHome: env.CODEX_HOME, claudeConfigDir: null, grokHome: null });
      assert.equal(JSON.stringify(local).includes("\"env\""), false);
    }
    const unscopedLocal = await client.request<SnapshotResult>("mirror.local.snapshot");
    assert.equal(unscopedLocal.views.length, 7);
    const strayParam = await client.request<SnapshotResult>("mirror.local.snapshot", { lifecycle: "active", other: 1 });
    assert.equal(strayParam.views.some(row => "operatorLocalHomes" in (row.bee as object)), false);
  } finally { clients.forEach(client => client.close()); await daemon?.stop(); cleanup(); }
});
