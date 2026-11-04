import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThreadOperationRow } from "../../core/src/threadOperation.ts";
import { codexHistoryPath, pinThreadHistory, readThreadHistory, seedSuccessorHistory, sourceBaseInstructions, ThreadExecutionError } from "../src/threadHistory.ts";

function trash(path: string): void {
  const destination = join(tmpdir(), "honeybee-test-trash");
  mkdirSync(destination, { recursive: true });
  renameSync(path, join(destination, path.split("/").at(-1)!));
}

test("indexed Codex rollouts stay beneath the expected sessions root without symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "hb-history-safe-"));
  const home = join(root, "home");
  const sessions = join(home, "sessions");
  mkdirSync(sessions, { recursive: true });
  const content = JSON.stringify({ type: "session_meta", payload: { id: "session", model_provider: "fixture" } }) + "\n";
  const rollout = join(sessions, "rollout.jsonl");
  writeFileSync(rollout, content);
  writeFileSync(join(root, "foreign.jsonl"), content);
  const db = new DatabaseSync(join(home, "state_5.sqlite"));
  db.exec("CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
  const setPath = (path: string): void => { db.prepare("INSERT INTO threads VALUES('session', ?) ON CONFLICT(id) DO UPDATE SET rollout_path=excluded.rollout_path").run(path); };
  try {
    setPath(rollout);
    const indexed = codexHistoryPath(home, "session");
    assert.equal(indexed.path, realpathSync(rollout));
    assert.equal(pinThreadHistory(indexed.path, "session", indexed.root).bytes, Buffer.byteLength(content));
    symlinkSync(join(root, "foreign.jsonl"), join(sessions, "link.jsonl"));
    symlinkSync(root, join(sessions, "alias"));
    for (const path of [join(root, "foreign.jsonl"), "relative.jsonl", join(sessions, "link.jsonl"), join(sessions, "alias", "foreign.jsonl")]) {
      setPath(path);
      assert.throws(() => codexHistoryPath(home, "session"), /beneath its sessions root without symlinks/);
    }
    assert.throws(() => pinThreadHistory(join(sessions, "link.jsonl"), "session", indexed.root));
    assert.throws(() => pinThreadHistory(join(root, "foreign.jsonl"), "session", indexed.root), /ownership changed/);
    const fifo = join(sessions, "fifo");
    execFileSync("mkfifo", [fifo]);
    setPath(fifo);
    assert.throws(() => codexHistoryPath(home, "session"), /regular file beneath/);
    assert.throws(() => pinThreadHistory(fifo, "session", indexed.root), /not a file/);
    const directory = join(sessions, "directory");
    mkdirSync(directory);
    setPath(directory);
    assert.throws(() => codexHistoryPath(home, "session"), /regular file beneath/);
    renameSync(sessions, join(home, "saved-sessions"));
    mkdirSync(sessions);
    writeFileSync(rollout, content);
    assert.throws(() => pinThreadHistory(indexed.path, "session", indexed.root), /ownership changed/);
    renameSync(sessions, join(home, "replacement-sessions"));
    symlinkSync(join(home, "saved-sessions"), sessions);
    setPath(rollout);
    assert.throws(() => codexHistoryPath(home, "session"), /without symlinks/);
  } finally { db.close(); trash(root); }
});

test("inherited history reads reject symlinks, FIFOs, directories, truncation and invalid byte windows", async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-history-page-"));
  const path = join(root, "history.jsonl");
  writeFileSync(path, "fixture\n");
  const row = { transcriptReady: true, historyPath: path, source: { bytes: 8 } } as ThreadOperationRow;
  try {
    const page = await readThreadHistory(row, 0, 4, root);
    assert.equal(Buffer.from(page.data, "base64").toString(), "fixt");
    for (const [offset, limit] of [[-1, 4], [9, 4], [0, 0], [0, 1048577]]) {
      await assert.rejects(readThreadHistory(row, offset!, limit!, root), /Invalid transcript byte window/);
    }
    symlinkSync(path, join(root, "link"));
    await assert.rejects(readThreadHistory({ ...row, historyPath: join(root, "link") }, 0, 4, root));
    const fifo = join(root, "fifo");
    execFileSync("mkfifo", [fifo]);
    for (const candidate of [fifo, root]) {
      await assert.rejects(readThreadHistory({ ...row, historyPath: candidate }, 0, 4, root), error => error instanceof ThreadExecutionError && error.code === "history_unavailable");
    }
    for (const candidate of [fifo, root, join(root, "link")]) {
      await assert.rejects(seedSuccessorHistory({ ...row, historyPath: candidate }));
      await assert.rejects(sourceBaseInstructions({ ...row, historyPath: candidate }));
    }
    await assert.rejects(readThreadHistory(row, 0, 4, join(root, "absent")));
    writeFileSync(path, "short");
    await assert.rejects(readThreadHistory(row, 0, 4, root), /owned regular file/);
  } finally { trash(root); }
});
