import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION, type AuditRow } from "../src/index.ts";
import { publicAuditRow, publicBeeResult, publicEnvRecords, toPublicBee } from "../src/envRedaction.ts";
import { harness, makeBee } from "./helpers.ts";

const TOKEN = "fake-h18b-token-DEADBEEF";
const DSN = "postgres://fake-h18b-user:fake-h18b-pass@db.invalid/app";
const RAW_ENV = {
  APIARY_AGENT_TOKEN: TOKEN,
  DATABASE_URL: DSN,
  HIVE_BEE: "worker",
  CODEX_HOME: "/homes/codex-a",
  CLAUDE_CONFIG_DIR: "/homes/claude-a",
  GROK_HOME: "/homes/grok-a",
};
const ENV_KEYS = Object.keys(RAW_ENV).sort();

function auditRow(kind: string, payload: Record<string, unknown>): AuditRow {
  return { seq: 1, ts: 1, kind, beeId: "b1", payload };
}

function tableDigest(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare("SELECT key, verb, command_id, result, created_at FROM rpc_idempotency ORDER BY key").all();
    return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  } finally {
    db.close();
  }
}

function seedStore(path: string, rows: Array<{ key: string; verb: string; commandId: number | null; result: string; createdAt: number }>, version = 39): void {
  const db = new DatabaseSync(path);
  try {
    db.exec("BEGIN");
    const insert = db.prepare("INSERT INTO rpc_idempotency(key, verb, command_id, result, created_at) VALUES(?, ?, ?, ?, ?)");
    for (const row of rows) insert.run(row.key, row.verb, row.commandId, row.result, row.createdAt);
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(version));
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

function storedRows(path: string): Array<{ key: string; verb: string; command_id: number | null; result: string; created_at: number }> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare("SELECT key, verb, command_id, result, created_at FROM rpc_idempotency ORDER BY key").all() as never;
  } finally {
    db.close();
  }
}

function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shapeOf);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, shapeOf(child)]));
  }
  return typeof value;
}

test("public bee and audit projections preserve raw launch data", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = makeBee(store);
    const raw = { ...bee, env: RAW_ENV };
    const projected = toPublicBee(raw);
    assert.deepEqual(projected.envKeys, ENV_KEYS);
    assert.equal("env" in projected, false);
    assert.deepEqual(raw.env, RAW_ENV);
    const event = auditRow("bee.env_set", { env: RAW_ENV, previous: RAW_ENV });
    assert.deepEqual(publicAuditRow(event).payload, { envKeys: ENV_KEYS, previousEnvKeys: ENV_KEYS });
    assert.equal(JSON.stringify(publicAuditRow(event)).includes(DSN), false);
    const template = auditRow("template.put", { template: { env: RAW_ENV } });
    assert.equal(publicAuditRow(template), template);
    assert.deepEqual(publicEnvRecords(projected), projected);
  } finally { h.cleanup(); }
});

