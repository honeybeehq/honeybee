import { test } from "node:test";
import assert from "node:assert/strict";
import { RpcError, type SetParentResult, type SpawnResult, type ViewResult, type SnapshotResult, type WatchFrame, type CommandsResult, type MailboxResult } from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

// Real disposable daemon + stub processes. No production runtime or data directory.
test("bee.setParent live RPC, exact watch payload, validation, durable replay/reconnect, undo", { timeout: 60_000 }, async () => {
  const rig = makeDaemonDir(); let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(rig.dir);
    let client = await daemon.client();
    const spawn = async (name: string, parentId?: string, tags?: string[]) => client.request<SpawnResult>("spawn", { name, agent: "stub", cwd: "/tmp", parentId, tags });
    const parent = await spawn("parent");
    const child = await spawn("child", parent.beeId, [`apiary:parent=${parent.beeId}`, "apiary:top-level", "keep"]);
    const grandchild = await spawn("grandchild", child.beeId);
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId: grandchild.beeId })).view.runtimeState === "idle", "stub boot");
    const view = () => client.request<ViewResult>("view", { beeId: child.beeId });
    await client.request("send", { beeId: child.beeId, body: "@hang" });
    await waitFor(async () => (await view()).view.runtimeState === "running", "live running turn");
    const before = await view();
    const grandBefore = await client.request<ViewResult>("view", { beeId: grandchild.beeId });
    const commands = await client.request<CommandsResult>("commands", { beeId: child.beeId });
    const mailbox = await client.request<MailboxResult>("mailbox", { beeId: child.beeId });
    const watcher = await daemon.client(); const frames: WatchFrame[] = [];
    watcher.onEvent = f => frames.push(f); await watcher.request("watch");
    const params = { beeId: child.beeId, parentId: null, parentExternal: true, idempotencyKey: "detach" };
    const detached = await client.request<SetParentResult>("bee.setParent", params);
    assert.equal(detached.applied, true); assert.equal(detached.bee.parentId, null);
    assert.equal(detached.bee.parentExternal, false); assert.equal(detached.bee.createdById, parent.beeId);
    assert.deepEqual(detached.bee.tags, ["apiary:top-level", "keep"]);
    const event = await waitFor(() => frames.flatMap(f => f.type === "delta" ? f.events : []).find(e => e.kind === "bee.parent_set"), "parent watch delta");
    assert.deepEqual(event.payload, { beeId: child.beeId, parentId: null, parentExternal: false, createdById: parent.beeId, tags: ["apiary:top-level", "keep"] });
    assert.deepEqual((await view()).runtime, before.runtime);
    assert.deepEqual(await client.request("commands", { beeId: child.beeId }), commands);
    assert.deepEqual(await client.request("mailbox", { beeId: child.beeId }), mailbox);
    assert.deepEqual(await client.request("view", { beeId: grandchild.beeId }), grandBefore);
    assert.equal((await client.request<SetParentResult>("bee.setParent", { ...params, idempotencyKey: "already-null" })).applied, false);
    const undo = { ...params, parentId: parent.beeId, parentExternal: false, idempotencyKey: "undo" };
    await client.request("bee.setParent", undo);
    const replay = await client.request<SetParentResult>("bee.setParent", { ...params, parentExternal: false });
    assert.deepEqual(replay, { ...detached, deduped: true });
    assert.equal((await view()).bee?.parentId, parent.beeId, "replay returns original effect without detaching again");
    for (const [request, code] of [
      [{ ...params, parentId: parent.beeId }, "idempotency_conflict"],
      [{ ...params, beeId: parent.beeId }, "idempotency_conflict"],
      [{ ...params, idempotencyKey: undefined }, "invalid_request"],
      [{ ...params, parentId: undefined, idempotencyKey: "invalid" }, "invalid_request"],
      [{ ...params, parentExternal: "false", idempotencyKey: "invalid" }, "invalid_request"],
      [{ ...params, parentId: "", idempotencyKey: "invalid" }, "invalid_request"],
      [{ ...params, parentId: child.beeId, idempotencyKey: "self" }, "invalid_request"],
      [{ ...params, beeId: parent.beeId, parentId: grandchild.beeId, parentExternal: false, idempotencyKey: "cycle" }, "invalid_request"],
      [{ ...params, parentId: "absent", parentExternal: false, idempotencyKey: "missing" }, "bee_not_found"],
      [{ ...params, beeId: "absent", idempotencyKey: "missing-child" }, "bee_not_found"],
    ] as const) await assert.rejects(client.request("bee.setParent", request), (e: unknown) => e instanceof RpcError && e.code === code);
    await assert.rejects(client.request("bee.rename", { beeId: child.beeId, name: "x", idempotencyKey: "detach" }), (e: unknown) => e instanceof RpcError && e.code === "idempotency_conflict");
    await client.request("bee.rename", { beeId: child.beeId, name: "child", idempotencyKey: "rename-key" });
    await assert.rejects(client.request("bee.setParent", { ...params, idempotencyKey: "rename-key" }), (e: unknown) => e instanceof RpcError && e.code === "idempotency_conflict");
    await client.request("bee.setParent", { ...params, parentId: "external-parent", parentExternal: true, idempotencyKey: "external" });
    assert.equal((await view()).bee?.parentExternal, true);
    watcher.close(); client.close(); await daemon.kill(); daemon = await startDaemon(rig.dir); client = await daemon.client();
    const snapshot = await client.request<SnapshotResult>("snapshot");
    const row = snapshot.views.find(v => v.bee?.id === child.beeId)?.bee;
    assert.equal(row?.parentId, "external-parent"); assert.equal(row?.createdById, parent.beeId);
    assert.deepEqual(await client.request("bee.setParent", params), { ...detached, deduped: true });
    assert.equal((await view()).bee?.parentId, "external-parent");
    client.close();
  } finally { await daemon?.stop(); rig.cleanup(); }
});
