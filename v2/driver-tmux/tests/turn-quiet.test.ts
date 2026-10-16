import { test } from "node:test";
import assert from "node:assert/strict";
import { quietReply } from "../../core/src/quiet.ts";
import { TurnQuiet } from "../src/turn-quiet.ts";

test("quiet matches Apiary suffix semantics, including astral invisibles", () => {
  for (const text of ["<quiet/>", "Done\n<quiet/>\n", "\u200b<quiet/>\u200b", "<quiet/>\u{E0100}", "ok 👍<quiet/>", "<quiet/> <quiet/>", "<quiet/>⠀"]) {
    assert.equal(quietReply(text).quiet, true, JSON.stringify(text));
  }
  for (const text of ["say <quiet/> mid", "hello ❤️", "", " \u200b ", "<quiet/>x", "<QUIET/>"]) {
    assert.equal(quietReply(text).quiet, false, JSON.stringify(text));
  }
});

const codex = (method: string, extra: Record<string, unknown> = {}, threadId = "root") => JSON.stringify({ method, params: { threadId, ...extra } });

test("final assistant text wins; child threads and tool output cannot silence the root", () => {
  const turn = new TurnQuiet("codex");
  turn.pushLine(codex("turn/started", { turn: { id: "one" } }), "root");
  turn.pushLine(codex("item/completed", { item: { type: "agentMessage", id: "a", text: "<quiet/>" } }), "root");
  turn.pushLine(codex("item/completed", { item: { type: "agentMessage", id: "b", text: "Please review" } }), "root");
  turn.pushLine(codex("item/completed", { item: { type: "agentMessage", id: "c", text: "<quiet/>" } }, "child"), "root");
  turn.pushLine(codex("turn/completed", { turn: { id: "one", status: "completed" } }), "root");
  assert.equal(turn.end(), false);
  assert.equal(turn.end(), undefined);
  turn.pushLine(codex("turn/started", { turn: { id: "two" } }), "root");
  turn.pushLine(codex("item/completed", { item: { type: "commandExecution", id: "tool", aggregatedOutput: "<quiet/>" } }), "root");
  assert.equal(turn.end(), undefined);
});

test("Claude assistant final text is classified and reset between turns", () => {
  const turn = new TurnQuiet("claude");
  turn.pushLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done <quiet/>\u{E0100}" }] } }), null);
  turn.pushLine(JSON.stringify({ type: "result", result: "done <quiet/>\u{E0100}" }), null);
  assert.equal(turn.end(), true);
  assert.equal(turn.end(), undefined);
});

test("tmux hook or quiescence cannot classify intermediate transcript text", () => {
  const turn = new TurnQuiet("claude");
  const assistant = (text: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
  turn.pushLine(assistant("intermediate <quiet/>"), null);
  assert.equal(turn.end({ requireTerminal: true }), undefined);
  turn.pushLine(assistant("late final <quiet/>"), null);
  turn.reset();
  assert.equal(turn.end({ requireTerminal: true }), undefined);
  turn.pushLine(assistant("Please review"), null);
  turn.pushLine(JSON.stringify({ type: "result", result: "Please review" }), null);
  assert.equal(turn.end({ requireTerminal: true }), false);
  turn.pushLine(assistant("intermediate"), null);
  assert.equal(turn.end({ requireTerminal: true, finalText: "done <quiet/>\u{E0100}" }), true);
  assert.equal(turn.end({ requireTerminal: true, finalText: "" }), false);
});

test("Claude native sidechain rows cannot replace root final text", () => {
  for (const scope of [{ isSidechain: true }, { parent_tool_use_id: "child-tool" }]) {
    const turn = new TurnQuiet("claude");
    turn.pushLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Please review" }] } }), null);
    turn.pushLine(JSON.stringify({ type: "assistant", ...scope, message: { content: [{ type: "text", text: "sub done <quiet/>" }] } }), null);
    turn.pushLine(JSON.stringify({ type: "result", result: "Please review" }), null);
    assert.equal(turn.end({ requireTerminal: true }), false);
  }
});

test("quiet text followed by failure or interruption stays unclassified", () => {
  const assistant = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done <quiet/>" }] } });
  for (const terminal of [
    { type: "result", is_error: true, result: "failed" },
    { type: "control_response", response: { request_id: "hive-interrupt-1", subtype: "success" } },
  ]) {
    const turn = new TurnQuiet("claude");
    turn.pushLine(assistant, null);
    turn.pushLine(JSON.stringify(terminal), null);
    assert.equal(turn.end({ finalText: "<quiet/>" }), undefined);
  }
  for (const status of ["failed", "interrupted"]) {
    const turn = new TurnQuiet("codex");
    turn.pushLine(codex("turn/started", { turn: { id: "failed-turn" } }), "root");
    turn.pushLine(codex("item/completed", { item: { type: "agentMessage", id: "quiet", text: "<quiet/>" } }), "root");
    turn.pushLine(codex("turn/completed", { turn: { id: "failed-turn", status } }), "root");
    assert.equal(turn.end(), undefined);
  }
  const turn = new TurnQuiet("claude");
  turn.pushLine(assistant, null);
  turn.invalidate();
  assert.equal(turn.end({ finalText: "<quiet/>" }), undefined);
});
