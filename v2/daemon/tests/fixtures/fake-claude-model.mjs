#!/usr/bin/env node
// Minimal `claude -p --input-format stream-json` stand-in for resolved-model
// tests. Like the real CLI it is silent until the first user message, then
// reports the resolved model on system/init and on every assistant message.
// `--model` aliases resolve the way Claude Code does; `@switch <id>` mimics an
// in-harness /model switch.
import { createInterface } from "node:readline";

const ALIASES = { fable: "claude-fable-5-1", opus: "claude-opus-5-5" };
const argv = process.argv.slice(2);
const at = argv.lastIndexOf("--model");
const requested = at >= 0 ? argv[at + 1] : undefined;
// No --model: the account default, reported with the context-window suffix.
let initModel = requested ? (ALIASES[requested] ?? requested) : "claude-opus-5-5[1m]";
let model = initModel.replace(/\[[^\]]*\]$/, "");
const sessionId = "fake-session-1";
let inited = false;
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== "user") return;
  if (!inited) {
    inited = true;
    emit({ type: "system", subtype: "init", session_id: sessionId, model: initModel });
  }
  const text = msg.message?.content?.[0]?.text ?? "";
  const sw = /^@switch (\S+)$/.exec(text);
  if (sw) model = sw[1];
  // A subagent line on another model, and a synthetic error line: neither is the bee's model.
  emit({ type: "assistant", parent_tool_use_id: "toolu_1", message: { model: "claude-haiku-5-5", content: [{ type: "text", text: "sub" }] } });
  emit({ type: "assistant", parent_tool_use_id: null, message: { model, content: [{ type: "text", text: `ok ${text}` }] } });
  emit({ type: "assistant", parent_tool_use_id: null, message: { model: "<synthetic>", content: [{ type: "text", text: "noise" }] } });
  emit({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: sessionId });
});
