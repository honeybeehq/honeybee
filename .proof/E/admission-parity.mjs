import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
const root = mkdtempSync(join(process.env.TMPDIR, "admission-parity-"));
const proof = resolve(".proof/E");
for (const mode of ["targeted", "full-roster"]) {
  const receipt = join(root, mode + ".json");
  const env = { ...process.env, HIVE_ADMISSION_BATCH_RECEIPT: receipt,
    NODE_OPTIONS: `--import=${resolve(".proof/B/trash-cleanup.mjs")}` + (mode === "full-roster" ? ` --import=${join(proof, "admission-main-activity-hook.mjs")}` : "") };
  const log = execFileSync(process.execPath, ["--test", "v2/daemon/tests/accounts-admission-batch.test.ts"], { env, encoding: "utf8", maxBuffer: 4000000 });
  writeFileSync(join(proof, `admission-parity-${mode}.log`), log);
  writeFileSync(join(proof, `admission-parity-${mode}.json`), readFileSync(receipt));
}
const targeted = JSON.parse(readFileSync(join(proof, "admission-parity-targeted.json")));
const roster = JSON.parse(readFileSync(join(proof, "admission-parity-full-roster.json")));
assert.ok(targeted.complete && roster.complete && targeted.controlsPassed && roster.controlsPassed);
assert.equal(targeted.samples.length, 40);
for (let i = 0; i < 40; i++) {
  assert.equal(targeted.samples[i].resultHash, roster.samples[i].resultHash);
  assert.equal(targeted.samples[i].effectsHash, roster.samples[i].effectsHash);
  assert.ok(targeted.samples[i].rosterReads <= roster.samples[i].rosterReads);
}
console.log(JSON.stringify({ passed: true, cases: 40, resultAndEffectsParity: true, transferAndRollbackControls: true, targetedReadsDoNotExceedFullRoster: true }));
