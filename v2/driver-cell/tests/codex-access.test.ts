import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { accessOnlyCodexDocument, readAccessOnlyCodex, snapshotAccessOnlyCodex } from "../src/codexAccess.ts";
import { prepareSandboxHarnessHome } from "../src/harnessHome.ts";

const document = (access = "synthetic-access", refresh = "") => JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: access, refresh_token: refresh, id_token: "synthetic-id", account_id: "synthetic-account" } });

test("Codex projection accepts only bounded explicit access-only documents", () => {
  assert.equal(accessOnlyCodexDocument(document()), document());
  for (const raw of [document("a", "synthetic-refresh"), "{}", "null", "[]", "bad", JSON.stringify({tokens:{access_token:"a"}}), JSON.stringify({tokens:{access_token:"a",refresh_token:null}}), JSON.stringify({tokens:{access_token:"a",refresh_token:"",unknown:"secret"}}), JSON.stringify({OPENAI_API_KEY:"synthetic-key",tokens:{access_token:"a",refresh_token:""}}), document("a".repeat(70_000))]) {
    assert.throws(() => accessOnlyCodexDocument(raw), error => (error as {code:string}).code === "account_auth_needed");
  }
});

test("Codex projection snapshots validated bytes and refuses mirrors, symlinks and non-files", t => {
  mkdirSync(resolve(".cache"), { recursive: true });
  mkdirSync(resolve(".cache/t11g-trash"), { recursive: true });
  const root = mkdtempSync(resolve(".cache/hb-access-only-"));
  t.after(() => { const result = spawnSync("trash", ["--trash-dir", resolve(".cache/t11g-trash"), root], {encoding:"utf8"}); assert.equal(result.status, 0, result.stderr); });
  const home = join(root,"home"), cell = join(root,"cell");
  mkdirSync(home); mkdirSync(cell); mkdirSync(join(home,".codex"));
  const primary = join(home,"auth.json"), mirror = join(home,".codex/auth.json");
  writeFileSync(primary,document()); writeFileSync(mirror,document());
  const projection = prepareSandboxHarnessHome(cell,"codex",home);
  assert.equal(projection.files.length,2);
  for (const file of projection.files) assert.equal(readFileSync(file.source,"utf8"),document());
  const staged = snapshotAccessOnlyCodex(home,primary);
  const replacement = join(home,"next"); writeFileSync(replacement,document("new-access")); renameSync(replacement,primary);
  assert.equal(readFileSync(staged,"utf8"),document());
  assert.notEqual(snapshotAccessOnlyCodex(home,primary),staged);
  writeFileSync(mirror,document("a","synthetic-refresh"));
  assert.throws(() => prepareSandboxHarnessHome(cell,"codex",home), /auth_needed/);
  const linked = join(home,"linked"); symlinkSync(primary,linked);
  assert.throws(() => readAccessOnlyCodex(linked), /auth_needed/);
  assert.throws(() => readAccessOnlyCodex(home), /auth_needed/);
  const fifo = join(home,"fifo"); assert.equal(spawnSync("mkfifo",[fifo]).status,0);
  assert.throws(() => readAccessOnlyCodex(fifo), /auth_needed/);
  const nested = join(cell,"account"); mkdirSync(nested); writeFileSync(join(nested,"auth.json"),document());
  assert.throws(() => prepareSandboxHarnessHome(cell,"codex",nested), /Cell-controlled/);
});
