import assert from "node:assert/strict";
import {test} from "node:test";
import {tmuxCleanupDoctor} from "../src/render.ts";

test("doctor cleanup info does not fail and zero counts produce no text", () => {
  assert.deepEqual(tmuxCleanupDoctor({}), {lines: [], failed: false});
  assert.deepEqual(tmuxCleanupDoctor({tmuxCleanupInformational: 1}), {lines: ["info: tmux_cleanup_socket_gone_unverifiable count=1"], failed: false});
  assert.deepEqual(tmuxCleanupDoctor({tmuxCleanupRetained: 1}), {lines: ["warning: tmux_cleanup_retained count=1"], failed: true});
});
