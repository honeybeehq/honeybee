import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { RpcServer } from "../src/rpc.ts";
import { RpcClient } from "../../cli/src/client.ts";
import { currentRpcCaller } from "../../core/src/rpcAuditContext.ts";
import { ANSWER_TRIGGER_AUDITS, ANSWER_TRIGGER_RESULTS, projectAnswerTriggerResult, projectAnswerTriggerDelta } from "../src/answerTriggerProjection.ts";
import type { AuditRow } from "../../core/src/index.ts";
import type { ChampionGetResult, ViewResult, WatchFrame } from "../src/protocol.ts";
import { waitFor } from "./helpers.ts";
import { harness, makeBee, bootToRunning } from "../../core/tests/helpers.ts";
import { replayAudit } from "../../core/src/index.ts";

test("answer trigger negotiation: simultaneous legacy and capable sockets get independent formats", async () => {
  const dir = mkdtempSync(join(tmpdir(), "answer-format-"));
  const trigger = Object.freeze({ kind: "answer", from: "rpc", messageId: 7, generation: 1, startedAt: 10, humanAt: 10, endedAt: 20 });
  const pending = Object.freeze({ messageId: 7, generation: 1, humanAt: 10, triggerKind: "answer" });
  const bee = Object.freeze({ lastTurnTrigger: trigger, unansweredHumanMessage: pending });
  const view = Object.freeze({ unansweredHumanMessage: pending });
  const result = Object.freeze({ bee, view });
  const events: AuditRow[] = [{ seq: 2, ts: 10, kind: "mail.delivered", beeId: "bee", payload: Object.freeze({ turnTrigger: trigger, unansweredHumanMessage: pending }) }];
  const callers: unknown[] = [];
  const diagnostics: string[] = [];
  const server = new RpcServer({ socketPath: join(dir, "rpc.sock"), dataDir: dir, log: (line) => diagnostics.push(line), dispatch: (verb, _params, conn) => {
    callers.push(currentRpcCaller());
    if (verb === "watch") { conn.subscribeWatch(1); return { seq: 1, views: [result] }; }
    if (verb === "snapshot") { conn.alignWatch(2); return { seq: 2, views: [result] }; }
    if (verb === "list") return { views: [result] };
    if (verb === "bee.children") return { children: [result] };
    if (verb === "audit.tail") return { rows: events };
    if (verb === "champion.get") return { champion: {}, bee: result, homeObjects: [] };
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
    assert.equal((await old.request<ChampionGetResult>("champion.get")).bee!.bee!.lastTurnTrigger!.kind, "human");
    assert.equal((await modern.request<ChampionGetResult>("champion.get")).bee!.bee!.lastTurnTrigger!.kind, "answer");
    const unknown = await RpcClient.connect(join(dir, "rpc.sock"), 3000, undefined, { capabilities: ["unknown-format.v1"] }); clients.push(unknown);
    assert.equal((await unknown.request<ViewResult>("view", { capabilities: ["turn-trigger.answer.v1"] })).bee!.lastTurnTrigger!.kind, "human");
    const phone = await RpcClient.connect(join(dir, "rpc.sock"), 3000, undefined, { capabilities: [] }); clients.push(phone);
    const phoneView = await phone.request<ViewResult>("view");
    assert.equal(phoneView.bee!.unansweredHumanMessage!.triggerKind, "human");
    assert.equal(phoneView.view.unansweredHumanMessage!.triggerKind, "human");
    const phoneList = await phone.request<{ views: ViewResult[] }>("list");
    assert.equal(phoneList.views[0]!.bee!.unansweredHumanMessage!.triggerKind, "human");
    assert.equal(phoneList.views[0]!.view.unansweredHumanMessage!.triggerKind, "human");
    const phoneFrames: WatchFrame[] = []; phone.onEvent = frame => phoneFrames.push(frame);
    const phoneInitial = await phone.request<{ views: ViewResult[] }>("watch");
    assert.equal(phoneInitial.views[0]!.bee!.unansweredHumanMessage!.triggerKind, "human");
    assert.equal(phoneInitial.views[0]!.view.unansweredHumanMessage!.triggerKind, "human");
    for (const value of [phoneView, phoneList, phoneInitial]) assert.doesNotMatch(JSON.stringify(value), /"(?:kind|triggerKind)":"answer"/);
    const oldFrames: WatchFrame[] = [], newFrames: WatchFrame[] = [];
    old.onEvent = (f) => oldFrames.push(f); modern.onEvent = (f) => newFrames.push(f);
    const oldInitial = await old.request<{ views: ViewResult[] }>("watch");
    const newInitial = await modern.request<{ views: ViewResult[] }>("watch");
    assert.equal(oldInitial.views[0]!.bee!.lastTurnTrigger!.kind, "human");
    assert.equal(newInitial.views[0]!.bee!.lastTurnTrigger!.kind, "answer");
    server.flushWatch(2, () => events, 10);
    await waitFor(() => oldFrames.length > 0 && newFrames.length > 0 && phoneFrames.length > 0, "legacy, modern and phone subscriber deltas");
    assert.doesNotMatch(JSON.stringify(phoneFrames[0]), /"(?:kind|triggerKind)":"answer"/);
    if (phoneFrames[0]!.type === "delta") assert.equal((phoneFrames[0]!.events[0]!.payload.unansweredHumanMessage as { triggerKind: string }).triggerKind, "human");
    assert.equal(oldFrames[0]!.type, "delta"); assert.equal(newFrames[0]!.type, "delta");
    if (oldFrames[0]!.type === "delta" && newFrames[0]!.type === "delta") {
      assert.equal((oldFrames[0]!.events[0]!.payload.turnTrigger as { kind: string }).kind, "human");
      assert.equal((newFrames[0]!.events[0]!.payload.turnTrigger as { kind: string }).kind, "answer");
      assert.deepEqual(oldFrames[0], JSON.parse(JSON.stringify(newFrames[0]).replaceAll('"kind":"answer"', '"kind":"human"').replaceAll('"triggerKind":"answer"', '"triggerKind":"human"')));
    }
    assert.equal(trigger.kind, "answer");
    assert.equal(pending.triggerKind, "answer");
    assert.equal(events[0]!.payload.turnTrigger, trigger);
    for (const verb of ["snapshot", "list", "bee.children", "audit.tail"] as const) {
      const oldResult = await old.request(verb), newResult = await modern.request(verb);
      assert.deepEqual(oldResult, JSON.parse(JSON.stringify(newResult).replaceAll('"kind":"answer"', '"kind":"human"').replaceAll('"triggerKind":"answer"', '"triggerKind":"human"')));
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
            if (!greeted) { greeted = true; socket.write(`${JSON.stringify({ protocol: "v2/2", capabilities })}\n${JSON.stringify({ id: 1, verb: "view", params: {} })}\n`); }
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
    store.setHumanOutputMode(bee.id, "explicit", "mode");
    const older = store.send(bee.id, "older human", { senderKind: "human" }).message;
    store.markDelivered(older.id, 1, { kind: "human", from: "operator" });
    store.updateRuntimeState(bee.id, 1, "running"); store.updateRuntimeState(bee.id, 1, "idle");
    const question = store.askQuestion(bee.id, { text: "ready?" });
    const answer = store.answerQuestion(question.id, "yes").send.message;
    store.markDelivered(answer.id, 1, { kind: "human", from: "operator" });
    store.reactHuman({ beeId: bee.id, messageId: older.id, emoji: "👍", idempotencyKey: "older" });
    store.tellHuman({ beeId: bee.id, text: "older acknowledged", replyTo: older.id, idempotencyKey: "older" });
    assert.equal(store.view(bee.id).unansweredHumanMessage!.triggerKind, "answer");
    const canonical = store.auditRows();
    const legacy = projectAnswerTriggerResult("audit.tail", { rows: canonical }, []) as { rows: AuditRow[] };
    const modern = projectAnswerTriggerResult("audit.tail", { rows: canonical }, ["turn-trigger.answer.v1"]) as { rows: AuditRow[] };
    const state = store.dumpState();
    assert.deepEqual(replayAudit(modern.rows), state);
    assert.deepEqual(replayAudit(legacy.rows), {
      ...state,
      bees: state.bees.map(row => ({ ...row, lastTurnTrigger: { ...row.lastTurnTrigger!, kind: "human" }, unansweredHumanMessage: { ...row.unansweredHumanMessage!, triggerKind: "human" } })),
      tells: state.tells!.map(row => ({ ...row, turnTrigger: { ...row.turnTrigger!, kind: "human" } })),
      reactions: state.reactions!.map(row => ({ ...row, turnTrigger: { ...row.turnTrigger!, kind: "human" } })),
    });
    assert.equal(store.getBee(bee.id)!.lastTurnTrigger!.kind, "answer");
    assert.equal(modern.rows, canonical);
  } finally { store.close(); h.cleanup(); }
});

test("answer egress projection preserves canonical objects and arbitrary outputs at every covered path", () => {
  const trigger = Object.freeze({ kind: "answer", from: "rpc", messageId: 7, generation: 1, startedAt: 10, humanAt: 10, endedAt: 20 });
  const pending = Object.freeze({ messageId: 7, generation: 1, humanAt: 10, triggerKind: "answer" });
  const row = Object.freeze({ lastTurnTrigger: trigger, unansweredHumanMessage: pending });
  const view = Object.freeze({ unansweredHumanMessage: pending });
  const bee = Object.freeze({ ...row, bee: row, view });
  const business = Object.freeze({ lastTurnTrigger: trigger, turnTrigger: trigger });
  const tell = Object.freeze({ turnTrigger: trigger });
  const reaction = Object.freeze({ turnTrigger: trigger });
  const events = Object.freeze([
    Object.freeze({ kind: "bee.created", payload: Object.freeze({ bee }) }),
    Object.freeze({ kind: "runtime.updated", payload: Object.freeze({ turnTrigger: trigger }) }),
    Object.freeze({ kind: "mail.delivered", payload: Object.freeze({ turnTrigger: trigger, unansweredHumanMessage: pending }) }),
    Object.freeze({ kind: "action.put", payload: Object.freeze({ action: Object.freeze({ outputs: business }) }) }),
    Object.freeze({ kind: "bee.told", payload: Object.freeze({ tell, unansweredHumanMessage: pending }) }),
    Object.freeze({ kind: "bee.reacted", payload: Object.freeze({ reaction, unansweredHumanMessage: pending }) }),
    Object.freeze({ kind: "bee.human_output_mode_changed", payload: Object.freeze({ unansweredHumanMessage: pending }) }),
  ]);
  const result = Object.freeze({ bee, view, unansweredHumanMessage: pending, views: Object.freeze([{ bee, view }]), children: Object.freeze([{ bee, view }]), rows: events, outputs: business, tell, reaction, tells: Object.freeze([tell]), reactions: Object.freeze([reaction]) });
  const valuesAt = (value: unknown, path: string): unknown[] => path.split(".").reduce<unknown[]>((items, part) => items.flatMap(item => {
    const next = item !== null && typeof item === "object" ? (item as Record<string, unknown>)[part.replace(/\[\]$/, "")] : undefined;
    return part.endsWith("[]") ? Array.isArray(next) ? next : [] : [next];
  }), [value]);
  const assertHuman = (value: unknown, path: string) => {
    const values = valuesAt(value, path); assert.ok(values.length > 0, `fixture covers ${path}`);
    for (const fact of values) {
      assert.match(JSON.stringify(fact) ?? "", /"(?:kind|triggerKind)":"human"/, path);
      assert.doesNotMatch(JSON.stringify(fact) ?? "", /"(?:kind|triggerKind)":"answer"/, path);
    }
  };
  for (const coverage of Object.values(ANSWER_TRIGGER_RESULTS)) for (const verb of coverage.verbs) {
    const projected = projectAnswerTriggerResult(verb, result, []);
    assert.equal(projectAnswerTriggerResult(verb, result, ["turn-trigger.answer.v1"]), result);
    assert.equal((projected as typeof result).outputs, business);
    assert.equal(projectAnswerTriggerResult(verb, projected, []), projected);
    for (const path of coverage.triggers) assertHuman(projected, path);
    for (const path of coverage.audits) for (const event of valuesAt(projected, path) as { kind: string; payload: unknown }[]) {
      for (const factPath of ANSWER_TRIGGER_AUDITS[event.kind] ?? []) assertHuman(event.payload, factPath);
    }
  }
  const delta = Object.freeze({ type: "delta", seq: 3, baseSeq: 1, events });
  assert.equal(projectAnswerTriggerDelta(delta, ["turn-trigger.answer.v1"]), delta);
  const old = projectAnswerTriggerDelta(delta, []) as typeof delta;
  assert.equal(old.events[3], events[3]);
  for (const event of old.events.slice(4)) assert.match(JSON.stringify(event), /"triggerKind":"human"/);
  for (const [verb, field] of [["bee.tell", "tell"], ["bee.react", "reaction"]] as const) {
    const projected = projectAnswerTriggerResult(verb, result, []) as typeof result;
    assert.equal(projected[field].turnTrigger.kind, "human");
    assert.equal(projected.bee, bee, "unrelated bee data is outside this verb's projection");
    assert.equal(result[field].turnTrigger.kind, "answer");
  }
  const snapshot = projectAnswerTriggerResult("snapshot", result, []) as typeof result;
  assert.equal(snapshot.tells[0]!.turnTrigger.kind, "human");
  assert.equal(snapshot.reactions[0]!.turnTrigger.kind, "human");
  assert.equal(result.tells[0]!.turnTrigger, trigger);
  assert.equal(result.reactions[0]!.turnTrigger, trigger);
  assert.equal(trigger.kind, "answer");
  assert.equal(bee.lastTurnTrigger, trigger);
  assert.equal(projectAnswerTriggerResult("action.complete", result, []), result);
});
