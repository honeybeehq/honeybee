import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { EXTERNAL_EXEC_SQL, ExternalExecutions, externalConfig, dispatchValue, dispatchBytes, sha256, bridgeEvent, validateReceipt, type ExternalBinding } from "../src/externalExec.ts";

import { externalFixture, externalReceipt } from "./fixtures/externalExec.ts";

test("external execution is default off and bridge pins cannot be supplied in dispatch", () => {
  assert.deepEqual(externalConfig(undefined), { bridges: {}, workspaces: {} });
  const b = externalFixture();
  assert.throws(() => dispatchValue({ ...b.dispatch, executable: "/bin/sh" }));
  assert.throws(() => externalConfig({ bridges: { test: { ...b.registration, executable: "relative" } }, workspaces: {} }));
  assert.throws(() => dispatchValue({ ...b.dispatch, mode: "live" }));
  assert.throws(() => dispatchValue({ ...b.dispatch, auth: { handle: "credential", claim: null, accountId: null } }));
});

test("external canonical dispatch identity includes newline and ignores object key order", () => {
  const b = externalFixture();
  const reverse = Object.fromEntries(Object.entries(b.dispatch).reverse());
  assert.equal(dispatchBytes(dispatchValue(reverse)), dispatchBytes(b.dispatch));
  assert.ok(dispatchBytes(b.dispatch).endsWith("\n"));
  const unicode = dispatchValue({ ...b.dispatch, requested: { model: "model-ø-😀", effort: "low" } });
  assert.ok(dispatchBytes(unicode).includes("model-\\u00f8-\\ud83d\\ude00"));
  assert.notEqual(sha256(dispatchBytes(b.dispatch)), sha256(dispatchBytes(b.dispatch).trimEnd()));
});

test("external receipt and each invocation sequence are attempt, fence, dispatch and install bound", () => {
  const b = externalFixture(), receipt = externalReceipt(b);
  assert.equal(validateReceipt(receipt, b).status, "failed");
  for (const key of ["attemptId", "fencingTokenSha256", "dispatchManifestSha256", "installManifestSha256"]) assert.throws(() => validateReceipt({ ...receipt, [key]: "wrong" }, b));
  const event = { schema: "urbench.bridge.event.v1", type: "terminal", seq: 1, attemptId: b.dispatch.attemptId, fencingTokenSha256: sha256(b.dispatch.fencingToken), data: receipt };
  assert.equal(bridgeEvent(event, b, 1).type, "terminal");
  assert.throws(() => bridgeEvent(event, b, 2));
  assert.throws(() => bridgeEvent({ ...event, data: { ...receipt, secret: b.dispatch.fencingToken } }, b, 1));
});

test("external ownership survives observer reconstruction, refuses attempt reuse and never redispatches", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE bees(id TEXT PRIMARY KEY); INSERT INTO bees VALUES('external-test'),('second')");
    db.exec(EXTERNAL_EXEC_SQL);
    const b = externalFixture(), first = new ExternalExecutions(db);
    first.admit(b);
    assert.equal(first.claimDispatch(b.beeId), "start");
    const recovered = new ExternalExecutions(db);
    assert.equal(recovered.claimDispatch(b.beeId), "reconcile");
    assert.throws(() => recovered.admit({ ...b, beeId: "second" }));
    recovered.settle(b.beeId, externalReceipt(b));
    assert.equal(recovered.view(b.beeId)?.status, "failed");
    assert.doesNotThrow(() => recovered.settle(b.beeId, externalReceipt(b)));
    assert.throws(() => recovered.settle(b.beeId, { ...externalReceipt(b), status: "completed" }));
    assert.ok(!JSON.stringify(recovered.view(b.beeId)).includes(b.dispatch.fencingToken));
    assert.equal(recovered.fail(b.beeId), true);
    assert.equal(recovered.view(b.beeId)?.status, "failed");
    assert.equal(recovered.view(b.beeId)?.observation, "reconcile_required");
    assert.equal(recovered.fail(b.beeId), false);
  } finally { db.close(); }
});

test("external dispatch ownership and terminal evidence survive closing and reopening SQLite", () => {
  const base = join(process.cwd(), ".local", "external-exec-tests");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const file = join(mkdtempSync(join(base, "restart-")), "attempt.sqlite3");
  let db = new DatabaseSync(file);
  const binding = externalFixture();
  db.exec("CREATE TABLE bees(id TEXT PRIMARY KEY); INSERT INTO bees VALUES('external-test')");
  db.exec(EXTERNAL_EXEC_SQL);
  let owner = new ExternalExecutions(db);
  owner.admit(binding);
  assert.equal(owner.claimDispatch(binding.beeId), "start");
  db.close();
  db = new DatabaseSync(file); owner = new ExternalExecutions(db);
  try {
    assert.equal(owner.claimDispatch(binding.beeId), "reconcile");
    owner.settle(binding.beeId, externalReceipt(binding));
    db.close();
    db = new DatabaseSync(file); owner = new ExternalExecutions(db);
    assert.equal(owner.view(binding.beeId)?.status, "failed");
    assert.equal(owner.claimDispatch(binding.beeId), "reconcile");
  } finally { db.close(); }
});
