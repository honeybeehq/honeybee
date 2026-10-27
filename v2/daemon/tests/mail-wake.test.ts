import assert from "node:assert/strict";
import { test } from "node:test";
import { HiveDaemon } from "../src/daemon.ts";
import { loadNodeConfig } from "../src/config.ts";
import { RpcClient } from "../../cli/src/client.ts";
import type { SendRpcResult, SpawnResult } from "../src/protocol.ts";
import { makeDaemonDir, waitFor } from "./helpers.ts";

test("wake requests coalesce and committed work after a tick schedules another wake", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rig = makeDaemonDir({ tickMs: 200 });
  const daemon = new HiveDaemon(loadNodeConfig(rig.dir));
  const control = daemon as unknown as { tickTimer: NodeJS.Timeout | null; requestTick(): void; tick(): void };
  let ticks = 0;
  control.tick = () => {
    ticks++;
    if (ticks === 1) queueMicrotask(() => control.requestTick());
  };
  control.tickTimer = setTimeout(() => {}, 200);
  try {
    control.requestTick();
    const requested = control.tickTimer;
    for (let i = 0; i < 100; i++) control.requestTick();
    assert.equal(control.tickTimer, requested);
    t.mock.timers.tick(0);
    assert.equal(ticks, 0);
    t.mock.timers.tick(1);
    assert.equal(ticks, 1);
    await Promise.resolve();
    t.mock.timers.tick(1);
    assert.equal(ticks, 2);
    t.mock.timers.tick(199);
    assert.equal(ticks, 2);
  } finally {
    if (control.tickTimer) clearTimeout(control.tickTimer);
    await daemon.shutdown({ preserveRuntimes: false });
    rig.cleanup();
  }
});

test("committed send publishes its keyed mail event without waiting for the idle tick", async () => {
  const rig = makeDaemonDir({ tickMs: 60_000 });
  const daemon = new HiveDaemon(loadNodeConfig(rig.dir), { keychainReader: async () => null });
  let client: RpcClient | undefined;
  try {
    await daemon.start();
    client = await RpcClient.connect(loadNodeConfig(rig.dir).socketPath);
    const { beeId } = await client.request<SpawnResult>("spawn", { name: "mail-wake", agent: "inbox", cwd: rig.dir });
    const events: Array<{ seq: number; kind: string; beeId: string | null; payload: Record<string, unknown> }> = [];
    client.onEvent = frame => {
      assert.equal(frame.type, "delta");
      if (frame.type === "delta") events.push(...frame.events);
    };
    await client.request("watch", {});
    const params = { beeId, body: "generated mail", idempotencyKey: "mail-wake" };
    const sent = await client.request<SendRpcResult>("send", params);
    await waitFor(() => events.some(row => row.kind === "mail.enqueued"), "committed mail push", 1500);
    const enqueued = events.filter(row => row.kind === "mail.enqueued");
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0]!.beeId, beeId);
    assert.equal((enqueued[0]!.payload.message as { id: number }).id, sent.messageId);
    const replay = await client.request<SendRpcResult>("send", params);
    assert.equal(replay.messageId, sent.messageId);
    assert.equal(replay.commandId, sent.commandId);
    assert.equal(events.filter(row => row.kind === "mail.enqueued").length, 1);
    for (const verb of ["question.answer", "question.dismiss"] as const) {
      const { question } = await client.request<{ question: { id: string } }>("question.ask", { beeId, text: `Generated ${verb}` });
      await client.request(verb, { questionId: question.id, ...(verb === "question.answer" ? { answer: "Generated answer" } : {}), idempotencyKey: verb });
      const count = verb === "question.answer" ? 2 : 3;
      await waitFor(() => events.filter(row => row.kind === "mail.enqueued").length === count, `${verb} mail push`, 1500);
    }
  } finally {
    client?.close();
    await daemon.shutdown({ preserveRuntimes: false });
    rig.cleanup();
  }
});