test("mirror-env.6: the schema migration redacts stored idempotency results once, in place", () => {
  const h = harness();
  try {
    const first = h.open();
    const { bee } = makeBee(first);
    first.close();
    const rename = { bee: { ...bee, env: { ...RAW_ENV } }, applied: true };
    const spawn = { beeId: bee.id, generation: 1, commandId: 7, messageId: null };
    const template = { template: { id: "t1", env: { API_KEY: TOKEN } }, outcome: "created" };
    seedStore(h.path, [
      { key: "k-rename", verb: "bee.rename", commandId: null, result: JSON.stringify(rename), createdAt: 10 },
      { key: "k-spawn", verb: "spawn", commandId: 7, result: JSON.stringify(spawn), createdAt: 11 },
      { key: "k-template", verb: "template.put", commandId: null, result: JSON.stringify(template), createdAt: 12 },
      { key: "k-corrupt", verb: "bee.tag", commandId: null, result: `{"bee":{"env":{"API_KEY":"${TOKEN}"`, createdAt: 13 },
      { key: "k-clean", verb: "bee.tag", commandId: null, result: JSON.stringify({ bee: { ...bee, env: { CODEX_HOME: "/h" } }, applied: false }), createdAt: 14 },
    ]);
    const before = storedRows(h.path);

    const migrated = h.open();
    assert.deepEqual({ ...migrated.rpcIdempotencyRedactionReceipt, wallMs: 0 }, { seen: 5, redacted: 2, skippedUnparseable: 1, skippedUnrecognised: 1, complete: true, wallMs: 0 });
    const replay = migrated.lookupRpcResult("k-rename");
    assert.deepEqual(replay?.result, { bee: { ...toPublicBee(bee), envKeys: ENV_KEYS }, applied: true });
    assert.deepEqual(shapeOf(replay?.result), shapeOf(publicEnvRecords(rename)));
    assert.deepEqual(migrated.lookupRpcResult("k-spawn")?.result, spawn);
    assert.equal(migrated.lookupRpcResult("k-spawn")?.commandId, 7);
    assert.deepEqual(migrated.lookupRpcResult("k-template")?.result, template);
    migrated.close();

    const after = storedRows(h.path);
    assert.deepEqual(after.map(({ key, verb, command_id, created_at }) => ({ key, verb, command_id, created_at })),
      before.map(({ key, verb, command_id, created_at }) => ({ key, verb, command_id, created_at })));
    assert.deepEqual(after.filter((row, index) => row.result !== before[index]!.result).map((row) => row.key), ["k-clean", "k-rename"]);
    assert.equal(after.find((row) => row.key === "k-rename")!.result.includes(TOKEN), false);

    const version = new DatabaseSync(h.path, { readOnly: true });
    assert.equal((version.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value, String(SCHEMA_VERSION));
    version.close();

    const digest = tableDigest(h.path);
    const reopened = h.open();
    assert.equal(reopened.rpcIdempotencyRedactionReceipt, null);
    reopened.close();
    assert.equal(tableDigest(h.path), digest);

    seedStore(h.path, [], 39);
    const rerun = h.open();
    assert.deepEqual({ ...rerun.rpcIdempotencyRedactionReceipt, wallMs: 0 }, { seen: 5, redacted: 0, skippedUnparseable: 1, skippedUnrecognised: 1, complete: true, wallMs: 0 });
    rerun.close();
    assert.equal(tableDigest(h.path), digest);

    seedStore(h.path, [{ key: "k-late", verb: "bee.rename", commandId: null, result: JSON.stringify(rename), createdAt: 20 }], SCHEMA_VERSION);
    const lateDigest = tableDigest(h.path);
    h.open().close();
    assert.equal(tableDigest(h.path), lateDigest);
  } finally {
    h.cleanup();
  }
});

test("mirror-env.6b: rows the migration cannot parse or recognise are left untouched, counted, and never throw", () => {
  const h = harness();
  try {
    const first = h.open();
    const { bee } = makeBee(first);
    first.close();
    const raw = { bee: { ...bee, env: { ...RAW_ENV } }, applied: true };
    const deep = `${"[".repeat(20_000)}"env"${"]".repeat(20_000)}`;
    const odd = [
      { key: "u-truncated", verb: "bee.rename", result: JSON.stringify(raw).slice(0, 80) },
      { key: "u-not-json", verb: "bee.tag", result: `not json "env" ${TOKEN}` },
      { key: "u-empty", verb: "bee.tag", result: "" },
      { key: "s-deep", verb: "bee.tag", result: deep },
      { key: "s-string", verb: "bee.tag", result: JSON.stringify(`"env" ${TOKEN}`) },
      { key: "s-array", verb: "future.verb", result: JSON.stringify([{ bee: { env: { API_KEY: TOKEN } } }]) },
      { key: "s-null-bee", verb: "bee.tag", result: JSON.stringify({ bee: null, note: '"env"' }) },
      { key: "s-env-array", verb: "bee.tag", result: JSON.stringify({ bee: { env: ["API_KEY", TOKEN] } }) },
      { key: "s-env-mixed", verb: "bee.tag", result: JSON.stringify({ bee: { env: { API_KEY: TOKEN, PORT: 8080 } } }) },
      { key: "s-nested", verb: "bee.children", result: JSON.stringify({ children: [{ bee: { env: { API_KEY: TOKEN } } }] }) },
      { key: "s-template", verb: "template.put", result: JSON.stringify({ template: { env: { API_KEY: TOKEN } } }) },
    ];
    const known = [
      { key: "r-unknown-verb", verb: "future.verb", result: JSON.stringify(raw) },
      { key: "r-rename", verb: "bee.rename", result: JSON.stringify(raw) },
      { key: "n-no-env", verb: "spawn", result: JSON.stringify({ beeId: bee.id, commandId: 3 }) },
    ];
    seedStore(h.path, [...odd, ...known].map((row, index) => ({ ...row, commandId: null, createdAt: index })));
    const before = new Map(storedRows(h.path).map((row) => [row.key, row.result]));

    const migrated = h.open();
    assert.deepEqual({ ...migrated.rpcIdempotencyRedactionReceipt, wallMs: 0 }, { seen: 14, redacted: 2, skippedUnparseable: 3, skippedUnrecognised: 6, complete: true, wallMs: 0 });
    assert.deepEqual(migrated.lookupRpcResult("r-unknown-verb")?.result, { bee: { ...toPublicBee(bee), envKeys: ENV_KEYS }, applied: true });
    migrated.close();

    const after = new Map(storedRows(h.path).map((row) => [row.key, row.result]));
    assert.deepEqual([...after.keys()], [...before.keys()]);
    for (const row of [...odd, known[2]!]) assert.equal(after.get(row.key), before.get(row.key), row.key);
    for (const key of ["r-unknown-verb", "r-rename"]) assert.equal(after.get(key)!.includes(TOKEN), false, key);
  } finally {
    h.cleanup();
  }
});

test("mirror-env.7: a failed open rolls the redaction back with the version stamp", () => {
  const h = harness();
  try {
    const first = h.open();
    const { bee } = makeBee(first);
    first.close();
    seedStore(h.path, [{ key: "k-rename", verb: "bee.rename", commandId: null, result: JSON.stringify({ bee: { ...bee, env: { ...RAW_ENV } }, applied: true }), createdAt: 10 }]);
    const digest = tableDigest(h.path);
    const db = new DatabaseSync(h.path);
    db.exec("CREATE TRIGGER block_stamp BEFORE UPDATE ON meta WHEN NEW.key = 'schema_version' BEGIN SELECT RAISE(ABORT, 'stamp blocked'); END");
    db.close();
    assert.throws(() => h.open(), /stamp blocked/);
    assert.equal(tableDigest(h.path), digest);
    const unblock = new DatabaseSync(h.path);
    unblock.exec("DROP TRIGGER block_stamp");
    unblock.close();
    const migrated = h.open();
    assert.equal(JSON.stringify(migrated.lookupRpcResult("k-rename")?.result).includes(TOKEN), false);
    migrated.close();
  } finally {
    h.cleanup();
  }
});

test("mirror-env.8: 10,000 stored results migrate in bounded time", () => {
  const h = harness();
  try {
    const first = h.open();
    const { bee } = makeBee(first);
    first.close();
    const raw = JSON.stringify({ bee: { ...bee, env: { ...RAW_ENV } }, applied: true });
    seedStore(h.path, Array.from({ length: 10_000 }, (_, index) => ({ key: `k-${index}`, verb: "bee.rename", commandId: null, result: raw, createdAt: index })));
    const started = performance.now();
    const migrated = h.open();
    const elapsedMs = performance.now() - started;
    migrated.close();
    const rows = storedRows(h.path);
    assert.equal(rows.length, 10_000);
    assert.equal(rows.some((row) => row.result.includes(TOKEN)), false);
    assert.ok(elapsedMs < 5_000, `migration took ${Math.round(elapsedMs)}ms`);
  } finally {
    h.cleanup();
  }
});
