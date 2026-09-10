import { test } from "node:test";
import assert from "node:assert/strict";
import { kimiAdapter, kimiSpawnPlan } from "../src/kimi.ts";

test("Kimi argv layers choose the final model/mode without forwarding prompt-only flags", () => {
  assert.deepEqual(kimiSpawnPlan(["acp", "--model", "old", "--yolo", "-m", "kimi-code/k3", "--plan"]), { argv: ["acp"], model: "kimi-code/k3", mode: "plan" });
  assert.throws(() => kimiSpawnPlan(["--model"]), /requires a value/);
});
test("Kimi configuration errors cannot acknowledge startup; replay is deterministic", () => {
  const adapter = kimiAdapter({ cwd: "/tmp" });
  for (const id of [1, 2, "kimi:model:session", "kimi:mode:session"]) {
    const line = JSON.stringify({ id, error: { message: "unsupported configuration" } });
    const result = adapter.parseLine(line);
    assert.deepEqual(result, adapter.parseLine(line));
    assert.deepEqual(result.map(s => s.kind), ["flag"]);
  }
});
test("Kimi turn errors set provider flags, success clears them and interrupt cancels the same session", () => {
  const a = kimiAdapter({ cwd: "/tmp" });
  const ctx = { sessionId: "real", messageId: 42, turnActive: false, turnId: null };
  const prompt = JSON.parse(a.encodeMessage("hi", ctx)!);
  assert.equal(prompt.method, "session/prompt");
  const fail = a.parseLine(JSON.stringify({ id: prompt.id, error: { message: "401 unauthorized" } }));
  assert.ok(fail.some(s => s.kind === "flag" && s.flag === "auth_needed" && s.action === "set"));
  assert.equal(fail.at(-1)?.kind, "turn_ended");
  const success = a.parseLine(JSON.stringify({ id: prompt.id, result: { stopReason: "end_turn" } }));
  assert.ok(success.some(s => s.kind === "flag" && s.flag === "auth_needed" && s.action === "clear"));
  assert.equal(JSON.parse(a.encodeInterrupt!(ctx)!).params.sessionId, "real");
});
test("Kimi restricted permission requests cancel, yolo selects an actual allow-once option", () => {
  const line = JSON.stringify({ id: "permission", method: "session/request_permission", params: { options: [{ kind: "reject_once", optionId: "deny" }, { kind: "allow_once", optionId: "approve" }] } });
  for (const mode of ["default", "yolo"] as const) {
    const signal = kimiAdapter({ cwd: "/tmp", mode }).parseLine(line)[0];
    if (signal?.kind !== "respond") assert.fail();
    assert.deepEqual(JSON.parse(signal.lines[0]!).result.outcome, mode === "yolo" ? { outcome: "selected", optionId: "approve" } : { outcome: "cancelled" });
  }
});
