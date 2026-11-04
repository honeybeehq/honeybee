import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, truncateSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DeliveryFiles } from "../src/deliveryFile.ts";

test("rooted reads are bounded regular files with no followed components", () => {
  const root = mkdtempSync(join(tmpdir(), "hb-rooted-file-"));
  const reader = new DeliveryFiles();
  try {
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "file"), "fixture");
    assert.equal(reader.readRegular(root, "nested/file", 64).toString(), "fixture");
    symlinkSync(join(root, "nested"), join(root, "alias"));
    symlinkSync(join(root, "nested", "file"), join(root, "linked"));
    for (const path of ["alias/file", "linked", "../file", "nested"]) assert.throws(() => reader.readRegular(root, path, 64));
    writeFileSync(join(root, "large"), "");
    truncateSync(join(root, "large"), 1024 * 1024);
    assert.throws(() => reader.readRegular(root, "large", 64));
    assert.throws(() => reader.readRegular(root, "nested/file", 0));
    const fifo = spawnSync("mkfifo", [join(root, "fifo")], {timeout: 1000});
    assert.equal(fifo.status, 0);
    const start = performance.now();
    assert.throws(() => reader.readRegular(root, "fifo", 64));
    assert.ok(performance.now() - start < 1000);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
