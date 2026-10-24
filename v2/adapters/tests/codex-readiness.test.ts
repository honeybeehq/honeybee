import assert from "node:assert/strict";
import {test} from "node:test";
import {codexAdapter} from "../src/codex.ts";

const adapter = codexAdapter({cwd: "/fixture"});
const request = "hive-readiness-123";
const parse = (suffix: string, result: unknown, session: string | null = null) => adapter.parseRecovery!(JSON.stringify({id: `${request}:${suffix}`, result}), request, session);

test("Codex recovery queries live threads before a new handshake", () => {
  assert.equal(JSON.parse(adapter.recoveryProbe!(request)).method, "thread/loaded/list");
  const start = parse("list", {data: [], nextCursor: null});
  assert.equal(start?.kind, "start");
  if (start?.kind !== "start") return;
  const lines = start.lines.map(line => JSON.parse(line));
  assert.deepEqual(lines.map(line => line.method), ["initialized", "thread/start"]);
  assert.equal(lines[1].id, `${request}:start`);
  assert.equal(parse("list", {data: []}, "known")?.kind, "refused");
  for (const opts of [{resumeThreadId: "known"}, {forkThreadId: "known"}]) {
    assert.equal(codexAdapter({cwd: "/fixture", ...opts}).parseRecovery!(JSON.stringify({id: `${request}:list`, result: {data: []}}), request, null)?.kind, "refused");
  }
});

test("Codex recovery refuses ambiguous, mismatched, paged and malformed thread answers", () => {
  for (const result of [{data: ["a", "b"]}, {data: ["a"], nextCursor: "page"}, {data: [null]}, {data: [""]}, {}, null]) assert.equal(parse("list", result)?.kind, "refused");
  assert.equal(parse("list", {data: ["other"]}, "known")?.kind, "refused");
  assert.equal(adapter.parseRecovery!('{"id":"old:list","result":{"data":[]}}', request, null), null);
  assert.equal(adapter.parseRecovery!(JSON.stringify({id: `${request}:list`, error: {code: -32601}}), request, null)?.kind, "refused");
  assert.equal(parse("list", {data: ["known"]}, "known")?.kind, "query");
});

test("Codex live thread state reports authenticated live idle or active evidence", () => {
  const thread = {id: "known", cwd: "/fixture", status: {type: "idle"}};
  assert.deepEqual(parse("read:known", {thread}, "known"), {kind: "ready", sessionId: "known", state: "idle", synthetic: false, threadCwd: "/fixture", adapterCwd: "/fixture"});
  assert.deepEqual(parse("read:known", {thread: {...thread, status: {type: "active"}, turns: [{id: "turn", status: "inProgress"}]}}, "known"), {kind: "ready", sessionId: "known", state: "running", turnId: "turn", synthetic: false, threadCwd: "/fixture", adapterCwd: "/fixture"});
  assert.deepEqual(parse("start", {thread}), {kind: "ready", sessionId: "known", state: "idle", synthetic: false, threadCwd: "/fixture", adapterCwd: "/fixture"});
  for (const patch of [{id: "other"}, {status: {type: "notLoaded"}}, {status: {type: "systemError"}}]) assert.equal(parse("read:known", {thread: {...thread, ...patch}}, "known")?.kind, "refused");
});
