import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openCoreStore } from "../src/index.ts";
import { canonicalDigest } from "../../../src/comb/canonical.ts";
import { parseUpdateReservation } from "../../../src/updateReservation.ts";
import { parseDurableUpdateReservation, type ApiarySwapAcquire, type ApiarySwapReservation } from "../../../src/apiarySwap.ts";

const hash = (character: string) => `sha256:${character.repeat(64)}`;
const identity = { component: "honeybee" as const, version: "0.0.1", sourceRevision: "a".repeat(40), target: `${process.platform}-${process.arch}`, artifact: { url: "https://example.test/honeybee.tgz", sha256: hash("a") } };
function acquire(root: string, expectedEpoch = 0): ApiarySwapAcquire {
  const component = { protocol: "apiary/1", buildId: "previous", version: "1.0.0", target: identity.target, artifact: { url: "https://example.test/apiary.tgz", sha256: hash("b") } };
  const previous = { app: component, resident: component };
  const candidate = { app: { ...component, buildId: "candidate", version: "1.0.1", artifact: { ...component.artifact, sha256: hash("c") } }, resident: component };
  const transaction = { version: 1 as const, purpose: "apiary-swap" as const, scope: { node: hostname(), appRoot: join(root, "app"), runtimeRoot: join(root, "runtime"), storePath: join(root, "v2", "core.sqlite3") }, previous, candidate, rollback: previous, expectedHoneybeeIdentity: identity };
  return { purpose: "apiary-swap", id: "swap-a", expectedEpoch, transactionDigest: canonicalDigest(transaction), expectedHoneybeeIdentity: identity, transaction };
}
function token(held: ApiarySwapReservation) {
  return { purpose: held.purpose, id: held.id, epoch: held.epoch, transactionDigest: held.transactionDigest, expectedHoneybeeIdentity: held.expectedHoneybeeIdentity };
}
function release(held: ApiarySwapReservation, outcome: "succeeded" | "rolled-back" = "succeeded") {
  return { ...token(held), completionReceipt: { ...token(held), version: 1 as const, journalDigest: hash("d"), outcome, policy: "restored" as const } };
}
async function world(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "hb-s4-"));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("apiary reservation: durable owner, exact replay, release, abandon, recovery epoch and v1 exclusion", async () => {
  await world(async root => {
    await mkdir(join(root, "v2"));
    let store = openCoreStore(join(root, "v2", "core.sqlite3"), { ephemeral: true });
    try {
      const request = acquire(root), held = store.acquireApiarySwap(request);
      assert.deepEqual(store.acquireApiarySwap(request), held);
      assert.throws(() => store.reserveUpdate({ id: "paired", expectedEpoch: held.epoch, recoverySubjectDigest: hash("f") }), /Corrupt/);
      assert.throws(() => store.releaseUpdate({ id: held.id, epoch: held.epoch, recoverySubjectDigest: hash("f") }), /Corrupt/);
      assert.throws(() => parseUpdateReservation(held), /Corrupt/);
      store.close(); store = openCoreStore(join(root, "v2", "core.sqlite3"), { ephemeral: true });
      assert.deepEqual(store.durableUpdateReservation(), held);
      const completed = store.settleApiarySwap(release(held), "release");
      assert.deepEqual(store.settleApiarySwap(release(held), "release"), completed);
      assert.throws(() => store.settleApiarySwap(release(held, "rolled-back"), "release"), /resolution differs/);
      const second = store.acquireApiarySwap({ ...request, id: "swap-b", expectedEpoch: held.epoch });
      assert.throws(() => store.settleApiarySwap(release(held), "release"), /mismatch/);
      const abandon = { ...token(second), cancellationReceipt: { ...token(second), version: 1, journalDigest: hash("e"), outcome: "abandoned", phase: "acquired", policy: "unchanged" } };
      assert.deepEqual(store.settleApiarySwap(abandon, "abandon"), store.settleApiarySwap(abandon, "abandon"));
      const third = store.acquireApiarySwap({ ...request, id: "swap-c", expectedEpoch: second.epoch });
      const recovery = { purpose: third.purpose, id: third.id, expectedEpoch: third.epoch, transactionDigest: third.transactionDigest, expectedHoneybeeIdentity: third.expectedHoneybeeIdentity, recoveryId: "recovery-a", recoveryReceipt: { ...token(third), version: 1, journalDigest: hash("e"), outcome: "recovered", policy: "restored", coordinator: "fenced", generations: "reconciled" } };
      const recovered = store.recoverApiarySwap(recovery);
      assert.equal(recovered.epoch, third.epoch + 1); assert.equal(recovered.active, false);
      assert.deepEqual(store.recoverApiarySwap(recovery), recovered);
      assert.throws(() => store.settleApiarySwap(release(third), "release"), /mismatch/);
      const fourth = store.acquireApiarySwap({ ...request, id: "swap-d", expectedEpoch: recovered.epoch });
      assert.throws(() => store.recoverApiarySwap(recovery), /mismatch/);
      assert.equal(fourth.epoch, recovered.epoch + 1);
    } finally { store.close(); }
  });
});

