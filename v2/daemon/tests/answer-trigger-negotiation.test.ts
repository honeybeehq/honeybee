import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { RpcServer } from "../src/rpc.ts";
import { RpcClient } from "../../cli/src/client.ts";
import { currentRpcCaller } from "../../core/src/rpcAuditContext.ts";
import { ANSWER_TRIGGER_RESULTS, projectAnswerTriggerResult, projectAnswerTriggerDelta } from "../src/answerTriggerProjection.ts";
import type { AuditRow } from "../../core/src/index.ts";
import type { ViewResult, WatchFrame } from "../src/protocol.ts";
import { waitFor } from "./helpers.ts";
import { harness, makeBee, bootToRunning } from "../../core/tests/helpers.ts";
import { replayAudit } from "../../core/src/index.ts";

test("answer trigger negotiation: simultaneous legacy and capable sockets get independent formats", async () => {
  const dir = mkdtempSync(join(tmpdir(), "answer-format-"));
  const trigger = Object.freeze({ kind: "answer", from: "rpc", messageId: 7, generation: 1, startedAt: 10, humanAt: 10, endedAt: 20 });
  const bee = Object.freeze({ lastTurnTrigger: trigger });
  const result = Object.freeze({ bee });
  const events: AuditRow[] = [{ seq: 2, ts: 10, kind: "mail.delivered", beeId: "bee", payload: Object.freeze({ turnTrigger: trigger }) }];
  const callers: unknown[] = [];
  const diagnostics: string[] = [];
  const server = new RpcServer({ socketPath: join(dir, "rpc.sock"), dataDir: dir, log: (line) => diagnostics.push(line), dispatch: (verb, _params, conn) => {
    callers.push(currentRpcCaller());
    if (verb === "watch") { conn.subscribeWatch(1); return { seq: 1, views: [result] }; }
    if (verb === "snapshot") { conn.alignWatch(2); return { seq: 2, views: [result] }; }
    if (verb === "list") return { views: [result] };
    if (verb === "bee.children") return { children: [result] };
    if (verb === "audit.tail") return { rows: events };
    return verb === "view" ? result : Promise.resolve(result);
  } });
  const clients: RpcClient[] = [];
  try {
    await server.listen();
    const old = await RpcClient.connect(join(dir, "rpc.sock")); clients.push(old);
    const modern = await RpcClient.connect(join(dir, "rpc.sock"), 3000, undefined, { capabilities: ["turn-trigger.answer.v1"] }); clients.push(modern);
    assert.ok(modern.capabilities.includes("turn-trigger.answer.v1"));
    assert.equal((await old.request<ViewResult>("view")).bee!.lastTurnTrigger!.kind, "human");
    assert.equal((await modern.request<ViewResult>("view")).bee!.lastTurnTrigger!.kind, "answer");
    assert.equal((await old.request<ViewResult>("bee.setArgs")).bee!.lastTurnTrigger!.kind, "human");
    assert.equal((await modern.request<ViewResult>("bee.setArgs")).bee!.lastTurnTrigger!.kind, "answer");
    assert.deepEqual(callers[0], callers[1]);
    assert.deepEqual(callers[2], callers[3]);
    const unknown = await RpcClient.connect(join(dir, "rpc.sock"), 3000, undefined, { capabilities: ["unknown-format.v1"] }); clients.push(unknown);
    assert.equal((await unknown.request<ViewResult>("view", { capabilities: ["turn-trigger.answer.v1"] })).bee!.lastTurnTrigger!.kind, "human");
    const oldFrames: WatchFrame[] = [], newFrames: WatchFrame[] = [];
    old.onEvent = (f) => oldFrames.push(f); modern.onEvent = (f) => newFrames.push(f);
    const oldInitial = await old.request<{ views: ViewResult[] }>("watch");
    const newInitial = await modern.request<{ views: ViewResult[] }>("watch");
    assert.equal(oldInitial.views[0]!.bee!.lastTurnTrigger!.kind, "human");
    assert.equal(newInitial.views[0]!.bee!.lastTurnTrigger!.kind, "answer");
    server.flushWatch(2, () => events, 10);
    await waitFor(() => oldFrames.length > 0 && newFrames.length > 0, "both subscriber deltas");
    assert.equal(oldFrames[0]!.type, "delta"); assert.equal(newFrames[0]!.type, "delta");
    if (oldFrames[0]!.type === "delta" && newFrames[0]!.type === "delta") {
      assert.equal((oldFrames[0]!.events[0]!.payload.turnTrigger as { kind: string }).kind, "human");
      assert.equal((newFrames[0]!.events[0]!.payload.turnTrigger as { kind: string }).kind, "answer");
      assert.deepEqual(oldFrames[0], JSON.parse(JSON.stringify(newFrames[0]).replace('"kind":"answer"', '"kind":"human"')));
    }
    assert.equal(trigger.kind, "answer");
    assert.equal(events[0]!.payload.turnTrigger, trigger);
    for (const verb of ["snapshot", "list", "bee.children", "audit.tail"] as const) {
      const oldResult = await old.request(verb), newResult = await modern.request(verb);
      assert.deepEqual(oldResult, JSON.parse(JSON.stringify(newResult).replaceAll('"kind":"answer"', '"kind":"human"')));
    }
    server.flushWatch(5, () => [...events, { ...events[0]!, seq: 5 }], 1);
    await waitFor(() => oldFrames.length === 2 && newFrames.length === 2, "both subscriber gaps");
    assert.deepEqual(oldFrames[1], { type: "gap", seq: 5 });
    assert.deepEqual(newFrames[1], oldFrames[1]);
    old.close();
    const reconnect = await RpcClient.connect(join(dir, "rpc.sock")); clients.push(reconnect);
    const replayed: WatchFrame[] = []; reconnect.onEvent = (frame) => replayed.push(frame);
    await reconnect.request("watch");
    server.flushWatch(2, () => events, 10);
    await waitFor(() => replayed.length === 1, "legacy reconnect replay");
    assert.deepEqual(replayed[0], oldFrames[0]);
    for (const capabilities of [null, "turn-trigger.answer.v1", [42], [""], ["x".repeat(129)], Array(65).fill("x")]) {
      const socket = createConnection(join(dir, "rpc.sock")); socket.setEncoding("utf8");
      const reply = await new Promise<{ ok: boolean; result: ViewResult }>((resolve, reject) => {
        let lines = "", greeted = false;
        socket.on("error", reject);
        socket.on("data", (chunk: string) => {
          lines += chunk;
          for (;;) {
            const newline = lines.indexOf("\n"); if (newline < 0) return;
            const frame = JSON.parse(lines.slice(0, newline)); lines = lines.slice(newline + 1);
            if (!greeted) { greeted = true; socket.write(`${JSON.stringify({ protocol: "v2/1", capabilities })}\n${JSON.stringify({ id: 1, verb: "view", params: {} })}\n`); }
            else resolve(frame);
          }
        });
      });
      assert.equal(reply.ok, true);
      assert.equal(reply.result.bee!.lastTurnTrigger!.kind, "human");
      socket.destroy();
    }
    assert.deepEqual(diagnostics.filter((line) => line.startsWith("rpc.hello.capabilities.invalid")), Array(6).fill("rpc.hello.capabilities.invalid legacy_format"));
  } finally {
    clients.forEach((c) => c.close()); await server.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test("answer wire replay is legacy-compatible while durable audit replay stays canonical", () => {
  const h = harness();
  const store = h.open();
  try {
    const { bee } = makeBee(store);
    bootToRunning(store, bee.id, 7, 7); store.updateRuntimeState(bee.id, 1, "idle");
    const question = store.askQuestion(bee.id, { text: "ready?" });
    const answer = store.answerQuestion(question.id, "yes").send.message;
    store.markDelivered(answer.id, 1, { kind: "human", from: "operator" });
    const canonical = store.auditRows();
    const legacy = projectAnswerTriggerResult("audit.tail", { rows: canonical }, []) as { rows: AuditRow[] };
    const modern = projectAnswerTriggerResult("audit.tail", { rows: canonical }, ["turn-trigger.answer.v1"]) as { rows: AuditRow[] };
    const state = store.dumpState();
    assert.deepEqual(replayAudit(modern.rows), state);
    assert.deepEqual(replayAudit(legacy.rows), { ...state, bees: state.bees.map((row) => ({ ...row, lastTurnTrigger: { ...row.lastTurnTrigger!, kind: "human" } })) });
    assert.equal(store.getBee(bee.id)!.lastTurnTrigger!.kind, "answer");
    assert.equal(modern.rows, canonical);
  } finally { store.close(); h.cleanup(); }
});

test("answer egress projection preserves canonical objects and arbitrary outputs at every covered path", () => {
  const trigger = Object.freeze({ kind: "answer", from: "rpc", messageId: 7, generation: 1, startedAt: 10, humanAt: 10, endedAt: 20 });
  const bee = Object.freeze({ lastTurnTrigger: trigger });
  const business = Object.freeze({ lastTurnTrigger: trigger, turnTrigger: trigger });
  const events = Object.freeze([
    Object.freeze({ kind: "bee.created", payload: Object.freeze({ bee }) }),
    Object.freeze({ kind: "runtime.updated", payload: Object.freeze({ turnTrigger: trigger }) }),
    Object.freeze({ kind: "mail.delivered", payload: Object.freeze({ turnTrigger: trigger }) }),
    Object.freeze({ kind: "action.put", payload: Object.freeze({ action: Object.freeze({ outputs: business }) }) }),
  ]);
  const result = Object.freeze({ bee, views: Object.freeze([{ bee }]), children: Object.freeze([{ bee }]), rows: events, outputs: business });
  for (const coverage of Object.values(ANSWER_TRIGGER_RESULTS)) for (const verb of coverage.verbs) {
    const projected = projectAnswerTriggerResult(verb, result, []);
    assert.equal(projectAnswerTriggerResult(verb, result, ["turn-trigger.answer.v1"]), result);
    assert.equal((projected as typeof result).outputs, business);
    assert.equal(projectAnswerTriggerResult(verb, projected, []), projected);
    assert.match(JSON.stringify(projected), /"kind":"human"/);
  }
  const delta = Object.freeze({ type: "delta", seq: 3, baseSeq: 1, events });
  assert.equal(projectAnswerTriggerDelta(delta, ["turn-trigger.answer.v1"]), delta);
  const old = projectAnswerTriggerDelta(delta, []) as typeof delta;
  assert.equal(old.events[3], events[3]);
  assert.equal(trigger.kind, "answer");
  assert.equal(bee.lastTurnTrigger, trigger);
  assert.equal(projectAnswerTriggerResult("action.complete", result, []), result);
});
