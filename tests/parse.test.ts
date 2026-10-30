import assert from "node:assert/strict";
import { test } from "node:test";
import { BOOLEAN_FLAGS, flag, numberFlag, parse, truthy } from "../src/parse.js";
import { RemovedFlagError, refuseRemovedTrackFlags } from "../src/commands/removedFlags.js";

test("parse separates command args flags and passthrough rest", () => {
  const parsed = parse(["run", "claude", "--cwd", "/tmp/work", "-p", "hello", "--", "--model", "sonnet"]);

  assert.equal(parsed.command, "run");
  assert.deepEqual(parsed.args, ["claude"]);
  assert.equal(flag(parsed, "cwd"), "/tmp/work");
  assert.equal(flag(parsed, "p"), "hello");
  assert.deepEqual(parsed.rest, ["--model", "sonnet"]);
});

test("parse preserves repeated flags and numeric fallbacks", () => {
  const parsed = parse(["wait", "CO.abc", "--n=5", "--tag", "one", "--tag", "two"]);

  assert.equal(numberFlag(parsed, ["n"], 0), 5);
  assert.deepEqual(flag(parsed, "tag"), ["one", "two"]);
  assert.equal(numberFlag(parsed, ["missing"], 10), 10);
});

test("parse leaves positional args after boolean flags", () => {
  const short = parse(["tail", "-f", "CO.6e2"]);
  assert.equal(flag(short, "f"), true);
  assert.deepEqual(short.args, ["CO.6e2"]);

  const long = parse(["tail", "--follow", "CO.6e2"]);
  assert.equal(flag(long, "follow"), true);
  assert.deepEqual(long.args, ["CO.6e2"]);

  const archived = parse(["list", "--archived", "colony:frontend"]);
  assert.equal(flag(archived, "archived"), true);
  assert.deepEqual(archived.args, ["colony:frontend"]);
});

test("--comb consumes a registry name for comb filters and attached spawn/x commands", () => {
  for (const argv of [
    ["comb", "runs", "--comb", "human-last"],
    ["spawn", "codex", "--comb", "human-last"],
    ["x", "codex", "do work", "--comb", "human-last"],
  ]) {
    const parsed = parse(argv);
    assert.equal(flag(parsed, "comb"), "human-last");
  }
});

test("removed --track flags are refused with a typed error instead of being swallowed", () => {
  for (const argv of [
    ["spawn", "codex", "--track", "release"],
    ["spawn", "codex", "--track-version", "2"],
    ["x", "codex", "do work", "--track", "release", "--track-prompt"],
  ]) {
    const parsed = parse(argv);
    assert.throws(() => refuseRemovedTrackFlags(parsed, parsed.command), (err: unknown) => err instanceof RemovedFlagError && err.message.includes("--track") && err.message.includes("removed with tracks"));
  }
  assert.doesNotThrow(() => refuseRemovedTrackFlags(parse(["spawn", "codex", "--name", "track"]), "spawn"));
});

test("BOOLEAN_FLAGS is exported so completion can skip value-less flags", () => {
  assert.ok(BOOLEAN_FLAGS.has("json"));
  assert.ok(BOOLEAN_FLAGS.has("yolo"));
  assert.ok(BOOLEAN_FLAGS.has("f"));
  assert.ok(!BOOLEAN_FLAGS.has("cwd"));
});

test("truthy accepts explicit opt-in values only", () => {
  assert.equal(truthy(true), true);
  assert.equal(truthy("1"), true);
  assert.equal(truthy("yes"), true);
  assert.equal(truthy("false"), false);
  assert.equal(truthy(undefined), false);
});

test("deploy skip-tests keeps the revision positional in either flag order", () => {
  const sha = "a".repeat(40);
  for (const argv of [["deploy", "--skip-tests", sha], ["deploy", sha, "--skip-tests"]]) {
    const parsed = parse(argv);
    assert.deepEqual(parsed.args, [sha]);
    assert.equal(flag(parsed, "skip-tests"), true);
  }
});
