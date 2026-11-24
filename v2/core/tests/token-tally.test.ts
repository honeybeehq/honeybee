import { test } from "node:test";
import assert from "node:assert/strict";
import { TokenTallyCounter, beeTokenTotals, parseBeeTokenTotals, parseTokenTally, startTokenTally, tallyEvents, type TallyEvent } from "../src/tokenTally.ts";

const root = { rootThreadId: null };
const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });

test("token tally: claude per-message rows repeat by id and the result row only adds what they missed", () => {
  const counter = new TokenTallyCounter(startTokenTally());
  // Two content-block lines of one API message carry the same usage; the second line's output grew.
  counter.push([{ kind: "turn_start" }, { kind: "message" }], root);
  counter.push([{ kind: "token_usage", scope: "turn", providerTurnId: "msg_1", model: "claude-opus-5-5", usage: usage(10, 5, 1000, 50) }], root);
  counter.push([{ kind: "token_usage", scope: "turn", providerTurnId: "msg_1", model: "claude-opus-5-5", usage: usage(10, 20, 1000, 50) }], root);
  counter.push([{ kind: "token_usage", scope: "turn", providerTurnId: "msg_2", model: "claude-opus-5-5", usage: usage(3, 30, 1100, 0) }], root);
  // The turn total (sum over the turn) supersedes: 13/50/2100/50 counted already, the result says 13/60/2100/50.
  counter.push([{ kind: "token_usage", scope: "turn", usage: usage(13, 60, 2100, 50) }, { kind: "turn_end" }], root);
  let totals = beeTokenTotals(counter.snapshot());
  assert.deepEqual(totals, { tokens: usage(13, 60, 2100, 50), turns: 1, lastModel: "claude-opus-5-5" });

  // A second turn without per-message rows counts its result in full.
  counter.push([{ kind: "token_usage", scope: "turn", usage: usage(1, 2, 3, 4) }, { kind: "turn_end" }], root);
  totals = beeTokenTotals(counter.snapshot());
  assert.deepEqual(totals, { tokens: usage(14, 62, 2103, 54), turns: 2, lastModel: "claude-opus-5-5" });
});

test("token tally: a result row smaller than its per-message rows adds nothing", () => {
  const tally = tallyEvents(startTokenTally(), [
    { kind: "token_usage", scope: "turn", providerTurnId: "m1", usage: usage(100, 100, 100, 100) },
    { kind: "token_usage", scope: "turn", usage: usage(50, 50, 50, 50) },
    { kind: "turn_end" },
  ], root);
  assert.deepEqual(tally.tokens, usage(100, 100, 100, 100));
});

test("token tally: codex cumulative totals count increases per thread; a lower total is a reset; turn rows of that thread are not added again", () => {
  const ctx = { rootThreadId: "thr-root" };
  const events: TallyEvent[] = [
    { kind: "turn_start", threadId: "thr-root" },
    { kind: "token_usage", scope: "cumulative", threadId: "thr-root", model: "gpt-5.5", usage: usage(100, 10, 400) },
    { kind: "token_usage", scope: "cumulative", threadId: "thr-root", model: "gpt-5.5", usage: usage(150, 30, 900) },
    // a sub-agent thread has its own running total and its turns are not the bee's
    { kind: "token_usage", scope: "cumulative", threadId: "thr-sub", usage: usage(7, 7, 7) },
    { kind: "turn_end", threadId: "thr-sub" },
    // turn/completed may carry the same turn's usage: the cumulative stream already counted it
    { kind: "turn_end", threadId: "thr-root" },
    { kind: "token_usage", scope: "turn", threadId: "thr-root", providerTurnId: "turn-1", usage: usage(150, 30, 900) },
  ];
  let tally = tallyEvents(startTokenTally(), events, ctx);
  assert.deepEqual(beeTokenTotals(tally), { tokens: usage(157, 37, 907), turns: 1, lastModel: "gpt-5.5" });
  // A new process restarts the thread total below the last one: counted in full, never subtracted.
  tally = tallyEvents(tally, [{ kind: "token_usage", scope: "cumulative", threadId: "thr-root", usage: usage(20, 5, 0) }], ctx);
  assert.deepEqual(tally.tokens, usage(177, 42, 907));
  // Rollout logs carry a thread-less cumulative total.
  const rollout = tallyEvents(startTokenTally(), [
    { kind: "token_usage", scope: "cumulative", usage: usage(10, 1) },
    { kind: "token_usage", scope: "cumulative", usage: usage(25, 4) },
  ], root);
  assert.deepEqual(rollout.tokens, usage(25, 4));
});

test("token tally: claude sidechain turns are not bee turns, but their tokens are billed and counted", () => {
  const tally = tallyEvents(startTokenTally(), [
    { kind: "token_usage", scope: "turn", providerTurnId: "side-1", threadId: "sidechain:a", parentThreadId: "root", usage: usage(5, 5) },
    { kind: "turn_end", threadId: "sidechain:a", parentThreadId: "root" },
  ], root);
  assert.equal(tally.turns, 0);
  assert.deepEqual(tally.tokens, usage(5, 5));
});

test("token tally: the model is the most recent usage's model; usage without one keeps it; nothing seen is null", () => {
  let tally = tallyEvents(startTokenTally(), [{ kind: "turn_end" }], root);
  assert.deepEqual(beeTokenTotals(tally), { tokens: usage(0, 0), turns: 1, lastModel: null });
  tally = tallyEvents(tally, [
    { kind: "token_usage", scope: "turn", providerTurnId: "a", model: "m-1", usage: usage(1, 1) },
    { kind: "token_usage", scope: "turn", providerTurnId: "b", model: "m-2", usage: usage(1, 1) },
    { kind: "token_usage", scope: "turn", providerTurnId: "c", usage: usage(1, 1) },
  ], root);
  assert.equal(tally.lastModel, "m-2");
});

test("token tally: dedupe state stays bounded and survives a JSON round trip", () => {
  const counter = new TokenTallyCounter(startTokenTally());
  for (let i = 0; i < 2000; i += 1) counter.push([{ kind: "token_usage", scope: "turn", providerTurnId: `m${i}`, usage: usage(1, 1) }], root);
  const snap = counter.snapshot();
  assert.equal(snap.seen.length, 512);
  assert.equal(snap.seen.at(-1)![0], "m1999");
  assert.deepEqual(snap.tokens, usage(2000, 2000));
  const restored = parseTokenTally(JSON.parse(JSON.stringify(snap)));
  assert.ok(restored);
  // The newest id is still recognized after the round trip.
  const again = tallyEvents(restored, [{ kind: "token_usage", scope: "turn", providerTurnId: "m1999", usage: usage(1, 1) }], root);
  assert.deepEqual(again.tokens, usage(2000, 2000));
});

test("token tally: malformed state is unknown, never zeros; ignores negative and fractional counts", () => {
  assert.equal(parseTokenTally(null), null);
  assert.equal(parseTokenTally({ version: 2 }), null);
  assert.equal(parseTokenTally({ ...startTokenTally(), tokens: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 } }), null);
  assert.equal(parseBeeTokenTotals({ tokens: usage(1, 1), turns: "3", lastModel: null }), null);
  assert.deepEqual(parseBeeTokenTotals({ tokens: usage(1, 2, 3, 4), turns: 3, lastModel: "m", extra: 1 }), { tokens: usage(1, 2, 3, 4), turns: 3, lastModel: "m" });
  const tally = tallyEvents(startTokenTally(), [{ kind: "token_usage", scope: "turn", usage: { input: -5, output: 2.7 } }], root);
  assert.deepEqual(tally.tokens, usage(0, 2));
});