test("apiary reservation: closed transaction/receipt binding refuses corruption and ambiguous cancellation", async () => {
  await world(async root => {
    await mkdir(join(root, "v2"));
    const store = openCoreStore(join(root, "v2", "core.sqlite3"), { ephemeral: true });
    try {
      const request = acquire(root), held = store.acquireApiarySwap(request);
      for (const mutation of [ { ...request, purpose: "unknown" }, { ...request, transactionDigest: hash("f") }, { ...request, expectedEpoch: -1 }, { ...request, transaction: { ...request.transaction, version: 2 } }, { ...request, transaction: { ...request.transaction, rollback: request.transaction.candidate } } ]) assert.throws(() => store.acquireApiarySwap(mutation));
      assert.throws(() => parseDurableUpdateReservation({ ...held, recoverySubjectDigest: hash("f") }), /unknown/);
      assert.throws(() => store.settleApiarySwap({ ...release(held), completionReceipt: null }, "release"));
      assert.throws(() => store.settleApiarySwap({ ...token(held), cancellationReceipt: { ...release(held).completionReceipt, outcome: "abandoned", phase: "suppressed", policy: "unchanged" } }, "abandon"));
      assert.throws(() => store.recoverApiarySwap({ ...token(held), expectedEpoch: held.epoch, recoveryId: "bad", recoveryReceipt: { ...release(held).completionReceipt, outcome: "recovered" } }));
      assert.deepEqual(store.durableUpdateReservation(), held);
    } finally { store.close(); }
  });
});

const phases = ["acquired", "suppressed", "app-exited", "resident-stopped", "lock-converted", "generation-swapped", "ready", "relaunch-receipt", "policy-restored"];
test("apiary reservation: coordinator crash at every S4 boundary stays held across reopen without expiry", async () => {
  await world(async root => {
    await mkdir(join(root, "v2"));
    for (const phase of phases) {
      const path = join(root, "v2", `${phase}.sqlite3`);
      let store = openCoreStore(path, { ephemeral: true });
      const held = store.acquireApiarySwap(acquire(root));
      store.close(); store = openCoreStore(path, { ephemeral: true });
      try {
        assert.deepEqual(store.durableUpdateReservation(), held, phase);
        assert.throws(() => store.settleApiarySwap({ ...token(held), completionReceipt: undefined }, "release"));
        assert.throws(() => store.acquireApiarySwap({ ...acquire(root), id: "other" }), /epoch|reserved/);
      } finally { store.close(); }
    }
  });
});

async function seed(root: string) {
  await mkdir(join(root, "v2"), { recursive: true });
  const store = openCoreStore(join(root, "v2", "core.sqlite3"), { ephemeral: true });
  try { return store.acquireApiarySwap(acquire(root)); } finally { store.close(); }
}
test("apiary schema: current 44 remains unchanged and newer storage refuses", async () => {
  await world(async root => {
    await seed(root);
    const db = new DatabaseSync(join(root, "v2", "core.sqlite3"));
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value, "44");
    db.exec("UPDATE meta SET value='999' WHERE key='schema_version'"); db.close();
    assert.throws(() => openCoreStore(join(root, "v2", "core.sqlite3"), { ephemeral: true }), /newer store/);
  });
});

