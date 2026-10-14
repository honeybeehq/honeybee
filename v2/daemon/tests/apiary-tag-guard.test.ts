import { test } from "node:test";
import assert from "node:assert/strict";
import { DAEMON_CAPABILITIES, type SpawnResult, type TagResult } from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, type DaemonHandle } from "./helpers.ts";

const reserved = (e: Error & { code?: string }): boolean => e.code === "tag_reserved";

test("apiary:* tags: refused from a bee caller on spawn and bee.tag, allowed from Apiary and the operator", async () => {
  assert.ok(DAEMON_CAPABILITIES.includes("bee.tag.apiary_reserved.v1"));
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const champion = await client.request<SpawnResult>("spawn", { name: "champ", agent: "stub", cwd: "/tmp", tags: ["apiary:workspace=w1", "apiary:role=champion"] });
    const bee = await client.request<SpawnResult>("spawn", { name: "worker", agent: "stub", cwd: "/tmp", tags: ["apiary:workspace=w1"], parentId: champion.beeId });

    await assert.rejects(() => client.request("bee.tag", { beeId: bee.beeId, add: ["apiary:role=champion"], callerBeeId: bee.beeId }), reserved);
    await assert.rejects(() => client.request("bee.tag", { beeId: champion.beeId, remove: ["apiary:role=champion"], callerBeeId: bee.beeId }), reserved);
    await assert.rejects(() => client.request("bee.tag", { beeId: bee.beeId, add: ["team:a", "apiary:workspace=w2"], callerBeeId: bee.beeId }), reserved);
    await assert.rejects(() => client.request("spawn", { name: "kid", agent: "stub", cwd: "/tmp", tags: ["apiary:role=champion"], parentId: bee.beeId, callerBeeId: bee.beeId }), reserved);
    await assert.rejects(() => client.request("bee.tag", { beeId: bee.beeId, add: ["team:a"], callerBeeId: "" }), (e: Error & { code?: string }) => e.code === "invalid_request");

    const own = await client.request<TagResult>("bee.tag", { beeId: bee.beeId, add: ["team:a"], callerBeeId: bee.beeId });
    assert.deepEqual(own.bee.tags, ["apiary:workspace=w1", "team:a"]);
    const kid = await client.request<SpawnResult>("spawn", { name: "kid", agent: "stub", cwd: "/tmp", tags: ["team:b"], parentId: bee.beeId, callerBeeId: bee.beeId });
    assert.ok(kid.beeId);

    const backfill = await client.request<TagResult>("bee.tag", { beeId: champion.beeId, add: ["apiary:role=champion"], idempotencyKey: "apiary-backfill-champ" });
    assert.equal(backfill.applied, false);
    const moved = await client.request<TagResult>("bee.tag", { beeId: bee.beeId, add: ["apiary:workspace=w2"], remove: ["apiary:workspace=w1"] });
    assert.deepEqual(moved.bee.tags, ["team:a", "apiary:workspace=w2"]);
  } finally {
    await daemon?.stop();
    cleanup();
  }
});
