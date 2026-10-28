import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { CoreError, replayAudit, SCHEMA_VERSION, type AuditRow, type CreateBeeInput, type SpawnProvenance } from "../src/index.ts";
import { mirrorBeeRow, publicAuditRow, toPublicBee } from "../src/envRedaction.ts";
import { harness } from "./helpers.ts";

const input = { name: "worker", agent: "stub", substrate: "hsr", cwd: "/tmp" };
const peer: SpawnProvenance = { callerBeeId: "caller", authority: "bee", peerPid: 123 };
const service: SpawnProvenance = { callerBeeId: null, authority: "registered_service", peerPid: 456 };
const inconsistent = [
  { ...peer, callerBeeId: null },
  { ...peer, serviceIntent: "service" },
  { ...peer, serviceIntent: "delegation" },
  { ...peer, authority: "unattributed" },
  { ...service, authority: "unattributed", serviceIntent: "service" },
  { ...service, authority: "unattributed", serviceIntent: "delegation" },
  { ...service, callerBeeId: "caller" },
];

test("spawn provenance persists independently of parentage through restart, public rows and audit replay", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  let store = h.open();
  try {
    const parent = store.createBee({ ...input, name: "parent" }).bee;
    const cases: Array<SpawnProvenance | null | undefined> = [peer, service, { ...service, serviceIntent: "service" }, { ...service, serviceIntent: "delegation" }, { callerBeeId: null, authority: "unattributed", peerPid: null }, null, undefined];
    const children = cases.map((spawnProvenance, i) => store.createBee({ ...input, name: `worker-${i}`, parentId: parent.id, spawnProvenance }).bee);
    for (const [i, bee] of children.entries()) {
      const expected = cases[i] ?? null;
      assert.deepEqual(bee.spawnProvenance, expected);
      assert.deepEqual(store.listBees().find(row => row.id === bee.id)?.spawnProvenance, expected);
      assert.deepEqual(mirrorBeeRow(bee)?.spawnProvenance, expected);
      assert.deepEqual(toPublicBee(bee).spawnProvenance, expected);
      const created = store.auditRows().find(row => row.kind === "bee.created" && row.beeId === bee.id)!;
      assert.deepEqual((created.payload.bee as { spawnProvenance: unknown }).spawnProvenance, expected);
      assert.deepEqual(created.payload.spawnProvenance ?? null, expected);
      assert.deepEqual((publicAuditRow(created).payload.bee as { spawnProvenance: unknown }).spawnProvenance, expected);
    }
    store.deleteBee(parent.id);
    for (const bee of children) {
      assert.equal(store.getBee(bee.id)?.parentId, null);
      assert.deepEqual(store.getBee(bee.id)?.spawnProvenance, bee.spawnProvenance);
    }
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
    store = h.open();
    for (const bee of children) assert.deepEqual(store.getBee(bee.id)?.spawnProvenance, bee.spawnProvenance);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
    const db = new DatabaseSync(h.path, { readOnly: true });
    try {
      assert.deepEqual(JSON.parse(String(db.prepare("SELECT spawn_provenance FROM bees WHERE id = ?").get(children[0]!.id)!.spawn_provenance)), peer);
      assert.equal(db.prepare("SELECT spawn_provenance FROM bees WHERE id = ?").get(children.at(-1)!.id)!.spawn_provenance, null);
    } finally { db.close(); }
  } finally { store.close(); }
});

test("spawn provenance rejects malformed creation input atomically", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  try {
    const invalid: unknown[] = [...inconsistent, { ...peer, authority: "operator" }, { ...peer, peerPid: -1 }, { ...peer, peerPid: 1.5 }, { ...peer, peerPid: Number.MAX_SAFE_INTEGER + 1 }, { ...peer, callerBeeId: "" }, { ...peer, callerBeeId: "\ud800" }, { ...peer, callerBeeId: "bad\0id" }, { ...peer, callerBeeId: "x".repeat(257) }, { ...peer, serviceIntent: "unknown" }, { ...peer, extra: true }, { authority: "bee", peerPid: 3 }, [], "bad"];
    const before = store.dumpState();
    const audit = store.auditRows();
    for (const spawnProvenance of invalid) {
      assert.throws(() => store.createBee({ ...input, spawnProvenance } as CreateBeeInput), error => error instanceof CoreError && error.message.includes("spawnProvenance"));
      assert.deepEqual(store.dumpState(), before);
      assert.deepEqual(store.auditRows(), audit);
    }
  } finally { store.close(); }
});

