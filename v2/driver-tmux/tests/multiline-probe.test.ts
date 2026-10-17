import { test } from "node:test";
import assert from "node:assert/strict";
import { MultilinePasteProbe } from "../src/multiline-probe.ts";

test("unsupported version is probed once per server and replacement invalidates the cache", () => {
  let calls = 0;
  const server = { try: () => { calls++; return { status: 0, stdout: "3.5a|%1|\n", stderr: "" }; } };
  const probe = new MultilinePasteProbe();
  assert.equal(probe.refusal(server, "server-a", "%1"), "multiline_bracketed_paste_version_unsupported");
  assert.equal(probe.refusal(server, "server-a", "%2"), "multiline_bracketed_paste_version_unsupported");
  assert.equal(calls, 1);
  assert.equal(probe.refusal(server, "server-b", "%1"), "multiline_bracketed_paste_version_unsupported");
  assert.equal(calls, 2);
});

test("supported version tracks a pane going 0 to 1 and rechecks each pane", () => {
  const replies = ["next|%1|0", "1", "0", "1"];
  const server = { try: () => ({ status: 0, stdout: replies.shift()!, stderr: "" }) };
  const probe = new MultilinePasteProbe();
  assert.equal(probe.refusal(server, "server", "%1"), "multiline_bracketed_paste_disabled");
  assert.equal(probe.refusal(server, "server", "%1"), null);
  assert.equal(probe.refusal(server, "server", "%2"), "multiline_bracketed_paste_disabled");
  assert.equal(probe.refusal(server, "server", "%2"), null);
});

test("failed or wrong-pane probes are not cached as version unsupported", () => {
  for (const reply of [{ status: 1, stdout: "", stderr: "failed" }, { status: 0, stdout: "next|%2|", stderr: "" }, { status: 0, stdout: "next|%1|bad", stderr: "" }]) {
    let calls = 0;
    const server = { try: () => { calls++; return reply; } };
    const probe = new MultilinePasteProbe();
    assert.equal(probe.refusal(server, "server", "%1"), "multiline_bracketed_paste_unknown");
    assert.equal(probe.refusal(server, "server", "%1"), "multiline_bracketed_paste_unknown");
    assert.equal(calls, 2);
  }
});
