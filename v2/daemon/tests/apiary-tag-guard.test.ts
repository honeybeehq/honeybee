import { test } from "node:test";
import assert from "node:assert/strict";
import { DAEMON_CAPABILITIES, type ForkResult, type SpawnResult, type TagResult, type ViewResult } from "../src/protocol.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";
import { makeRegisteredServiceDir, registerService } from "./registered-service-fixture.ts";

const FAKE_CLAUDE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "driver-hsr", "test-agent", "fake-claude.mjs");

const reserved = (e: Error & { code?: string }): boolean => e.code === "tag_reserved";

test("apiary:* tags: refused from a bee caller on spawn and bee.tag, allowed from Apiary and the operator", async () => {
  assert.ok(DAEMON_CAPABILITIES.includes("bee.tag.apiary_reserved.v1"));
  const { dir, cleanup } = makeRegisteredServiceDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    await registerService(client, dir);
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

test("a fork never inherits apiary:role=*: forking a Champion makes an ordinary bee in the same workspace", async () => {
  const { dir, cleanup } = makeDaemonDir({
    agents: { claude: { command: process.execPath, args: [FAKE_CLAUDE, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"], adapter: "claude" } },
  });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const champion = await client.request<SpawnResult>("spawn", { name: "champ", agent: "claude", cwd: dir, tags: ["apiary:workspace=w1", "apiary:role=champion", "team:a"] });
    await client.request("send", { beeId: champion.beeId, body: "hello" });
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId: champion.beeId })).bee?.providerSessionId != null, "champion has a session");
    const fork = await client.request<ForkResult>("bee.fork", { beeId: champion.beeId });
    const forked = await client.request<ViewResult>("view", { beeId: fork.beeId });
    assert.deepEqual(forked.bee?.tags, ["apiary:workspace=w1", "team:a"]);
    assert.deepEqual((await client.request<ViewResult>("view", { beeId: champion.beeId })).bee?.tags, ["apiary:workspace=w1", "apiary:role=champion", "team:a"]);
  } finally {
    await daemon?.stop();
    cleanup();
  }
});
