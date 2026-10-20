import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { openCoreStore, SCHEMA_VERSION, replayAudit, type CoreStore } from "../../v2/core/src/index.ts";

const baseline = "6586f6414efcbb3c8c535a28430dfcbe74c3f360";

test("schema44: rebuild checked status, rollback writer, receipt and notice survive re-upgrade", async () => {
  const root = mkdtempSync(join(tmpdir(), "dismiss-rollback-")); const path = join(root, "core.sqlite3"), artifact = join(root, "baseline.mjs");
  try {
    let baselineLoads = 0;
    const bundled = await build({entryPoints: ["v2/core/src/index.ts"], bundle: true, write: false, format: "esm", platform: "node", target: "node24", plugins: [{name: "committed-core", setup(api) {
      api.onResolve({filter: /^jsonc-parser$/}, () => ({path: pathToFileURL(createRequire(import.meta.url).resolve("jsonc-parser")).href, external: true}));
      api.onResolve({filter: /^(?:\.\/)?v2\/core\/src\/index\.ts$/}, args => ({path: args.path.replace(/^\.\//, ""), namespace: "baseline"}));
      api.onResolve({filter: /^\./, namespace: "baseline"}, args => ({path: posix.normalize(posix.join(posix.dirname(args.importer), args.path)), namespace: "baseline"}));
      api.onResolve({filter: /^[^.]/, namespace: "baseline"}, args => args.path.startsWith("node:") ? {path: args.path, external: true} : api.resolve(args.path, {kind: args.kind, resolveDir: process.cwd()}).then(result => ({path: pathToFileURL(result.path).href, external: true})));
      api.onLoad({filter: /.*/, namespace: "baseline"}, args => { baselineLoads++; return {contents: execFileSync("git", ["show", `${baseline}:${args.path}`], {encoding: "utf8"}), loader: args.path.endsWith(".json") ? "json" : "ts"}; });
    }}]});
    assert.ok(baselineLoads > 0, "Rollback core must load committed Git sources");
    writeFileSync(artifact, bundled.outputFiles[0]!.contents);
    const older = await import(pathToFileURL(artifact).href) as {openCoreStore(path: string): CoreStore; SCHEMA_VERSION: number};
    assert.equal(SCHEMA_VERSION, 44); assert.equal(older.SCHEMA_VERSION, 44);
    let old = older.openCoreStore(path); assert.equal("dismissQuestionWithKey" in old, false, "Baseline must predate dismissal"); const {bee} = old.createBee({name: "rollback", agent: "inbox", substrate: "hsr", cwd: root});
    const question = old.askQuestion(bee.id, {text: "Dismiss before rollback?"}), pending = old.askQuestion(bee.id, {text: "Old writer still works?"}); old.close();
    let current = openCoreStore(path, {ephemeral: true}); const receipt = current.dismissQuestionWithKey(question.id, "rollback-key"); current.close();
    old = older.openCoreStore(path); assert.equal(old.getQuestion(question.id)!.status, "dismissed");
    assert.throws(() => old.answerQuestion(question.id, "No reopen"), /already dismissed/);
    assert.throws(() => old.withdrawQuestionWithKey(question.id, bee.id, "No overwrite", "old-withdraw"), /no longer open/);
    old.answerQuestion(pending.id, "Old writer works."); const created = old.askQuestion(bee.id, {text: "Created on rollback."}); old.close();
    const db = new DatabaseSync(path); const stamp = String(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()!.value);
    const integrity = String(db.prepare("PRAGMA integrity_check").get()!.integrity_check), foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
    const receipts = Number(db.prepare("SELECT count(*) AS n FROM question_dismiss_receipts").get()!.n);
    const notice = db.prepare("SELECT body,sender,sender_kind FROM mailbox WHERE id=?").get(receipt.question.dismissalMessageId!)!;
    const ddl = String(db.prepare("SELECT sql FROM sqlite_master WHERE name='questions'").get()!.sql); db.close();
    assert.equal(stamp, "44"); assert.equal(integrity, "ok"); assert.deepEqual(foreignKeys, []); assert.equal(receipts, 1); assert.ok(ddl.includes("'dismissed'"));
    assert.equal(notice.body, "Your question was dismissed without an answer."); assert.equal(notice.sender, "rpc"); assert.equal(notice.sender_kind, "automation");
    current = openCoreStore(path, {ephemeral: true});
    try {
      assert.deepEqual(current.dismissQuestionWithKey(question.id, "rollback-key"), {...receipt, deduped: true});
      assert.deepEqual(current.dismissQuestionWithKey(question.id, "new-key"), receipt);
      assert.equal(current.getQuestion(pending.id)!.status, "answered"); assert.equal(current.getQuestion(created.id)!.dismissedAt, null);
      assert.deepEqual(replayAudit(current.auditRows()), current.dumpState());
      assert.equal(current.listMessages(bee.id).filter(message => message.id === receipt.question.dismissalMessageId).length, 1);
      console.log(JSON.stringify({host: hostname(), baseline, schemaVersion: stamp, baselineLoads, baselinePredatesDismissal: true, statusColumn: "CHECK rebuilt", integrity, foreignKeys, receipts, notice, question: receipt.question, rollbackOpenedAndWrote: true, replayEqual: true}));
    } finally {current.close();}
  } finally {rmSync(root, {recursive: true, force: true});}
});
