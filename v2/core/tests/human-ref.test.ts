import { referenceReceipt, enrollReferences } from "./human-ref-fixture.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { replayAudit } from "../src/index.ts";
import { harness } from "./helpers.ts";

const input = { name: "worker", agent: "codex", substrate: "hsr", cwd: "/tmp" };

test("human-ref: enrollment backfills once, preserves names/aliases, and reopens for offline issuance", () => {
  const h = harness();
  let store = h.open();
  try {
    const first = store.createBee({ ...input, handle: "CO.9652" }).bee;
    assert.equal(first.human_ref, null);
    assert.equal(store.humanRefIssuer(), null);
    const installationId = store.humanRefInstallationId();
    const enrollment = referenceReceipt(installationId);
    const issuer = { namespace: enrollment.namespace, installationId, authorityId: enrollment.authorityId };
    assert.throws(() => store.enrollHumanRefs(referenceReceipt("00000000-0000-0000-0000-000000000000")), /does not match/);
    assert.equal(store.enrollHumanRefs(enrollment).applied, true);
    assert.equal(store.getBee(first.id)?.human_ref, "CO.9652.k7");
    assert.equal(store.getBee(first.id)?.issuing_namespace, "k7");
    const events = store.auditRows();
    assert.deepEqual(events.find((row) => row.kind === "bee.human_ref")?.payload, {
      beeId: first.id, human_ref: "CO.9652.k7", issuing_namespace: "k7",
    });
    assert.equal(store.enrollHumanRefs(enrollment).applied, false);
    assert.deepEqual(store.auditRows(), events);
    assert.throws(() => store.enrollHumanRefs(referenceReceipt(installationId, "k8")), /immutable enrollment conflict/);
    assert.throws(() => store.enrollHumanRefs({ ...enrollment, authorityId: "another-authority" }), /invalid allocation receipt/);
    store.renameBee(first.id, "new-name");
    store.archiveBee(first.id);
    assert.equal(store.getBee(first.id)?.human_ref, "CO.9652.k7");
    store.close();
    store = h.open(); // No allocator, registry, network, or enrollment options supplied.
    assert.equal(store.humanRefInstallationId(), installationId);
    assert.deepEqual(store.humanRefIssuer(), issuer);
    const next = store.createBee(input).bee;
    assert.equal(next.human_ref, `${next.handle}.k7`);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  } finally { store.close(); h.cleanup(); }
});

test("human-ref: independently enrolled installations can share aliases, imports preserve issuer, deleted references never reuse", () => {
  const a = harness(), b = harness();
  const sa = a.open(), sb = b.open();
  try {
    enrollReferences(sa);
    enrollReferences(sb, "k8");
    const first = sa.createBee({ ...input, handle: "CO.9652" }).bee;
    const second = sb.createBee({ ...input, handle: "CO.9652" }).bee;
    assert.equal(first.human_ref, "CO.9652.k7");
    assert.equal(second.human_ref, "CO.9652.k8");
    const imported = sb.createBee({ ...input, id: first.id, handle: first.handle!, humanRef: first.human_ref!, issuingNamespace: first.issuing_namespace! }).bee;
    assert.equal(imported.human_ref, first.human_ref);
    assert.equal(imported.issuing_namespace, "k7", "destination owner is not the issuer");
    assert.equal(sb.listBees().filter((row) => row.handle === "CO.9652").length, 2);
    sb.deleteBee(imported.id);
    assert.throws(() => sb.createBee({ ...input, handle: "CO.9652", humanRef: "CO.9652.k7", issuingNamespace: "k7" }), /already taken/);
    assert.throws(() => sb.createBee({ ...input, id: imported.id }), /was deleted/);
    sa.deleteBee(first.id);
    assert.throws(() => sa.createBee({ ...input, handle: "co.9652" }), /already taken/);
    assert.notEqual(sa.createBee(input).bee.human_ref, first.human_ref);
  } finally { sa.close(); sb.close(); a.cleanup(); b.cleanup(); }
});

