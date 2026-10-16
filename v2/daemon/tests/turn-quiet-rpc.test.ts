import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeDaemonDir, startDaemon, waitFor } from "./helpers.ts";
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
    const database = new DatabaseSync(daemon.storePath, { readOnly: true });
    database.exec("PRAGMA busy_timeout = 1000");
    let before: ViewResult;
    try {
      before = await waitFor(async () => {
        const value = await view();
        if (value.bee?.lastTurnTrigger?.messageId !== restart.messageId || value.runtime?.state !== "running") return null;
        const journalPath = join(rig.dir, "runners", `${beeId}.1.observations.jsonl`);
        let journal: string;
        try { journal = readFileSync(journalPath, "utf8"); } catch { return null; }
        const messageAt = journal.lastIndexOf("restart ready <quiet/>");
        if (messageAt < 0) return null;
        const messageEnd = Buffer.byteLength(journal.slice(0, journal.indexOf("\n", messageAt) + 1));
        try {
          const row = database.prepare("SELECT cursor FROM runtime_observation_cursors WHERE bee_id = ? AND generation = 1").get(beeId);
          return row && Number(row.cursor) >= messageEnd ? value : null;
        } catch (error) {
          if (error instanceof Error && /database is (locked|busy)/.test(error.message)) return null;
          throw error;
        }
      }, "quiet final message committed before restart", 10_000);
    } finally { database.close(); }
    await daemon.kill();
    client.close();
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
