import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { rmSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resumeStatePaths } from "../src/resumeBundles.ts";

test("Codex resume bundles canonicalize home aliases and refuse unsafe rollout paths", () => {
  const root = mkdtempSync(join(tmpdir(), "hb-codex-resume-path-"));
  const home = join(root, "home");
  const alias = join(root, "alias");
  mkdirSync(join(home, "sessions"), {recursive: true});
  mkdirSync(join(home, "archived_sessions"));
  symlinkSync(home, alias);
  const rollout = join(home, "sessions", "rollout.jsonl");
  const archived = join(home, "archived_sessions", "rollout.jsonl");
  const outside = join(root, "outside.jsonl");
  for (const path of [rollout, archived, outside]) writeFileSync(path, "fixture\n");
  const link = join(home, "sessions", "link.jsonl");
  symlinkSync(rollout, link);
  const db = new DatabaseSync(join(home, "state_5.sqlite"));
  db.exec("CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
  const setPath = (path: string) => db.prepare("INSERT INTO threads VALUES('fixture', ?) ON CONFLICT(id) DO UPDATE SET rollout_path=excluded.rollout_path").run(path);
  try {
    const expected = {root: realpathSync(home), paths: [join("sessions", "rollout.jsonl")], stateKey: null};
    setPath(rollout);
    assert.deepEqual(resumeStatePaths("codex", home, root, "fixture"), expected);
    assert.deepEqual(resumeStatePaths("codex", alias, root, "fixture"), expected);
    setPath(join(alias, "sessions", "rollout.jsonl"));
    assert.deepEqual(resumeStatePaths("codex", alias, root, "fixture"), expected);
    for (const path of [archived, outside, link]) {
      setPath(path);
      assert.equal(resumeStatePaths("codex", home, root, "fixture"), null);
      assert.equal(resumeStatePaths("codex", alias, root, "fixture"), null);
    }
    assert.equal(resumeStatePaths("codex", join(root, "missing"), root, "fixture"), null);
  } finally {
    db.close();
    try { rmSync(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 50}); } catch (error) { console.error("owned fixture cleanup failed", error); process.exitCode = 1; }
  }
});
