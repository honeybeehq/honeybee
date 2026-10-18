import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupTmuxFixture, TmuxFixtureCleanupError, ownedTmuxEndpointGone } from "./multiline-fallback-cleanup.ts";

test("tmux fixture cleanup always kills the server and preserves a dispose failure", async () => {
  const original = new Error("original dispose failure"), calls: string[] = [];
  await assert.rejects(cleanupTmuxFixture({
    disposeAll: () => {calls.push("dispose"); throw original;},
    killServer: () => {calls.push("kill");},
    serverAndPanesGone: () => {calls.push("gone"); return true;},
    closeStore: () => {calls.push("close");},
    removeRoot: () => {calls.push("remove");},
  }), error => error instanceof TmuxFixtureCleanupError && error.cause === original && error.errors[0] === original);
  assert.deepEqual(calls, ["dispose", "kill", "gone", "close", "remove"]);
});

test("tmux fixture cleanup retains all errors and keeps a live server root", async () => {
  const original = new Error("original dispose failure"), kill = new Error("kill failed"), calls: string[] = [];
  await assert.rejects(cleanupTmuxFixture({
    disposeAll: () => {throw original;},
    killServer: () => {calls.push("kill"); throw kill;},
    serverAndPanesGone: () => false,
    closeStore: () => {calls.push("close");},
    removeRoot: () => {calls.push("remove");},
    timeoutMs: 0,
  }), error => error instanceof TmuxFixtureCleanupError && error.cause === original && error.errors[1] === kill && error.errors[2].message === "tmux_fixture_cleanup_timeout");
  assert.deepEqual(calls, ["kill", "close"]);
});

test("tmux fixture cleanup accepts a proven refused stale socket before removing it", async t => {
  const root = mkdtempSync(join(tmpdir(), "tmux-clean-")), original = join(root, "s"), stale = join(root, "stale");
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {listener.once("error", reject); listener.listen(original, resolve);});
  renameSync(original, stale);
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  assert.equal(existsSync(stale), true);
  await cleanupTmuxFixture({disposeAll: () => {}, killServer: () => {}, serverAndPanesGone: () => ownedTmuxEndpointGone(stale), closeStore: () => {}, removeRoot: () => rmSync(root, {recursive: true, force: true})});
  assert.equal(existsSync(root), false);
});

test("tmux fixture cleanup refuses to unlink a live listening socket", async t => {
  const root = mkdtempSync(join(tmpdir(), "tmux-live-")), path = join(root, "s");
  const listener = createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {listener.once("error", reject); listener.listen(path, resolve);});
  t.after(async () => {await new Promise<void>(resolve => listener.close(() => resolve())); rmSync(root, {recursive: true, force: true});});
  await assert.rejects(cleanupTmuxFixture({disposeAll: () => {}, killServer: () => {}, serverAndPanesGone: () => ownedTmuxEndpointGone(path), closeStore: () => {}, removeRoot: () => rmSync(root, {recursive: true, force: true}), timeoutMs: 0}), error => error instanceof TmuxFixtureCleanupError && error.errors[0].message === "tmux_fixture_cleanup_timeout");
  assert.equal(existsSync(path), true);
});
