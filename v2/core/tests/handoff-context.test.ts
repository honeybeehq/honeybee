import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExtractiveHandoffContext, renderHandoffSeed, type ExtractiveHandoffInput } from "../src/handoff.ts";

function input(text: string): ExtractiveHandoffInput {
  return {
    bee: { id: "b", name: "worker", title: null, cwd: "/tmp/work", substrate: "hsr", agent: "codex", args: null, cellId: null },
    target: { agent: "claude", args: null }, instruction: null,
    turns: [{ role: "user", text }], transcriptTruncated: false,
    segments: [], messages: [], seals: [], tasks: [], questions: [], now: 1,
  };
}

test("handoff context preserves newline folding, indentation and Unicode whitespace", () => {
  for (const [text, expected] of [
    ["  first  middle\tlast  ", "first  middle\tlast"],
    ["first\n  second", "first\n  second"],
    ["first \r\n\t \n  second", "first\n  second"],
    ["first\n\nsecond", "first\nsecond"],
    ["first\u00a0\u2028\n\u2000second", "first\n\u2000second"],
    ["first\rsecond\u2029third", "first\rsecond\u2029third"],
    ["\r\n\t \n", ""],
  ]) {
    const context = buildExtractiveHandoffContext(input(text!));
    assert.equal(context.task, expected);
    assert.equal(context.recentTurns[0]?.text, expected);
    const seed = renderHandoffSeed(context, { beeName: "worker", fromAgent: "codex", toAgent: "claude" });
    assert.ok(seed.includes(`## Task\n${expected}`));
    assert.ok(seed.includes(`[user] ${expected}`));
  }
});

test("handoff context retains field bounds after folding whitespace", () => {
  const text = "a".repeat(1_999) + " \n  z";
  const context = buildExtractiveHandoffContext(input(text));
  assert.equal(context.task, "a".repeat(1_999) + "…");
  assert.equal(context.recentTurns[0]?.text, context.task);
  assert.equal(context.recentTurns[0]?.text.length, 2_000);
});

test("handoff context handles long lines without a multi-second CPU stall", () => {
  const text = "start" + " ".repeat(40_000) + "end";
  const source = input(text);
  const started = process.cpuUsage();
  const context = buildExtractiveHandoffContext(source);
  const used = process.cpuUsage(started);
  assert.equal(context.task, text.slice(0, 1_999) + "…");
  assert.equal(context.recentTurns[0]?.text, context.task);
  // A generous regression guard for this input shape, not a normal-workload benchmark.
  assert.ok((used.user + used.system) / 1_000 < 1_000, `context used ${(used.user + used.system) / 1_000} ms CPU`);
});
