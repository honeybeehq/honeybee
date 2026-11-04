import assert from "node:assert/strict";
import { test } from "node:test";
import { modelReply, startMock, TOOL_COMMAND } from "./queen-harness-mocks.mjs";

const output = "fixture-sentinel\nv24.18.0\nQUEEN_PATH=/run/honeybee/bin:/usr/bin:/bin\nQUEEN_COMMIT=" + "a".repeat(40) + "\nQUEEN_STATUS_BEGIN\nQUEEN_STATUS_END\n";
test("Codex receives one advertised shell call and requires actual tool output before final", () => {
  for (const name of ["exec_command", "shell_command"]) {
    const state = { turn: 0 };
    const call = modelReply("codex", { tools: [{ name }] }, state);
    assert.equal(call.name, name);
    const args = JSON.parse(call.arguments);
    assert.equal(args.cmd ?? args.command, TOOL_COMMAND);
    assert.throws(() => modelReply("codex", { input: [] }, state), /matching shell output/);
    const final = modelReply("codex", { input: [{ type: "function_call_output", call_id: "call_queen", output }] }, state);
    assert.equal(final.content[0].text, "QUEEN_REAL_HARNESS_OK");
    assert.equal(state.output, output);
    assert.throws(() => modelReply("codex", {}, state), /additional model turn/);
  }
});
test("Claude receives Bash and refuses missing/error tool results", () => {
  const state = { turn: 0 };
  assert.throws(() => modelReply("claude", { messages: [], tools: [] }, state), /advertise Bash/);
  const call = modelReply("claude", { messages: [], tools: [{ name: "Bash" }] }, state);
  assert.equal(call.input.command, TOOL_COMMAND);
  assert.throws(() => modelReply("claude", { messages: [{ content: [{ type: "tool_result", tool_use_id: "tool_queen", is_error: true, content: output }] }] }, state), /successful matching/);
  const final = modelReply("claude", { messages: [{ content: [{ type: "tool_result", tool_use_id: "tool_queen", content: output }] }] }, state);
  assert.equal(final.text, "QUEEN_REAL_HARNESS_OK");
});
test("mocks own loopback ports, refuse extra routes, and stream tool-use then final", async () => {
  for (const harness of ["codex", "claude"]) {
    const mock = await startMock(harness);
    try {
      assert.match(mock.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      const route = harness === "codex" ? "/v1/responses" : "/v1/messages";
      const post = body => fetch(mock.url + route, { method: "POST", body: JSON.stringify(body) });
      const first = await post(harness === "codex" ? { tools: [{ name: "exec_command" }] } : { model: "fixture", messages: [], tools: [{ name: "Bash" }] });
      assert.equal(first.status, 200);
      assert.match(await first.text(), harness === "codex" ? /function_call/ : /tool_use/);
      const second = await post(harness === "codex" ? { input: [{ type: "function_call_output", call_id: "call_queen", output }] } : { model: "fixture", messages: [{ content: [{ type: "tool_result", tool_use_id: "tool_queen", content: output }] }] });
      assert.equal(second.status, 200);
      assert.match(await second.text(), /QUEEN_REAL_HARNESS_OK/);
      assert.equal(mock.state.turn, 2);
      const denied = await fetch(mock.url + "/unexpected", { method: "POST", body: "{}" });
      assert.equal(denied.status, 400);
      assert.ok(mock.state.failure);
    } finally { await mock.close(); }
  }
});
