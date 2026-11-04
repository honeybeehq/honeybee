import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, linkSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CellStorageGate } from "../src/inodeGate.ts";
import { scanCellStorage, CellStorageRefused } from "../src/inodeScan.ts";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hb-inode-gate-")));
  const cellsRoot = join(root, "cells"), wrapper = "fixture", wrapperDir = join(cellsRoot, wrapper), spaceDir = join(wrapperDir, "repo-space-fixture");
  mkdirSync(join(spaceDir, ".git", "objects", "info"), {recursive: true});
  return {root, wrapperDir, identity: {cellsRoot, wrapper, spaceDir, sandboxed: true}, close: () => rmSync(root, {recursive: true, force: true})};
}

test("storage scan distinguishes internal links from links outside the wrapper", () => {
  const f = fixture();
  try {
    const file = join(f.identity.spaceDir, "package");
    writeFileSync(file, "own fixture");
    linkSync(file, join(f.wrapperDir, "internal"));
    assert.equal(scanCellStorage(f.identity).files, 2);
    const external = join(f.root, "external");
    linkSync(file, external);
    assert.throws(() => scanCellStorage(f.identity), CellStorageRefused);
    unlinkSync(external);
    assert.doesNotThrow(() => scanCellStorage(f.identity));
    writeFileSync(join(f.identity.spaceDir, ".git", "objects", "info", "alternates"), "");
    assert.throws(() => scanCellStorage(f.identity), /redirected repository/);
  } finally { f.close(); }
});

test("storage gate invalidates cached passes on policy flips and explicit changes", async () => {
  const f = fixture(), gate = new CellStorageGate();
  try {
    const first = await gate.obtainValidatedCellGitIdentity("cell", f.identity);
    assert.equal(first.independentInodes, true);
    assert.equal(gate.isCurrent("cell", first), true);
    const second = await gate.obtainValidatedCellGitIdentity("cell", f.identity);
    assert.equal(second.validationEpoch, first.validationEpoch);
    const file = join(f.identity.spaceDir, ".git", "objects", "fixture");
    writeFileSync(file, "own object fixture");
    linkSync(file, join(f.root, "outside"));
    await gate.obtainValidatedCellGitIdentity("cell", {...f.identity, sandboxed: false});
    assert.equal(gate.isCurrent("cell", first), false);
    await assert.rejects(gate.obtainValidatedCellGitIdentity("cell", f.identity), CellStorageRefused);
    unlinkSync(join(f.root, "outside"));
    gate.invalidate("cell");
    const repaired = await gate.obtainValidatedCellGitIdentity("cell", f.identity);
    assert.equal(repaired.independentInodes, true);
    assert.equal(gate.isCurrent("cell", repaired), true);
  } finally { gate.close(); f.close(); }
});

test("storage bounds refuse with an actionable typed error", async () => {
  const f = fixture(), gate = new CellStorageGate({maxEntries: 2});
  try {
    await assert.rejects(gate.obtainValidatedCellGitIdentity("cell", f.identity), error => error instanceof CellStorageRefused && /re-provision/.test(error.message));
  } finally { gate.close(); f.close(); }
});
