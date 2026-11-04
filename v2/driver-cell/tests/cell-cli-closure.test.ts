import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { rmSync, mkdirSync, mkdtempSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { cellCliReadOnlyFiles } from "../src/cellScope.ts";

test("Cell CLI closure pins exact regular files and refuses missing, changed or unsafe imports", () => {
  const root = mkdtempSync(join(tmpdir(), "hb-cli-closure-"));
  try {
    assert.throws(() => cellCliReadOnlyFiles(root), /closure/);
    const entry = 'import "./cli-chunk-ABC.js";';
    const chunk = 'export const value = 1;';
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    const manifest: {version: number; entry: string; files: Record<string, {sha256: string; imports: string[]}>} = {version: 1, entry: "cli.js", files: {
      "cli.js": {sha256: hash(entry), imports: ["cli-chunk-ABC.js"]},
      "cli-chunk-ABC.js": {sha256: hash(chunk), imports: [] as string[]},
    }};
    const publish = () => writeFileSync(join(root, "cell-cli-manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(root, "cli.js"), entry);
    publish();
    assert.throws(() => cellCliReadOnlyFiles(root), /closure/);
    writeFileSync(join(root, "cli-chunk-ABC.js"), chunk);
    assert.deepEqual(cellCliReadOnlyFiles(root).map(file => file.destination), ["/run/honeybee/hive.mjs", "/run/honeybee/cli-chunk-ABC.js"]);
    writeFileSync(join(root, "cli-chunk-ABC.js"), "changed");
    assert.throws(() => cellCliReadOnlyFiles(root), /closure/);
    writeFileSync(join(root, "cli-chunk-ABC.js"), chunk);
    manifest.files["cli-chunk-ABC.js"]!.imports = ["../outside.js"];
    publish();
    assert.throws(() => cellCliReadOnlyFiles(root), /closure/);
    manifest.files["cli-chunk-ABC.js"]!.imports = ["cli-chunk-SYMLINK.js"];
    publish();
    manifest.files["cli-chunk-SYMLINK.js"] = {sha256: hash(chunk), imports: []};
    publish();
    symlinkSync(join(root, "cli-chunk-ABC.js"), join(root, "cli-chunk-SYMLINK.js"));
    assert.throws(() => cellCliReadOnlyFiles(root), /closure/);
  } finally {
    try { rmSync(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 50}); } catch (error) { console.error("owned fixture cleanup failed", error); process.exitCode = 1; }
  }
});
