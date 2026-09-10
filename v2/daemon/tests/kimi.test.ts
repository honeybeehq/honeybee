import { test } from "node:test";
import assert from "node:assert/strict";
import { composeSpawn } from "../src/daemon.ts";
import { BUILTIN_AGENTS } from "../src/config.ts";

test("Kimi launches native ACP and configures model/mode before accepting mail", () => {
  const spec = BUILTIN_AGENTS.kimi;
  assert.ok(spec, "Kimi must have a native built-in, not a benchmark override");
  const plan = composeSpawn(spec, "kimi", { cwd: "/tmp", args: ["--yolo", "--model", "kimi-code/k3"], providerSessionId: null });
  assert.deepEqual(plan.args, ["acp"]);
  const adapter = plan.adapter;
  assert.ok(adapter);
  const initialize = JSON.parse(adapter.bootLines()[0]!);
  const setup = adapter.parseLine(JSON.stringify({ id: initialize.id, result: {} }));
  assert.equal(setup[0]?.kind, "respond");
  if (setup[0]?.kind !== "respond") assert.fail();
  const request = JSON.parse(setup[0].lines[0]!);
  assert.equal(request.method, "session/new");
  let signals = adapter.parseLine(JSON.stringify({ id: request.id, result: { sessionId: "real-session", configOptions: [{ id: "model", currentValue: "kimi-code/old" }, { id: "mode", currentValue: "default" }] } }));
  for (const [configId, value] of [["model", "kimi-code/k3"], ["mode", "yolo"]]) {
    assert.equal(signals.some(s => s.kind === "booted"), false);
    if (signals[0]?.kind !== "respond") assert.fail();
    const config = JSON.parse(signals[0].lines[0]!);
    assert.equal(config.method, "session/set_config_option");
    assert.deepEqual(config.params, { sessionId: "real-session", configId, value });
    signals = adapter.parseLine(JSON.stringify({ id: config.id, result: {} }));
  }
  assert.ok(signals.some(s => s.kind === "booted" && s.sessionId === "real-session"));
  assert.equal(adapter.acceptsMidTurn, false);
});

test("Kimi resume uses the real provider session and failed setup never boots", () => {
  const spec = BUILTIN_AGENTS.kimi;
  assert.ok(spec);
  const { adapter } = composeSpawn(spec, "kimi", { cwd: "/tmp", args: [], providerSessionId: "saved-session" });
  assert.ok(adapter);
  const signals = adapter.parseLine(JSON.stringify({ id: 1, result: { agentCapabilities: { loadSession: true } } }));
  if (signals[0]?.kind !== "respond") assert.fail();
  const setup = JSON.parse(signals[0].lines[0]!);
  assert.equal(setup.method, "session/resume");
  assert.equal(setup.params.sessionId, "saved-session");
  const failure = adapter.parseLine(JSON.stringify({ id: setup.id, error: { message: "Session not found" } }));
  assert.ok(failure.some(s => s.kind === "flag" && s.flag === "spawn_failed"));
  assert.equal(failure.some(s => s.kind === "booted"), false);
});
