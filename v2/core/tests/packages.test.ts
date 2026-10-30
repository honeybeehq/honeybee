/**
 * WP6a — templates as hive concepts, and the package format
 * (spec 06 §1.4.1 "rows are truth, files are packages"). Temp dirs only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  NameConflictError,
  PackageError,
  TemplateEnvWipeError,
  TemplateNotFoundError,
  exportTemplate,
  importLocalConfig,
  importTemplate,
  legacyTemplateToPackage,
  parseTemplatePackage,
  replayAudit,
  serializePackage,
  type CoreStore,
  type TemplatePackage,
} from "../src/index.ts";
import { harness } from "./helpers.ts";

const baseTemplate = {
  name: "commit",
  agent: "codex",
  prompt: "Commit the working tree in small atomic commits.",
  description: "Atomic commits",
  args: ["-m", "gpt-5.6-sol"],
  model: "gpt-5.6-sol",
  effort: "medium",
  tags: ["git"],
};

test("pkg.1: putTemplate is idempotent — same fields twice = one row, unchanged, no extra audit", () => {
  const h = harness();
  try {
    const store = h.open();
    const a = store.putTemplate({ fields: baseTemplate });
    assert.equal(a.outcome, "created");
    assert.equal(a.template.scope, "personal");
    assert.equal(a.template.source, "api");
    assert.equal(a.template.cwdPolicy, "caller");
    assert.equal(a.template.preambleEnabled, true);
    const seqAfterCreate = store.lastAuditSeq();
    const b = store.putTemplate({ fields: baseTemplate });
    assert.equal(b.outcome, "unchanged");
    assert.equal(b.template.id, a.template.id);
    assert.equal(b.template.updatedAt, a.template.updatedAt);
    assert.equal(store.lastAuditSeq(), seqAfterCreate, "no audit row for a no-op put");
    const c = store.putTemplate({ fields: { ...baseTemplate, effort: "high" } });
    assert.equal(c.outcome, "updated");
    assert.equal(c.template.id, a.template.id);
    assert.equal(c.template.effort, "high");
    assert.ok(c.template.updatedAt > a.template.updatedAt);
    assert.equal(c.template.createdAt, a.template.createdAt);
    assert.equal(store.listTemplates().length, 1);
    // Audit replay reproduces the registry (spec01 test 13 discipline).
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    const kinds = store.auditRows().map((r) => r.kind);
    assert.deepEqual(kinds.filter((k) => k.startsWith("template.")), ["template.put", "template.put"]);
    store.close();
  } finally {
    h.cleanup();
  }
});

test("pkg.2: names are unique per scope — id/name conflicts throw NameConflictError; scopes are independent", () => {
  const h = harness();
  try {
    const store = h.open();
    const a = store.putTemplate({ id: "tpl-a", fields: baseTemplate });
    // Same name, different scope: fine.
    const team = store.putTemplate({ fields: { ...baseTemplate, scope: "team" } });
    assert.notEqual(team.template.id, a.template.id);
    // Explicit different id for an existing (scope,name): refused.
    assert.throws(() => store.putTemplate({ id: "tpl-b", fields: baseTemplate }), NameConflictError);
    // Renaming tpl-a onto the team row's name in the team scope: refused.
    assert.throws(() => store.putTemplate({ id: "tpl-a", fields: { ...baseTemplate, scope: "team" } }), NameConflictError);
    // Renaming tpl-a to a free name via id match: fine, keeps id.
    const renamed = store.putTemplate({ id: "tpl-a", fields: { ...baseTemplate, name: "commit-2" } });
    assert.equal(renamed.outcome, "updated");
    assert.equal(renamed.template.name, "commit-2");
    assert.equal(store.getTemplateByName("personal", "commit"), null);
    store.close();
  } finally {
    h.cleanup();
  }
});

test("pkg.3: delete removes the row, audits, and not-found is typed; validation is closed-list", () => {
  const h = harness();
  try {
    const store = h.open();
    const t = store.putTemplate({ fields: baseTemplate }).template;
    store.deleteTemplate(t.id);
    assert.equal(store.getTemplate(t.id), null);
    assert.throws(() => store.deleteTemplate(t.id), TemplateNotFoundError);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    // Closed lists / required fields.
    assert.throws(() => store.putTemplate({ fields: { ...baseTemplate, scope: "global" } }), PackageError);
    assert.throws(() => store.putTemplate({ fields: { ...baseTemplate, source: "magic" } }), PackageError);
    assert.throws(() => store.putTemplate({ fields: { ...baseTemplate, prompt: "" } }), PackageError);
    assert.throws(() => store.putTemplate({ fields: { ...baseTemplate, name: "bad name" } }), PackageError);
    assert.throws(() => store.putTemplate({ fields: { ...baseTemplate, cwdPolicy: "fixed" } }), PackageError);
    assert.throws(() => store.putTemplate({ fields: { ...baseTemplate, cwd: "/x" } }), PackageError);
    assert.throws(() => store.putTemplate({ fields: { ...baseTemplate, preambleEnabled: false, preamble: "x" } }), PackageError);
    // Unknown fields are dropped, not stored.
    const u = store.putTemplate({ fields: { ...baseTemplate, name: "u", bogus: 1 } }).template;
    assert.equal("bogus" in u, false);
    store.close();
  } finally {
    h.cleanup();
  }
});

test("pkg.4: package import is idempotent and records source; missing id matches by scope+name", () => {
  const h = harness();
  try {
    const store = h.open();
    const doc: TemplatePackage = parseTemplatePackage({ kind: "hive.template", formatVersion: 1, ...baseTemplate });
    assert.equal(doc.id, null);
    const a = importTemplate(store, doc, { source: "package:/repo/.hive/commit.json" });
    assert.equal(a.outcome, "created");
    assert.equal(a.row.source, "package:/repo/.hive/commit.json");
    const b = importTemplate(store, serializePackage(doc), { source: "package:/repo/.hive/commit.json" });
    assert.equal(b.outcome, "unchanged");
    assert.equal(b.row.id, a.row.id);
    assert.equal(store.listTemplates().length, 1);
    // A modified package updates the same row.
    const c = importTemplate(store, { ...doc, prompt: "v2 prompt" }, { source: "package:/repo/.hive/commit.json" });
    assert.equal(c.outcome, "updated");
    assert.equal(c.row.id, a.row.id);
    // Scope override at import (repo `.hive/` forces repo scope) → distinct row.
    const r = importTemplate(store, doc, { scope: "repo", source: "package:/repo/.hive/commit.json" });
    assert.equal(r.row.scope, "repo");
    assert.equal(store.listTemplates().length, 2);
    // Header enforcement.
    assert.throws(() => importTemplate(store, { ...doc, kind: "hive.track" }), PackageError);
    assert.throws(() => importTemplate(store, { ...doc, formatVersion: 2 }), PackageError);
    assert.throws(() => importTemplate(store, "{not json"), PackageError);
    store.close();
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Property: export → import → export is byte-identical, for random rows.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["alpha", "beta", "gamma", "delta", "ø-unicode", "tab\there", "quote\"d", "new\nline", "", "  spaced  "];
const SCOPES = ["personal", "team", "repo"] as const;

function randomTemplateFields(rnd: () => number, i: number): Record<string, unknown> {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const maybe = <T>(v: T): T | null => (rnd() < 0.3 ? null : v);
  const fixed = rnd() < 0.3;
  const preambleEnabled = rnd() < 0.8;
  const env: Record<string, string> = {};
  for (let k = 0; k < Math.floor(rnd() * 4); k++) env[`K${Math.floor(rnd() * 5)}`] = pick(WORDS);
  return {
    name: `t${i}-${Math.floor(rnd() * 1000)}`,
    scope: pick(SCOPES),
    agent: pick(["claude", "codex", "grok"]),
    prompt: `${pick(WORDS)} ${pick(WORDS)} x`,
    description: maybe(pick(WORDS)),
    substrate: maybe(pick(["tmux", "hsr", "cell"])),
    model: maybe(pick(["opus", "gpt-5.6-sol"])),
    effort: maybe(pick(["low", "high"])),
    args: Array.from({ length: Math.floor(rnd() * 4) }, () => pick(WORDS)),
    preamble: preambleEnabled ? maybe(pick(WORDS)) : null,
    preambleEnabled,
    cwdPolicy: fixed ? "fixed" : "caller",
    cwd: fixed ? `/tmp/${pick(["a", "b"])}` : null,
    env,
    account: maybe(pick(WORDS)),
    yolo: rnd() < 0.5,
    tags: Array.from({ length: Math.floor(rnd() * 3) }, () => pick(WORDS)),
  };
}

test("pkg.5: property — export→import→export is byte-identical (templates, 60 seeds)", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const rnd = mulberry32(seed);
    const src = harness();
    const dst = harness();
    try {
      const a = src.open();
      const b = dst.open();
      for (let i = 0; i < 4; i++) {
        const fields = randomTemplateFields(rnd, i);
        const row = a.putTemplate({ fields }).template;
        const text1 = serializePackage(exportTemplate(row));
        const imported = importTemplate(b, text1, { source: "package:/pkg.json" });
        const text2 = serializePackage(exportTemplate(imported.row));
        assert.equal(text2, text1, `seed ${seed} template ${i}`);
        // Re-import on the source store itself: unchanged (source differs → updated once, then unchanged).
        importTemplate(a, text1, { source: "package:/pkg.json" });
        assert.equal(importTemplate(a, text1, { source: "package:/pkg.json" }).outcome, "unchanged");
      }
      // Ids are carried by the package, so both stores hold identical id sets.
      assert.deepEqual(b.listTemplates().map((t) => t.id).sort(), a.listTemplates().map((t) => t.id).sort());
      assert.deepEqual(replayAudit(a.auditRows()), a.dumpState());
      assert.deepEqual(replayAudit(b.auditRows()), b.dumpState());
      a.close();
      b.close();
    } finally {
      src.cleanup();
      dst.cleanup();
    }
  }
});

test("pkg.6: serialized package is stable — fixed key order, 2-space json, trailing newline", () => {
  const h = harness();
  try {
    const store = h.open();
    const row = store.putTemplate({ id: "tpl-commit", fields: { ...baseTemplate, env: { ZED: "1", ALPHA: "2" } } }).template;
    const text = serializePackage(exportTemplate(row));
    assert.equal(
      text,
      `{
  "kind": "hive.template",
  "formatVersion": 1,
  "id": "tpl-commit",
  "name": "commit",
  "scope": "personal",
  "description": "Atomic commits",
  "agent": "codex",
  "substrate": null,
  "model": "gpt-5.6-sol",
  "effort": "medium",
  "args": [
    "-m",
    "gpt-5.6-sol"
  ],
  "prompt": "Commit the working tree in small atomic commits.",
  "preamble": null,
  "preambleEnabled": true,
  "cwdPolicy": "caller",
  "cwd": null,
  "env": {
    "ALPHA": "2",
    "ZED": "1"
  },
  "account": null,
  "yolo": false,
  "tags": [
    "git"
  ]
}
`,
    );
    store.close();
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Local config source — today's ~/.hive layout, rebuilt in a temp dir.
// ---------------------------------------------------------------------------

function writeLocalConfig(dir: string): void {
  mkdirSync(join(dir, "templates"), { recursive: true });
  mkdirSync(join(dir, "tracks", "definitions", "demo", "versions"), { recursive: true });
  mkdirSync(join(dir, "tracks", "attachments"), { recursive: true });
  writeFileSync(
    join(dir, "templates", "commit.json"),
    JSON.stringify({
      name: "commit",
      bee: "codex-auto",
      prompt: "Commit the tree.",
      cwd: "caller",
      description: "Atomic commits + push",
      args: ["-m", "gpt-5.6-sol", "-c", 'model_reasoning_effort="medium"'],
      createdAt: "2026-07-28T13:11:49.137Z",
      updatedAt: "2026-07-31T17:18:43.818Z",
    }),
  );
  writeFileSync(join(dir, "templates", "commit.source"), "/tmp/hive-commit-template.json\n");
  writeFileSync(
    join(dir, "templates", "reviewer.json"),
    JSON.stringify({
      name: "reviewer",
      bee: "claude",
      prompt: "Review the diff.",
      cwd: "/Users/x/repo",
      preamble: false,
      yolo: true,
      account: "work",
      env: { REVIEW: "1" },
    }),
  );
  writeFileSync(join(dir, "templates", "fancy.ts"), "export default { name: 'fancy' }\n");
  writeFileSync(join(dir, "templates", "broken.json"), JSON.stringify({ name: "broken", bee: "claude" })); // no prompt
  writeFileSync(
    join(dir, "tracks", "definitions", "demo.json"),
    JSON.stringify({
      schemaVersion: 2,
      name: "demo",
      description: "Flow-view demo",
      version: 3,
      items: [
        { id: "n1", name: "Map", type: "action", instruction: "Grep call sites." },
        { id: "n2", name: "Migrate", type: "orchestrate", instruction: "Coordinate.", subAgents: { max: 3, harness: "claude" } },
        {
          branch: [
            [{ id: "n3a", name: "Docs", when: "docs changed", type: "action" }],
            [{ id: "n3b", name: "Types", note: "lockstep", type: "action" }],
          ],
        },
        { id: "n4", name: "Review", type: "review", denied: [{ id: "n4d", name: "Re-land", type: "action" }] },
        { id: "n5", name: "Cookie fallback", type: "ask", question: "Keep the cookie path?", blocking: true },
        { id: "n6", name: "Ship", type: "deploy", target: { kind: "nectar", label: "preview" } },
      ],
    }),
  );
  writeFileSync(join(dir, "tracks", "definitions", "demo", "versions", "000001.json"), "{}");
}

test("pkg.7: importLocalConfig reads today's ~/.hive layout read-only, maps old shapes, is idempotent, reports skips", () => {
  const h = harness();
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-localcfg-"));
  try {
    writeLocalConfig(dir);
    const store = h.open();
    const r1 = importLocalConfig(store, dir);
    assert.deepEqual(r1.templates.map((t) => [t.name, t.outcome]), [
      ["commit", "created"],
      ["reviewer", "created"],
    ]);
    assert.equal("tracks" in r1, false, "legacy track definitions are ignored, not imported");
    assert.deepEqual(r1.skipped.map((s) => s.path.split("/").pop()).sort(), ["broken.json", "fancy.ts"]);

    const commit = store.getTemplateByName("personal", "commit");
    assert.ok(commit);
    assert.equal(commit.source, "local-config");
    assert.equal(commit.agent, "codex-auto");
    assert.equal(commit.cwdPolicy, "caller");
    assert.equal(commit.preambleEnabled, true);
    assert.deepEqual(commit.args, ["-m", "gpt-5.6-sol", "-c", 'model_reasoning_effort="medium"']);
    assert.equal(commit.model, null, "old args are not parsed into model/effort");
    const reviewer = store.getTemplateByName("personal", "reviewer");
    assert.ok(reviewer);
    assert.equal(reviewer.cwdPolicy, "fixed");
    assert.equal(reviewer.cwd, "/Users/x/repo");
    assert.equal(reviewer.preambleEnabled, false);
    assert.equal(reviewer.yolo, true);
    assert.equal(reviewer.account, "work");
    assert.deepEqual(reviewer.env, { REVIEW: "1" });

    // Second import: nothing changes.
    const r2 = importLocalConfig(store, dir);
    assert.ok(r2.templates.every((t) => t.outcome === "unchanged"));
    assert.equal(store.listTemplates().length, 2);
    // Edit a file → updated on the next manual import; nothing else moves.
    writeFileSync(join(dir, "templates", "commit.json"), JSON.stringify({ name: "commit", bee: "codex-auto", prompt: "Commit the tree, v2." }));
    const r3 = importLocalConfig(store, dir);
    assert.deepEqual(r3.templates.map((t) => t.outcome), ["updated", "unchanged"]);
    // Missing dir: empty report, no throw.
    const r4 = importLocalConfig(store, join(dir, "nope"));
    assert.deepEqual([r4.templates, r4.skipped], [[], []]);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pkg.8: legacy converters reject garbage with PackageError", () => {
  assert.throws(() => legacyTemplateToPackage(null), PackageError);
  assert.throws(() => legacyTemplateToPackage({ name: "x" }), PackageError);
  const t = legacyTemplateToPackage({ name: "ok", bee: "claude", prompt: "p", preamble: "custom" });
  assert.equal(t.preamble, "custom");
  assert.equal(t.preambleEnabled, true);
});

// ---------------------------------------------------------------------------
// Fuzz: random registry ops never leave a state outside the model, and audit
// replay always reproduces it.
// ---------------------------------------------------------------------------

test("pkg.9: fuzz — random put/import/delete on templates keeps names unique per scope and replays exactly", () => {
  for (let seed = 1; seed <= 25; seed++) {
    const rnd = mulberry32(seed * 7919);
    const h = harness();
    try {
      let store: CoreStore = h.open();
      const names = ["a", "b", "c"];
      const ids = ["id-1", "id-2", "id-3"];
      for (let op = 0; op < 80; op++) {
        const roll = rnd();
        const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
        try {
          if (roll < 0.3) {
            store.putTemplate({ id: rnd() < 0.5 ? pick(ids) : undefined, fields: { ...randomTemplateFields(rnd, op), name: pick(names) } });
          } else if (roll < 0.65) {
            const t = pick(store.listTemplates());
            if (t) importTemplate(store, serializePackage(exportTemplate({ ...t, scope: pick(SCOPES) })), { source: "package:/f" });
          } else if (roll < 0.8) {
            const t = pick(store.listTemplates());
            if (t) store.deleteTemplate(t.id);
          } else if (roll < 0.9) {
            store.deleteTemplate("id-9"); // always throws (not found)
          } else {
            store.close();
            store = h.open(); // "crash" + reopen
          }
        } catch (err) {
          assert.ok(err instanceof NameConflictError || err instanceof TemplateNotFoundError || err instanceof PackageError || err instanceof TemplateEnvWipeError, `seed ${seed} op ${op}: ${String(err)}`);
        }
        const dump = store.dumpState();
        const seen = new Set<string>();
        for (const t of dump.templates) {
          const key = `${t.scope}/${t.name}`;
          assert.ok(!seen.has(key), `dup ${key}`);
          seen.add(key);
          assert.ok(t.updatedAt >= t.createdAt);
          assert.equal(t.cwdPolicy === "fixed", t.cwd !== null);
        }
      }
      assert.deepEqual(replayAudit(store.auditRows()), store.dumpState(), `seed ${seed} replay`);
      store.close();
    } finally {
      h.cleanup();
    }
  }
});

test("pkg.10: a whole-row put with an empty env over a template that has env is refused and leaves the row untouched", () => {
  const h = harness();
  try {
    const store = h.open();
    const env = { DUMMY_SECRET: "dummy-value-123", OTHER: "x" };
    const created = store.putTemplate({ id: "tpl-env", fields: { ...baseTemplate, prompt: "original prompt", env } }).template;
    const auditBefore = store.auditRows().length;

    const wholeRow = { ...exportTemplate(created), prompt: "edited from workstation A", env: {} };
    const { kind: _kind, formatVersion: _formatVersion, id: _id, ...fields } = wholeRow;
    let refusal: unknown = null;
    try {
      store.putTemplate({ id: "tpl-env", fields });
    } catch (err) {
      refusal = err;
    }
    assert.ok(refusal instanceof TemplateEnvWipeError, String(refusal));
    assert.equal(refusal.message, "template tpl-env: refusing to replace this template's env with an empty one; to clear all env, delete the template and create it again");
    assert.ok(!refusal.message.includes("dummy-value-123"));
    assert.ok(!refusal.message.includes("DUMMY_SECRET"));
    assert.deepEqual(store.getTemplate("tpl-env"), created);
    assert.equal(store.auditRows().length, auditBefore);

    const oneRemoved = store.putTemplate({ id: "tpl-env", fields: { ...fields, env: { DUMMY_SECRET: "dummy-value-123" } } });
    assert.equal(oneRemoved.outcome, "updated");
    assert.deepEqual(oneRemoved.template.env, { DUMMY_SECRET: "dummy-value-123" });
    assert.equal(oneRemoved.template.prompt, "edited from workstation A");
    const changed = store.putTemplate({ id: "tpl-env", fields: { ...fields, env: { DUMMY_SECRET: "rotated" } } });
    assert.deepEqual(changed.template.env, { DUMMY_SECRET: "rotated" });
    assert.throws(() => store.putTemplate({ id: "tpl-env", fields }), TemplateEnvWipeError);
    assert.deepEqual(store.getTemplate("tpl-env")?.env, { DUMMY_SECRET: "rotated" });

    const bare = store.putTemplate({ id: "tpl-bare", fields: { ...baseTemplate, name: "bare" } });
    assert.equal(bare.outcome, "created");
    assert.equal(store.putTemplate({ id: "tpl-bare", fields: { ...baseTemplate, name: "bare", prompt: "p2", env: {} } }).outcome, "updated");

    store.deleteTemplate("tpl-env");
    const recreated = store.putTemplate({ id: "tpl-env", fields });
    assert.equal(recreated.outcome, "created");
    assert.deepEqual(recreated.template.env, {});
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
  }
});

test("pkg.12: a put that omits env keeps the stored env; an explicit empty env is still refused", () => {
  const h = harness();
  try {
    const store = h.open();
    const env = { DUMMY_SECRET: "dummy-value-123", OTHER: "x" };
    const created = store.putTemplate({ id: "tpl-env", fields: { ...baseTemplate, prompt: "original prompt", env } }).template;
    const { kind: _kind, formatVersion: _formatVersion, id: _id, env: _env, ...withoutEnv } = exportTemplate(created);

    const byId = store.putTemplate({ id: "tpl-env", fields: { ...withoutEnv, prompt: "edited from workstation A" } });
    assert.equal(byId.outcome, "updated");
    assert.deepEqual(byId.template.env, env);
    assert.equal(byId.template.prompt, "edited from workstation A");

    const byName = store.putTemplate({ fields: { ...baseTemplate, prompt: "renamed by name match" } });
    assert.equal(byName.template.id, "tpl-env");
    assert.deepEqual(byName.template.env, env);

    const auditBefore = store.auditRows().length;
    assert.equal(store.putTemplate({ id: "tpl-env", fields: { ...baseTemplate, prompt: "renamed by name match" } }).outcome, "unchanged");
    assert.equal(store.auditRows().length, auditBefore);

    assert.throws(() => store.putTemplate({ id: "tpl-env", fields: { ...withoutEnv, env: {} } }), TemplateEnvWipeError);
    assert.throws(() => store.putTemplate({ id: "tpl-env", fields: { ...withoutEnv, env: null } }), TemplateEnvWipeError);
    assert.deepEqual(store.getTemplate("tpl-env")?.env, env);

    const fresh = store.putTemplate({ id: "tpl-new", fields: { ...baseTemplate, name: "fresh" } });
    assert.equal(fresh.outcome, "created");
    assert.deepEqual(fresh.template.env, {});
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
  }
});

test("pkg.11: re-importing a package or local config without env over a template that has env is refused", () => {
  const h = harness();
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-envwipe-"));
  try {
    const store = h.open();
    const created = store.putTemplate({ id: "tpl-env", fields: { ...baseTemplate, env: { DUMMY_SECRET: "dummy-value-123" } } }).template;
    const doc = exportTemplate(created);

    const same = importTemplate(store, serializePackage(doc), { source: "package:/pkg.json" });
    assert.equal(same.outcome, "updated");
    assert.deepEqual(same.row.env, { DUMMY_SECRET: "dummy-value-123" });
    assert.equal(importTemplate(store, serializePackage(doc), { source: "package:/pkg.json" }).outcome, "unchanged");

    assert.throws(() => importTemplate(store, { ...doc, env: {} }, { source: "package:/pkg.json" }), TemplateEnvWipeError);
    const { env: _env, ...withoutEnv } = doc;
    assert.throws(() => importTemplate(store, withoutEnv, { source: "package:/pkg.json" }), TemplateEnvWipeError);
    assert.deepEqual(store.getTemplate("tpl-env")?.env, { DUMMY_SECRET: "dummy-value-123" });

    mkdirSync(join(dir, "templates"), { recursive: true });
    writeFileSync(join(dir, "templates", "commit.json"), JSON.stringify({ name: "commit", bee: "codex", prompt: "from disk" }));
    writeFileSync(join(dir, "templates", "other.json"), JSON.stringify({ name: "other", bee: "claude", prompt: "hi" }));
    const report = importLocalConfig(store, dir);
    assert.deepEqual(report.templates.map((t) => [t.name, t.outcome]), [["other", "created"]]);
    assert.equal(report.skipped.length, 1);
    assert.equal(report.skipped[0]?.reason, "template tpl-env: refusing to replace this template's env with an empty one; to clear all env, delete the template and create it again");
    assert.ok(!(report.skipped[0]?.reason ?? "").includes("dummy-value-123"));
    assert.deepEqual(store.getTemplate("tpl-env")?.env, { DUMMY_SECRET: "dummy-value-123" });
    assert.notEqual(store.getTemplate("tpl-env")?.prompt, "from disk");
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pkg.13: a store written before tracks were removed still opens, replays its retired track audit rows and snapshots without a tracks key", () => {
  const h = harness();
  try {
    const first = h.open();
    first.putTemplate({ id: "tpl-1", fields: baseTemplate });
    first.close();
    const db = new DatabaseSync(h.path);
    db.exec(`CREATE TABLE IF NOT EXISTS tracks (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, scope TEXT NOT NULL, source TEXT NOT NULL, description TEXT,
      steps TEXT NOT NULL DEFAULT '[]', tags TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (scope, name)) STRICT`);
    db.prepare("INSERT INTO tracks(id, name, scope, source, description, steps, tags, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("trk-1", "ship", "personal", "api", null, "[]", "[]", 1, 1);
    const track = { id: "trk-1", name: "ship", scope: "personal", source: "api", description: null, steps: [], tags: [], createdAt: 1, updatedAt: 1 };
    db.prepare("INSERT INTO audit(ts, kind, bee_id, payload) VALUES(?, ?, NULL, ?)").run(2, "track.put", JSON.stringify({ track, outcome: "created" }));
    db.prepare("INSERT INTO audit(ts, kind, bee_id, payload) VALUES(?, ?, NULL, ?)").run(3, "track.deleted", JSON.stringify({ trackId: "trk-1", deletedAt: 3 }));
    db.close();

    const store = h.open();
    const kinds = store.auditRows().map((row) => row.kind);
    assert.ok(kinds.includes("track.put") && kinds.includes("track.deleted"), "retired rows stay in the append-only audit log");
    assert.doesNotThrow(() => replayAudit(store.auditRows()));
    const dump = store.dumpState();
    assert.deepEqual(replayAudit(store.auditRows()), dump);
    assert.equal("tracks" in dump, false);
    assert.equal(store.listTemplates().length, 1);
    assert.throws(() => replayAudit([...store.auditRows(), { seq: 999, ts: 4, kind: "track.wat", beeId: null, payload: {} }]), /unknown audit kind track\.wat/);
    store.close();
  } finally {
    h.cleanup();
  }
});
