import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProjectKey } from "../../driver-tmux/src/index.ts";
import {
  findClaudeTranscript,
  relocateClaudeSession,
  TranscriptConflictError,
  TranscriptUnavailableError,
} from "../src/relocateSession.ts";

function home(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "hb-relocate-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeSource(h: string, cwd: string, seed: string, body = "src\n", sibling = false): void {
  const key = claudeProjectKey(cwd);
  const dir = join(h, "projects", key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${seed}.jsonl`), body);
  if (sibling) {
    mkdirSync(join(dir, seed), { recursive: true });
    writeFileSync(join(dir, seed, "meta"), "ok");
  }
}

test("relocate: copies jsonl and sibling, then is present on retry", () => {
  const rig = home();
  try {
    writeSource(rig.dir, "/tmp/from", "sid", "hello\n", true);
    const first = relocateClaudeSession({
      home: rig.dir,
      sessionId: "sid",
      fromCwd: "/tmp/from",
      toCwd: "/tmp/to",
      moveId: "m1",
    });
    assert.equal(first, "copied");
    const dest = join(rig.dir, "projects", claudeProjectKey("/tmp/to"));
    assert.equal(readFileSync(join(dest, "sid.jsonl"), "utf8"), "hello\n");
    assert.ok(existsSync(join(dest, "sid", "meta")));
    assert.ok(existsSync(join(dest, ".hive-move-m1")));
    const again = relocateClaudeSession({
      home: rig.dir,
      sessionId: "sid",
      fromCwd: "/tmp/from",
      toCwd: "/tmp/to",
      moveId: "m1",
    });
    assert.equal(again, "present");
  } finally {
    rig.cleanup();
  }
});

test("relocate: crash after jsonl publication without marker recovers", () => {
  const rig = home();
  try {
    writeSource(rig.dir, "/tmp/from", "sid", "hello\n");
    const dest = join(rig.dir, "projects", claudeProjectKey("/tmp/to"));
    const staging = join(dest, ".hive-move-staging-m1");
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, "sid.jsonl"), "hello\n");
    writeFileSync(join(dest, "sid.jsonl"), "hello\n");
    const result = relocateClaudeSession({
      home: rig.dir,
      sessionId: "sid",
      fromCwd: "/tmp/from",
      toCwd: "/tmp/to",
      moveId: "m1",
    });
    assert.equal(result, "present");
    assert.ok(existsSync(join(dest, ".hive-move-m1")));
    assert.equal(existsSync(staging), false);
  } finally {
    rig.cleanup();
  }
});

test("relocate: unrelated dest jsonl without marker is refused", () => {
  const rig = home();
  try {
    writeSource(rig.dir, "/tmp/from", "sid", "hello\n");
    const dest = join(rig.dir, "projects", claudeProjectKey("/tmp/to"));
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "sid.jsonl"), "other\n");
    assert.throws(
      () =>
        relocateClaudeSession({
          home: rig.dir,
          sessionId: "sid",
          fromCwd: "/tmp/from",
          toCwd: "/tmp/to",
          moveId: "m1",
        }),
      TranscriptConflictError,
    );
  } finally {
    rig.cleanup();
  }
});

test("relocate: unrelated dest sibling with no jsonl is refused", () => {
  const rig = home();
  try {
    writeSource(rig.dir, "/tmp/from", "sid", "hello\n", true);
    const dest = join(rig.dir, "projects", claudeProjectKey("/tmp/to"));
    mkdirSync(join(dest, "sid"), { recursive: true });
    writeFileSync(join(dest, "sid", "foreign"), "nope");
    assert.throws(
      () =>
        relocateClaudeSession({
          home: rig.dir,
          sessionId: "sid",
          fromCwd: "/tmp/from",
          toCwd: "/tmp/to",
          moveId: "m1",
        }),
      TranscriptConflictError,
    );
    assert.equal(existsSync(join(dest, "sid.jsonl")), false);
  } finally {
    rig.cleanup();
  }
});

test("relocate: findClaudeTranscript does not scan other project keys", () => {
  const rig = home();
  try {
    writeSource(rig.dir, "/tmp/other", "sid", "stale\n");
    assert.equal(findClaudeTranscript(rig.dir, claudeProjectKey("/tmp/from"), "sid"), null);
    assert.throws(
      () =>
        relocateClaudeSession({
          home: rig.dir,
          sessionId: "sid",
          fromCwd: "/tmp/from",
          toCwd: "/tmp/to",
          moveId: "m1",
        }),
      TranscriptUnavailableError,
    );
  } finally {
    rig.cleanup();
  }
});
