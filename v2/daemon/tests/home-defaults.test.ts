import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import {
  atomicWriteFileSync,
  CLAUDE_HOME_DEFAULT_MODEL,
  CLAUDE_HOME_DEFAULT_OUTPUT_STYLE,
  withClaudeSettingsDefaults,
} from "../src/homeDefaults.ts";

test("claude settings defaults seed Concise outputStyle when absent", () => {
  const next = JSON.parse(withClaudeSettingsDefaults(`{\n  "model": "opus"\n}`)) as Record<string, unknown>;
  assert.equal(next.model, "opus", "explicit model is left alone");
  assert.equal(next.skipDangerousModePermissionPrompt, true);
  assert.equal(next.outputStyle, CLAUDE_HOME_DEFAULT_OUTPUT_STYLE);
});

test("claude settings defaults do not clobber an explicit outputStyle", () => {
  const next = JSON.parse(
    withClaudeSettingsDefaults(`{\n  "outputStyle": "Explanatory",\n  "theme": "dark"\n}`),
  ) as Record<string, unknown>;
  assert.equal(next.outputStyle, "Explanatory");
  assert.equal(next.theme, "dark");
  assert.equal(next.model, CLAUDE_HOME_DEFAULT_MODEL);
});

test("empty claude settings get the hive model and Concise outputStyle", () => {
  const next = JSON.parse(withClaudeSettingsDefaults("")) as Record<string, unknown>;
  assert.equal(next.model, CLAUDE_HOME_DEFAULT_MODEL);
  assert.equal(next.outputStyle, CLAUDE_HOME_DEFAULT_OUTPUT_STYLE);
  assert.equal(next.skipDangerousModePermissionPrompt, true);
});

test("atomic publication tolerates a stale timestamp temporary file and repeated writes in the same millisecond", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hive-atomic-"));
  try {
    const path = join(root, "auth.json");
    const at = Date.now();
    t.mock.method(Date, "now", () => at);
    const stale = `${path}.tmp.${process.pid}.${at}`;
    writeFileSync(stale, "interrupted write", { mode: 0o600 });
    for (let i = 0; i < 20; i++) atomicWriteFileSync(path, String(i));
    assert.equal(readFileSync(path, "utf8"), "19");
    assert.equal(readFileSync(stale, "utf8"), "interrupted write");
    assert.equal(readdirSync(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
