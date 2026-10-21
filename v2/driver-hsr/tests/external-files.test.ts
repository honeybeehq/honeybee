import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, linkSync, closeSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openExternalFile } from "../src/externalFiles.ts";

test("raw capture refuses symlink components, leaf links, hard links and nonprivate destinations", () => {
  const base = join(process.cwd(), ".local", "external-exec-tests");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(base, "files-"));
  const source = join(root, "source"), output = join(root, "output");
  mkdirSync(source, { mode: 0o700 }); mkdirSync(output, { mode: 0o700 });
  writeFileSync(join(source, "stream.raw"), Buffer.from([0, 255, 13, 10]), { mode: 0o600 });
  let fd = openExternalFile(source, "stream.raw", false);
  try { assert.deepEqual(readFileSync(fd), Buffer.from([0, 255, 13, 10])); } finally { closeSync(fd); }
  symlinkSync(source, join(root, "linked-directory"));
  assert.throws(() => openExternalFile(join(root, "linked-directory"), "stream.raw", false));
  symlinkSync(join(source, "stream.raw"), join(output, "leaf"));
  assert.throws(() => openExternalFile(output, "leaf", true));
  linkSync(join(source, "stream.raw"), join(output, "hard"));
  assert.throws(() => openExternalFile(output, "hard", true));
  assert.throws(() => openExternalFile(output, "../outside", true));
  fd = openExternalFile(output, "safe.raw", true); closeSync(fd);
  assert.throws(() => openExternalFile(join(root, "..", "other"), "anything", false));
});
