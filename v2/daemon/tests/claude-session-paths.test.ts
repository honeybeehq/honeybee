import { test } from "node:test";
import assert from "node:assert/strict";
import { findClaudeTranscript, relocateClaudeSession } from "../src/relocateSession.ts";
import { resumeStatePaths } from "../src/resumeBundles.ts";
import { ClaudeSessionIdError } from "../../adapters/src/claudeSession.ts";

test("invalid conversation identifiers are refused before filesystem access", () => {
  for (const sessionId of ["../other", "a/b", "a\\b", "--option", "a\nnext", "a".repeat(129)]) {
    assert.throws(() => findClaudeTranscript("/not-created", "fixture", sessionId), ClaudeSessionIdError);
    assert.throws(() => relocateClaudeSession({home: "/not-created", sessionId, fromCwd: "/before", toCwd: "/after", moveId: "fixture"}), ClaudeSessionIdError);
    assert.throws(() => resumeStatePaths("claude", "/not-created", "/fixture", sessionId), ClaudeSessionIdError);
  }
});
