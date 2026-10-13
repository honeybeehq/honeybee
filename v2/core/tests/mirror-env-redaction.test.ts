import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { MIRROR_RAW_BEE_ENV_KEYS, SCHEMA_VERSION, type AuditRow } from "../src/index.ts";
import {
  REDACTED_ENV_VALUE,
  isSecretEnvKey,
  mirrorBeeAuditRow,
  mirrorBeeRow,
  redactBeeResultEnv,
  redactMirrorBeeEnv,
} from "../src/envRedaction.ts";
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
const MIRROR_ENV = {
  APIARY_AGENT_TOKEN: REDACTED_ENV_VALUE,
  DATABASE_URL: REDACTED_ENV_VALUE,
  HIVE_BEE: REDACTED_ENV_VALUE,
  CODEX_HOME: "/homes/codex-a",
  CLAUDE_CONFIG_DIR: "/homes/claude-a",
  GROK_HOME: "/homes/grok-a",
};

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

function seedStore(path: string, rows: Array<{ key: string; verb: string; commandId: number | null; result: string; createdAt: number }>, version = SCHEMA_VERSION - 1): void {
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

test("mirror-env.1: the raw allowlist is exactly the keys Apiary reads, and none is secret-named", () => {
  assert.deepEqual([...MIRROR_RAW_BEE_ENV_KEYS], ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME"]);
  for (const key of MIRROR_RAW_BEE_ENV_KEYS) assert.equal(isSecretEnvKey(key), false, key);
});

test("mirror-env.2: mirror bee env keeps every key and only allowlisted values", () => {
  const input = { ...RAW_ENV };
  assert.deepEqual(redactMirrorBeeEnv(input), MIRROR_ENV);
  assert.deepEqual(input, RAW_ENV);
  assert.deepEqual(redactMirrorBeeEnv({}), {});
  assert.equal(mirrorBeeRow(null), null);
});

test("mirror-env.3: every bee audit payload that carries env is redacted without mutating the stored row", () => {
  const rows = [
    auditRow("bee.created", { bee: { id: "b1", name: "worker", env: { ...RAW_ENV } } }),
    auditRow("bee.env_set", { beeId: "b1", env: { ...RAW_ENV }, previous: { ...RAW_ENV } }),
    auditRow("bee.handoff_switched", { beeId: "b1", env: { ...RAW_ENV }, previousEnv: { ...RAW_ENV }, args: ["--token", "kept"] }),
    auditRow("bee.handoff_admitted", { handoff: { id: "h1", targetEnv: { ...RAW_ENV }, to: { agent: "codex", args: null } } }),
    auditRow("bee.handoff_phase", { handoffId: "h1", beeId: "b1", phase: "switched", previous: "admitted", handoff: { id: "h1", targetEnv: { ...RAW_ENV } } }),
  ];
  const before = JSON.stringify(rows);
  const mirrored = rows.map(mirrorBeeAuditRow);
  assert.equal(JSON.stringify(rows), before);
  const text = JSON.stringify(mirrored);
  assert.equal(text.includes(TOKEN), false);
  assert.equal(text.includes(DSN), false);
  assert.deepEqual((mirrored[0]!.payload.bee as { env: unknown }).env, MIRROR_ENV);
  assert.deepEqual(mirrored[1]!.payload, { beeId: "b1", env: MIRROR_ENV, previous: MIRROR_ENV });
  assert.deepEqual(mirrored[2]!.payload, { beeId: "b1", env: MIRROR_ENV, previousEnv: MIRROR_ENV, args: ["--token", "kept"] });
  assert.deepEqual(mirrored[3]!.payload, { handoff: { id: "h1", targetEnv: MIRROR_ENV, to: { agent: "codex", args: null } } });
  assert.equal(mirrored[4]!.payload.previous, "admitted");
  assert.deepEqual(shapeOf(mirrored), shapeOf(rows));
});

test("mirror-env.4: non-env bee payloads and non-bee rows pass through", () => {
  const renamed = auditRow("bee.renamed", { beeId: "b1", name: "next", previous: "worker" });
  assert.deepEqual(mirrorBeeAuditRow(renamed), renamed);
  const tagged = auditRow("bee.tagged", { beeId: "b1", tags: ["a"], previous: [], added: ["a"], removed: [] });
  assert.deepEqual(mirrorBeeAuditRow(tagged), tagged);
  const template = auditRow("template.put", { template: { id: "t1", env: { API_KEY: TOKEN } }, outcome: "created" });
  assert.equal(mirrorBeeAuditRow(template), template);
});

test("mirror-env.5: a stored result is redacted exactly when it carries a bee row", () => {
  const result = { bee: { id: "b1", env: { ...RAW_ENV }, args: null }, applied: true };
  assert.deepEqual(redactBeeResultEnv(result), { bee: { id: "b1", env: { ...RAW_ENV, APIARY_AGENT_TOKEN: REDACTED_ENV_VALUE }, args: null }, applied: true });
  assert.deepEqual(result.bee.env, RAW_ENV);
  for (const value of [null, 3, "text", [], { bee: null }, { bee: { env: null } }, { template: { env: { API_KEY: TOKEN } } }, { beeId: "b1", commandId: 7 }]) {
    assert.equal(redactBeeResultEnv(value), value);
  }
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
    assert.deepEqual({ ...migrated.rpcIdempotencyRedactionReceipt, wallMs: 0 }, { seen: 5, redacted: 1, skippedUnparseable: 1, skippedUnrecognised: 1, complete: true, wallMs: 0 });
    const replay = migrated.lookupRpcResult("k-rename");
    assert.deepEqual(replay?.result, { bee: { ...bee, env: { ...RAW_ENV, APIARY_AGENT_TOKEN: REDACTED_ENV_VALUE } }, applied: true });
    assert.deepEqual(shapeOf(replay?.result), shapeOf(rename));
    assert.deepEqual(migrated.lookupRpcResult("k-spawn")?.result, spawn);
    assert.equal(migrated.lookupRpcResult("k-spawn")?.commandId, 7);
    assert.deepEqual(migrated.lookupRpcResult("k-template")?.result, template);
    migrated.close();

    const after = storedRows(h.path);
    assert.deepEqual(after.map(({ key, verb, command_id, created_at }) => ({ key, verb, command_id, created_at })),
      before.map(({ key, verb, command_id, created_at }) => ({ key, verb, command_id, created_at })));
    assert.deepEqual(after.filter((row, index) => row.result !== before[index]!.result).map((row) => row.key), ["k-rename"]);
    assert.equal(after.find((row) => row.key === "k-rename")!.result.includes(TOKEN), false);

    const version = new DatabaseSync(h.path, { readOnly: true });
    assert.equal((version.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value, String(SCHEMA_VERSION));
    version.close();

    const digest = tableDigest(h.path);
    const reopened = h.open();
    assert.equal(reopened.rpcIdempotencyRedactionReceipt, null);
    reopened.close();
    assert.equal(tableDigest(h.path), digest);

    seedStore(h.path, [], SCHEMA_VERSION - 1);
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
    assert.deepEqual(migrated.lookupRpcResult("r-unknown-verb")?.result, { bee: { ...bee, env: { ...RAW_ENV, APIARY_AGENT_TOKEN: REDACTED_ENV_VALUE } }, applied: true });
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
