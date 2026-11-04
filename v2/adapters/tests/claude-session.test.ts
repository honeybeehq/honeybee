import { test } from "node:test";
import assert from "node:assert/strict";
import { assertClaudeSessionId, ClaudeSessionIdError } from "../src/claudeSession.ts";
import { claudeResumeArgs, claudeForkArgs, parseClaudeLine } from "../src/claude.ts";

const invalid = ["", ".", "..", "../other", "a/b", "a\\b", "--help", "a\nnext", "a\u0000b", "a".repeat(129)];

test("conversation identifiers remain bounded single components", () => {
  for (const id of ["9aa1f08d-1446-4d78-981f-bbec462ba87b", "fixture-session_1.v2"]) {
    assert.doesNotThrow(() => assertClaudeSessionId(id));
    assert.deepEqual(claudeResumeArgs(id), ["--resume", id]);
    assert.deepEqual(claudeForkArgs(id), ["--resume", id, "--fork-session"]);
  }
  for (const id of invalid) {
    assert.throws(() => assertClaudeSessionId(id), ClaudeSessionIdError);
    assert.throws(() => claudeResumeArgs(id), ClaudeSessionIdError);
    assert.throws(() => claudeForkArgs(id), ClaudeSessionIdError);
    const signals = parseClaudeLine(JSON.stringify({type: "system", subtype: "init", session_id: id}));
    assert.equal(signals.some(signal => signal.kind === "booted"), false);
    assert.ok(signals.some(signal => signal.kind === "flag" && signal.flag === "spawn_failed"));
  }
});
