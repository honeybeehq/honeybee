import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeDaemonDir, sleep, startDaemon, waitFor } from "./helpers.ts";
import type { SendRpcResult, SpawnResult, ViewResult } from "../src/protocol.ts";

const fixture = new URL("./fixtures/quiet-claude.mjs", import.meta.url).pathname;

test("quiet facts through a throwaway daemon: root/child isolation, failure, interruption and mid-turn restart", { timeout: 90_000 }, async () => {
  const rig = makeDaemonDir({ agents: { claude: { command: process.execPath, args: [fixture], adapter: "claude" } } });
  let daemon = await startDaemon(rig.dir);
  let client = await daemon.client();
  try {
    const spawned = await client.request<SpawnResult>("spawn", { name: "quiet-lab", agent: "claude", substrate: "hsr", cwd: rig.dir });
    const beeId = spawned.beeId;
    const view = () => client.request<ViewResult>("view", { beeId });
    await waitFor(async () => (await view()).runtime?.state === "idle", "fixture ready");
    const send = (body: string) => client.request<SendRpcResult>("send", { beeId, body });
    const ended = (messageId: number) => waitFor(async () => {
      const value = await view();
      return value.bee?.lastTurnTrigger?.messageId === messageId && value.bee.lastTurnTrigger.endedAt !== null ? value : null;
    }, "native turn completed", 20_000);
    const spoken = await ended((await send("@root-sub")).messageId);
    assert.equal(spoken.bee!.lastTurnTrigger!.endedQuiet, false);
    assert.equal(spoken.bee!.lastHumanOutputAt, spoken.bee!.lastOutputAt);
    console.log("LAB root reply + quiet sidechains: endedQuiet=false, human cursor advances");
    const failed = await ended((await send("@quiet-error")).messageId);
    assert.equal(failed.bee!.lastTurnTrigger!.endedQuiet, undefined);
    console.log("LAB quiet then native error: endedQuiet absent");
    const interruption = await send("@interrupt");
    await waitFor(async () => {
      const value = await view();
      return value.bee?.lastTurnTrigger?.messageId === interruption.messageId && value.runtime?.state === "running";
    }, "interruptible turn running");
    await client.request("bee.interrupt", { beeId });
    assert.equal((await ended(interruption.messageId)).bee!.lastTurnTrigger!.endedQuiet, undefined);
    console.log("LAB quiet then explicit interrupt: endedQuiet absent");
    const restart = await send("@restart");
    let messageEnd = 0;
    const before = await waitFor(async () => {
      const value = await view();
      if (value.bee?.lastTurnTrigger?.messageId !== restart.messageId || value.runtime?.state !== "running") return null;
      const journalPath = join(rig.dir, "runners", `${beeId}.1.observations.jsonl`);
      let journal: string;
      try { journal = readFileSync(journalPath, "utf8"); } catch { return null; }
      const messageAt = journal.lastIndexOf("restart ready <quiet/>");
      if (messageAt < 0) return null;
      messageEnd = Buffer.byteLength(journal.slice(0, journal.indexOf("\n", messageAt) + 1));
      return value;
    }, "quiet final native message before restart", 10_000);
    await sleep(100);
    await daemon.kill();
    client.close();
    const database = new DatabaseSync(daemon.storePath, { readOnly: true });
    try {
      const row = database.prepare("SELECT cursor FROM runtime_observation_cursors WHERE bee_id = ? AND generation = 1").get(beeId);
      assert.ok(row && Number(row.cursor) >= messageEnd, `committed cursor ${String(row?.cursor)} must include final message through ${messageEnd}`);
      console.log(`LAB committed final message boundary=${messageEnd}, cursor=${String(row.cursor)}`);
    } finally { database.close(); }
    daemon = await startDaemon(rig.dir);
    client = await daemon.client();
    const after = await ended(restart.messageId);
    assert.equal(after.runtime!.pid, before.runtime!.pid);
    assert.equal(after.runtime!.generation, before.runtime!.generation);
    assert.equal(after.bee!.lastTurnTrigger!.endedQuiet, true);
    assert.equal(after.bee!.lastHumanOutputAt, before.bee!.lastHumanOutputAt);
    console.log("LAB restart after committed quiet message: same PID/generation, endedQuiet=true, human cursor preserved");
  } finally {
    client.close();
    await daemon.stop();
    rig.cleanup();
  }
});

for (const harness of ["grok", "kimi"] as const) {
  test(`quiet ACP facts through a throwaway ${harness} daemon`, { timeout: 60_000 }, async () => {
    const acpFixture = new URL("./fixtures/quiet-acp.mjs", import.meta.url).pathname;
    const rig = makeDaemonDir({ agents: { [harness]: { command: acpFixture, args: [], adapter: harness } } });
    const daemon = await startDaemon(rig.dir);
    const client = await daemon.client();
    try {
      const spawned = await client.request<SpawnResult>("spawn", { name: `quiet-${harness}`, agent: harness, substrate: "hsr", cwd: rig.dir });
      const beeId = spawned.beeId;
      await waitFor(async () => (await client.request<ViewResult>("view", { beeId })).runtime?.state === "idle", `${harness} fixture ready`, 20_000);
      for (const [body, expected] of [["@success", true], ["@error", undefined], ["@cancelled", undefined], ["@refusal", undefined]] as const) {
        const sent = await client.request<SendRpcResult>("send", { beeId, body });
        const value = await waitFor(async () => {
          const current = await client.request<ViewResult>("view", { beeId });
          return current.bee?.lastTurnTrigger?.messageId === sent.messageId && current.bee.lastTurnTrigger.endedAt !== null ? current : null;
        }, `${harness} ${body} turn ended`, 20_000);
        assert.equal(value.bee!.lastTurnTrigger!.endedQuiet, expected, `${harness} ${body}`);
        console.log(`LAB ${harness} ${body}: endedQuiet=${String(expected)}`);
      }
    } finally {
      client.close();
      await daemon.stop();
      rig.cleanup();
    }
  });
}
