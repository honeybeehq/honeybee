import assert from "node:assert/strict";
import { createServer } from "node:http";

export const TOOL_COMMAND = [
  "set -eu", "ls", "node --version", "printf 'QUEEN_PATH=%s\\n' \"$PATH\"",
  "git status --short", "printf 'queen-local-fixture\\n' > queen-local-fixture.txt",
  "git add -- queen-local-fixture.txt",
  "git -c user.name=QueenFixture -c user.email=queen@example.invalid -c core.hooksPath=/dev/null commit -m queen-local-fixture",
  "printf 'QUEEN_COMMIT='; git rev-parse HEAD", "printf 'QUEEN_STATUS_BEGIN\\n'; git status --short; printf 'QUEEN_STATUS_END\\n'",
].join("\n");

export function modelReply(harness, body, state) {
  assert.ok(harness === "claude" || harness === "codex");
  if (harness === "claude") {
    assert.ok(Array.isArray(body.messages), "Claude messages must be an array");
    const results = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(item => item.type === "tool_result");
    if (state.turn === 0) {
      assert.ok(body.tools?.some(tool => tool.name === "Bash"), "Claude must advertise Bash");
      state.turn++;
      return { id: "tool_queen", type: "tool_use", name: "Bash", input: { command: TOOL_COMMAND, timeout: 20000 } };
    }
    assert.equal(state.turn, 1, "Unexpected additional model turn");
    const result = results.find(item => item.tool_use_id === "tool_queen");
    assert.ok(result && !result.is_error, "Claude must return a successful matching tool result");
    state.output = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
  } else {
    const input = Array.isArray(body.input) ? body.input : [];
    if (state.turn === 0) {
      const tool = body.tools?.find(tool => ["shell_command", "exec_command"].includes(tool.name));
      assert.ok(tool, "Codex must advertise a supported real shell tool");
      state.turn++;
      return { id: "fc_queen", type: "function_call", call_id: "call_queen", name: tool.name,
        arguments: JSON.stringify(tool.name === "exec_command" ? { cmd: TOOL_COMMAND, yield_time_ms: 10000, max_output_tokens: 4000 } : { command: TOOL_COMMAND, timeout_ms: 20000 }) };
    }
    assert.equal(state.turn, 1, "Unexpected additional model turn");
    const result = input.find(item => item.type === "function_call_output" && item.call_id === "call_queen");
    assert.ok(result, "Codex must return matching shell output");
    state.output = typeof result.output === "string" ? result.output : JSON.stringify(result.output);
  }
  assert.match(state.output, /QUEEN_PATH=/);
  assert.match(state.output, /fixture-sentinel/);
  assert.match(state.output, /v\d+\.\d+\.\d+/);
  assert.match(state.output, /QUEEN_COMMIT=[a-f0-9]{40}/);
  assert.match(state.output, /QUEEN_STATUS_BEGIN\s*QUEEN_STATUS_END/);
  state.turn++;
  return harness === "claude" ? { type: "text", text: "QUEEN_REAL_HARNESS_OK" }
    : { id: "msg_queen", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "QUEEN_REAL_HARNESS_OK", annotations: [] }] };
}

export async function startMock(harness) {
  const state = { turn: 0, requests: [], output: null, failure: null };
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      const url = new URL(request.url, "http://127.0.0.1");
      assert.ok(url.search === "" || harness === "claude" && url.search === "?beta=true");
      assert.ok(url.pathname === (harness === "claude" ? "/v1/messages" : "/v1/responses") || harness === "claude" && url.pathname === "/v1/messages/count_tokens");
      let raw = "";
      for await (const chunk of request) { raw += chunk; assert.ok(Buffer.byteLength(raw) <= 4 * 1024 * 1024, "Mock request exceeds bound"); }
      const body = JSON.parse(raw);
      if (url.pathname === "/v1/messages/count_tokens") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      state.requests.push(body);
      const item = modelReply(harness, body, state);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const emit = (type, value) => response.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
      if (harness === "claude") {
        emit("message_start", { type: "message_start", message: { id: `msg_${state.turn}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
        emit("content_block_start", { type: "content_block_start", index: 0, content_block: item.type === "tool_use" ? { ...item, input: {} } : { type: "text", text: "" } });
        emit("content_block_delta", { type: "content_block_delta", index: 0, delta: item.type === "tool_use" ? { type: "input_json_delta", partial_json: JSON.stringify(item.input) } : { type: "text_delta", text: item.text } });
        emit("content_block_stop", { type: "content_block_stop", index: 0 });
        emit("message_delta", { type: "message_delta", delta: { stop_reason: item.type === "tool_use" ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
        emit("message_stop", { type: "message_stop" });
      } else {
        const envelope = { id: `resp_${state.turn}`, object: "response", model: body.model, output: [], status: "in_progress" };
        emit("response.created", { type: "response.created", response: envelope });
        emit("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: item.type === "function_call" ? { ...item, arguments: "" } : item });
        if (item.type === "function_call") emit("response.function_call_arguments.done", { type: "response.function_call_arguments.done", output_index: 0, item_id: item.id, arguments: item.arguments });
        emit("response.output_item.done", { type: "response.output_item.done", output_index: 0, item });
        emit("response.completed", { type: "response.completed", response: { ...envelope, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      }
      response.end();
    } catch (error) {
      state.failure = String(error);
      if (!response.headersSent) response.writeHead(400);
      response.end("fixture protocol refused");
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { state, url: `http://127.0.0.1:${server.address().port}`, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