test("legacy creation replay uses only recorded provenance and leaves omitted service intent absent", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  try {
    const bee = store.createBee({ ...input, spawnProvenance: service }).bee;
    const rows = store.auditRows();
    const legacy = rows.map(row => {
      if (row.kind !== "bee.created") return row;
      const { spawnProvenance: _provenance, ...oldBee } = row.payload.bee as Record<string, unknown>;
      return { ...row, payload: { ...row.payload, bee: oldBee } };
    });
    assert.deepEqual(replayAudit(legacy), store.dumpState());
    assert.equal(Object.hasOwn(replayAudit(legacy).bees[0]!.spawnProvenance!, "serviceIntent"), false);
    const missing = legacy.map(row => row.kind === "bee.created" ? { ...row, payload: { bee: row.payload.bee } } : row);
    assert.equal(replayAudit(missing).bees.find(row => row.id === bee.id)?.spawnProvenance, null);
    for (const spawnProvenance of [...inconsistent, { ...service, authority: "invented" }]) {
      const corrupt: AuditRow[] = legacy.map(row => row.kind === "bee.created" ? { ...row, payload: { ...row.payload, spawnProvenance } } : row);
      assert.equal(replayAudit(corrupt).bees[0]?.spawnProvenance, null);
      const nested: AuditRow[] = rows.map(row => row.kind === "bee.created" ? { ...row, payload: { ...row.payload, bee: { ...bee, spawnProvenance } } } : row);
      assert.equal(replayAudit(nested).bees[0]?.spawnProvenance, null);
    }
  } finally { store.close(); }
});

test("schema 51 backfills only validated matching creation audit evidence, without inferring intent or authority", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  let store = h.open();
  const records: Array<{ name: string; provenance?: unknown; nested?: unknown; mismatched?: boolean; duplicate?: boolean; expected: SpawnProvenance | null }> = [
    ...inconsistent.map((provenance, i) => ({ name: `inconsistent-${i}`, provenance, expected: null })),
    { name: "legacy-service", provenance: service, expected: service },
    { name: "delegated", provenance: { ...service, serviceIntent: "delegation" }, expected: { ...service, serviceIntent: "delegation" } },
    { name: "bee", provenance: peer, expected: peer },
    { name: "unattributed", provenance: { callerBeeId: null, authority: "unattributed", peerPid: null }, expected: { callerBeeId: null, authority: "unattributed", peerPid: null } },
    { name: "missing", expected: null },
    { name: "null", provenance: null, expected: null },
    { name: "bad-authority", provenance: { ...service, authority: "operator" }, expected: null },
    { name: "bad-pid", provenance: { ...peer, peerPid: "123" }, expected: null },
    { name: "partial", provenance: { authority: "bee" }, expected: null },
    { name: "bad-intent", provenance: { ...service, serviceIntent: "omitted" }, expected: null },
    { name: "nested-only", nested: service, expected: null },
    { name: "mismatched", provenance: peer, mismatched: true, expected: null },
    { name: "ambiguous", provenance: peer, duplicate: true, expected: null },
  ];
  try {
    const bees = records.map(record => store.createBee({ ...input, name: record.name }).bee);
    store.close();
    const db = new DatabaseSync(h.path);
    try {
      db.exec("ALTER TABLE bees DROP COLUMN spawn_provenance");
      db.prepare("UPDATE meta SET value = '51' WHERE key = 'schema_version'").run();
      for (const [i, record] of records.entries()) {
        const bee = bees[i]!;
        const { spawnProvenance: _dropped, ...legacyBee } = bee;
        const payload = { bee: { ...legacyBee, ...(record.mismatched ? { id: "unrelated" } : {}), ...(record.nested ? { spawnProvenance: record.nested } : {}) }, ...(record.provenance === undefined ? {} : { spawnProvenance: record.provenance }) };
        db.prepare("UPDATE audit SET payload = ? WHERE kind = 'bee.created' AND bee_id = ?").run(JSON.stringify(payload), bee.id);
        if (record.duplicate) db.prepare("INSERT INTO audit(ts, kind, bee_id, payload) VALUES(1, 'bee.created', ?, ?)").run(bee.id, JSON.stringify(payload));
      }
    } finally { db.close(); }
    store = h.open();
    const migratedAudit = store.auditRows();
    for (const [i, record] of records.entries()) assert.deepEqual(store.getBee(bees[i]!.id)?.spawnProvenance, record.expected, record.name);
    assert.equal(Object.hasOwn(store.getBee(bees[records.findIndex(record => record.name === "legacy-service")]!.id)!.spawnProvenance!, "serviceIntent"), false);
    store.close();
    store = h.open();
    assert.deepEqual(store.auditRows(), migratedAudit);
    for (const [i, record] of records.entries()) assert.deepEqual(store.getBee(bees[i]!.id)?.spawnProvenance, record.expected, record.name);
    store.close();
    const check = new DatabaseSync(h.path, { readOnly: true });
    try { assert.equal(check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()!.value, String(SCHEMA_VERSION)); }
    finally { check.close(); }
  } finally { store.close(); }
});


test("durable provenance decoder withholds inconsistent authority claims", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  let store = h.open();
  try {
    const bees = inconsistent.map((_, i) => store.createBee({ ...input, name: `corrupt-${i}`, spawnProvenance: service }).bee);
    store.close();
    const db = new DatabaseSync(h.path);
    try {
      for (const [i, provenance] of inconsistent.entries()) db.prepare("UPDATE bees SET spawn_provenance = ? WHERE id = ?").run(JSON.stringify(provenance), bees[i]!.id);
    } finally { db.close(); }
    store = h.open();
    for (const bee of bees) assert.equal(store.getBee(bee.id)?.spawnProvenance, null);
  } finally { store.close(); }
});