test("human-ref: counter grows past four hex digits and beyond JS integer precision, never wraps", () => {
  const h = harness();
  let store = h.open();
  try {
    store.close();
    const setCounter = (value: string) => {
      const db = new DatabaseSync(h.path);
      db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('handle_sequence:CO',?)").run(value);
      db.close();
    };
    setCounter("65535");
    store = h.open();
    assert.equal(store.createBee(input).bee.handle, "CO.ffff");
    assert.equal(store.createBee(input).bee.handle, "CO.10000");
    store.close();
    setCounter("9007199254740992");
    store = h.open();
    assert.equal(store.createBee(input).bee.handle, "CO.20000000000000");
    assert.equal(store.createBee(input).bee.handle, "CO.20000000000001");
  } finally { store.close(); h.cleanup(); }
});

test("human-ref: v28 migration reserves history and preserves account admissions", () => {
  const h = harness();
  let store = h.open();
  try {
    const account = store.createAccount({ id: "admission-account", harness: "codex", homePath: "/tmp/account", label: "preserved" });
    const admission = store.reserveAccountAdmission({
      id: "admission", requestKey: "admission-key", scope: "codex:provider-accounts", account: account.id,
      operation: "spawn", units: 1, expiresAt: h.now() + 60_000, reconcileAfterGeneration: 0, receipt: { version: 1 },
    });
    const living = store.createBee({ ...input, handle: "CO.9652" }).bee;
    const deleted = store.createBee({ ...input, handle: "CO.0000" }).bee;
    store.deleteBee(deleted.id);
    const oldPretty = store.createBee({ ...input, id: "CO.0002", handle: "CO.0002" }).bee;
    store.deleteBee(oldPretty.id);
    store.close();
    const db = new DatabaseSync(h.path);
    db.exec(`UPDATE audit SET payload = json_remove(payload, '$.bee.handle') WHERE kind = 'bee.created' AND bee_id = 'CO.0002';
      DROP INDEX bees_human_ref;
      ALTER TABLE bees DROP COLUMN human_ref;
      ALTER TABLE bees DROP COLUMN issuing_namespace;
      DROP TABLE bee_reference_claims;
      DROP TABLE bee_handle_reservations;
      DROP TABLE human_ref_issuer;
      DROP TABLE human_ref_registry;
      DROP TABLE human_ref_allocations;
      DROP INDEX bees_handle;
      CREATE UNIQUE INDEX bees_handle ON bees(handle) WHERE handle IS NOT NULL;
      DELETE FROM meta WHERE key LIKE 'handle_sequence:%' OR key = 'human_ref_installation_id';
      UPDATE meta SET value = '28' WHERE key = 'schema_version';`);
    db.close();
    store = h.open();
    assert.equal(store.getBee(living.id)?.human_ref, null);
    assert.equal(store.getBee(living.id)?.handle, "CO.9652");
    assert.deepEqual(store.getAccountAdmission(admission.id), admission, "v28 admission receipts survive the rebase migration");
    assert.equal(store.getAccount(account.id)?.label, "preserved");
    assert.equal(store.humanRefRegistry(), null, "migration does not initialize a registry");
    assert.throws(() => store.createBee({ ...input, handle: "CO.0000" }), /already taken/);
    assert.equal(store.createBee(input).bee.handle, "CO.0001");
    assert.equal(store.createBee(input).bee.handle, "CO.0003", "deleted pre-v10 pretty IDs remain reserved");
    enrollReferences(store);
    assert.equal(store.getBee(living.id)?.human_ref, "CO.9652.k7");
    const installationId = store.humanRefInstallationId();
    const issuer = store.humanRefIssuer();
    const counter = store.createBee(input).bee.handle;
    const seq = store.lastAuditSeq();
    store.close();
    const check = new DatabaseSync(h.path, { readOnly: true });
    assert.equal((check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value, "30");
    assert.equal((check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('human_ref_registry', 'human_ref_allocations', 'human_ref_issuer', 'bee_reference_claims', 'bee_handle_reservations')").get() as { n: number }).n, 5);
    assert.equal((check.prepare("SELECT [unique] AS is_unique FROM pragma_index_list('bees') WHERE name = 'bees_handle'").get() as { is_unique: number }).is_unique, 0);
    check.close();
    store = h.open();
    assert.equal(store.lastAuditSeq(), seq, "reopen does not repeat backfill");
    assert.equal(store.humanRefInstallationId(), installationId);
    assert.deepEqual(store.humanRefIssuer(), issuer);
    assert.equal(store.getBee(living.id)?.human_ref, "CO.9652.k7");
    assert.notEqual(store.createBee(input).bee.handle, counter, "reopen retains the issuance counter");
    assert.throws(() => store.createBee({ ...input, id: deleted.id }), /was deleted/);
    assert.throws(() => store.createBee({ ...input, handle: "CO.0000" }), /already taken/);
  } finally { store.close(); h.cleanup(); }
});

test("human-ref: reverted schema v29 refuses without changing stored state", () => {
  const h = harness(); const store = h.open();
  try {
    const bee = store.createBee(input).bee;
    store.close();
    const db = new DatabaseSync(h.path);
    db.exec("UPDATE meta SET value = '29' WHERE key = 'schema_version'");
    const before = db.prepare("SELECT * FROM audit").all();
    db.close();
    assert.throws(() => h.open(), /schema v29.*7374447d.*restore from backup/);
    const check = new DatabaseSync(h.path, { readOnly: true });
    assert.equal((check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value, "29");
    assert.deepEqual(check.prepare("SELECT * FROM audit").all(), before);
    assert.equal((check.prepare("SELECT id FROM bees").get() as { id: string }).id, bee.id);
    check.close();
  } finally { store.close(); h.cleanup(); }
});

test("human-ref: conflicting imported claims roll back enrollment and every backfill event", () => {
  const h = harness(); const store = h.open();
  try {
    const local = store.createBee({ ...input, handle: "CO.9652" }).bee;
    store.createBee({ ...input, handle: "CO.9652", humanRef: "CO.9652.k7", issuingNamespace: "k7" });
    const events = store.auditRows();
    assert.throws(() => enrollReferences(store), /UNIQUE/);
    assert.equal(store.humanRefIssuer(), null);
    assert.equal(store.getBee(local.id)?.human_ref, null);
    assert.deepEqual(store.auditRows(), events);
  } finally { store.close(); h.cleanup(); }
});

test("human-ref registry: explicit init, durable idempotent reservations, expansion, and independent authority refusal", () => {
  const h = harness(), destination = harness(), other = harness();
  let registry = h.open(); const target = destination.open(), independent = other.open();
  try {
    const installationId = target.humanRefInstallationId();
    assert.equal(registry.humanRefRegistry(), null);
    assert.throws(() => registry.reserveHumanRefNamespace(installationId), /not initialized/);
    const initialized = registry.initHumanRefRegistry();
    assert.equal(initialized.applied, true);
    assert.equal(registry.initHumanRefRegistry().applied, false);
    const receipt = registry.reserveHumanRefNamespace(installationId);
    assert.equal(receipt.namespace, "00");
    assert.equal(registry.humanRefRegistry()?.allocations, 1);
    assert.deepEqual(registry.reserveHumanRefNamespace(installationId), receipt, "lost response retries return the durable receipt");
    assert.equal(target.enrollHumanRefs(receipt).applied, true);
    assert.throws(() => target.enrollHumanRefs({ ...receipt, namespace: "01" }), /invalid allocation receipt signature/);
    independent.initHumanRefRegistry();
    const otherReceipt = independent.reserveHumanRefNamespace(installationId);
    assert.equal(otherReceipt.namespace, receipt.namespace, "independent registries do not claim global uniqueness");
    assert.throws(() => target.enrollHumanRefs(otherReceipt), /immutable enrollment conflict/);
    assert.throws(() => registry.enrollHumanRefs(independent.reserveHumanRefNamespace(registry.humanRefInstallationId())), /independent registry authority conflict/);
    assert.throws(() => target.initHumanRefRegistry(), /existing authority/);
    registry.close(); registry = h.open();
    assert.deepEqual(registry.reserveHumanRefNamespace(installationId), receipt);
    assert.equal(registry.humanRefRegistry()?.authorityId, initialized.registry.authorityId);
    registry.close();
    const db = new DatabaseSync(h.path);
    db.exec("UPDATE human_ref_registry SET next_value = '1295'");
    db.close(); registry = h.open();
    assert.equal(registry.reserveHumanRefNamespace("00000000-0000-0000-0000-000000000001").namespace, "zz");
    assert.equal(registry.reserveHumanRefNamespace("00000000-0000-0000-0000-000000000002").namespace, "100");
    // No registration or allocation event pollutes the bee watch stream.
    assert.deepEqual(registry.auditRows(), []);
  } finally { registry.close(); target.close(); independent.close(); h.cleanup(); destination.cleanup(); other.cleanup(); }
});

test("human-ref: missing installation identity in a migrated store refuses to re-issue", () => {
  const h = harness(); const store = h.open();
  try {
    store.close();
    const db = new DatabaseSync(h.path);
    db.exec("DELETE FROM meta WHERE key = 'human_ref_installation_id'");
    db.close();
    assert.throws(() => h.open(), /identity is missing or corrupt/);
  } finally { store.close(); h.cleanup(); }
});

test("human-ref migration: deleted UUIDs without handles and all spellings of reused legacy IDs remain reserved", () => {
  const h = harness(); let store = h.open();
  try {
    const deleted = store.createBee(input).bee;
    const reused = store.createBee({ ...input, handle: "CO.beef" }).bee;
    store.deleteBee(deleted.id); store.deleteBee(reused.id); store.close();
    const db = new DatabaseSync(h.path);
    // Shape genuine old audit history: no handle before v10, and an older
    // creation for the same UUID under a different human alias.
    db.prepare("UPDATE audit SET payload = json_remove(payload, '$.bee.handle') WHERE kind = 'bee.created' AND bee_id = ?").run(deleted.id);
    db.prepare("UPDATE audit SET payload = json_set(payload, '$.bee.handle', 'CO.cafe') WHERE kind = 'bee.created' AND bee_id = ?").run(reused.id);
    db.prepare("INSERT INTO audit(ts, kind, bee_id, payload) VALUES(0, 'bee.created', ?, ?)").run(reused.id, JSON.stringify({ bee: reused }));
    db.exec("DELETE FROM bee_reference_claims; DELETE FROM bee_handle_reservations; UPDATE meta SET value = '27' WHERE key = 'schema_version'");
    db.close(); store = h.open();
    assert.throws(() => store.createBee({ ...input, id: deleted.id }), /was deleted/);
    assert.throws(() => store.createBee({ ...input, id: reused.id }), /was deleted/);
    assert.throws(() => store.createBee({ ...input, handle: "CO.cafe" }), /already taken/);
    assert.throws(() => store.createBee({ ...input, handle: "CO.beef" }), /already taken/);
  } finally { store.close(); h.cleanup(); }
});

test("human-ref migration: reserve live and deleted pretty IDs before v9 handle backfill regardless of row order", () => {
  const h = harness(); let store = h.open();
  try {
    const first = store.createBee(input).bee;
    store.createBee({ ...input, id: "CO.0000", handle: "CO.0002" });
    store.createBee({ ...input, id: "CO.0001", handle: "CO.0001" });
    store.deleteBee("CO.0001"); store.close();
    const db = new DatabaseSync(h.path);
    db.exec(`UPDATE bees SET handle = NULL;
      UPDATE audit SET payload = json_remove(payload, '$.bee.handle') WHERE kind = 'bee.created';
      DELETE FROM bee_reference_claims; DELETE FROM bee_handle_reservations;
      DELETE FROM meta WHERE key LIKE 'handle_sequence:%';
      UPDATE meta SET value = '9' WHERE key = 'schema_version';`);
    db.close(); store = h.open();
    assert.equal(store.getBee("CO.0000")?.handle, "CO.0000", "live pretty ID preserved");
    assert.equal(store.getBee(first.id)?.handle, "CO.0002", "new handle skips both live and deleted pretty IDs");
    assert.throws(() => store.createBee({ ...input, handle: "CO.0001" }), /already taken/);
  } finally { store.close(); h.cleanup(); }
});
