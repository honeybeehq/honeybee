import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { buildSync } from "esbuild";
import { openCoreStore, SCHEMA_VERSION } from "../../v2/core/src/index.ts";

const baseline = "77d877c0c9cb19c4e93451635ae27d9f713a8765";
const baseline46 = "8d71abd2ad99a16025cd1c6e0cd8b4b3b8401c7a";
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
function digest(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
    const rows = tables.map(table => ({ ...table, rows: db.prepare(`SELECT * FROM "${String(table.name).replaceAll('"', '""')}" ORDER BY rowid`).all() }));
    return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  } finally { db.close(); }
}

test("schema48: backup, actual pinned47 writer refusal leaves logical digest unchanged, forward receipts survive", () => {
  assert.equal(SCHEMA_VERSION, 48);
  const scratch = mkdtempSync(join(tmpdir(), "ho48-")), oldSource = join(scratch, "baseline"), path = join(scratch, "store.sqlite3");
  try {
    mkdirSync(oldSource);
    const archive = execFileSync("git", ["archive", baseline, "src", "v2", "package.json"], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    execFileSync("tar", ["-x", "-C", oldSource], { input: archive });
    symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"), "dir");
    const oldModule = join(scratch, "schema47.mjs");
    buildSync({ entryPoints: [join(oldSource, "v2/core/src/index.ts")], bundle: true, platform: "node", format: "esm", outfile: oldModule, nodePaths: [join(root, "node_modules")], external: ["jsonc-parser"], logLevel: "silent" });
    const source46 = join(scratch, "baseline46"); mkdirSync(source46);
    execFileSync("tar", ["-x", "-C", source46], { input: execFileSync("git", ["archive", baseline46, "src", "v2", "package.json"], { cwd: root, maxBuffer: 64 * 1024 * 1024 }) });
    const module46 = join(scratch, "schema46.mjs");
    buildSync({ entryPoints: [join(source46, "v2/core/src/index.ts")], bundle: true, platform: "node", format: "esm", outfile: module46, nodePaths: [join(root, "node_modules")], external: ["jsonc-parser"], logLevel: "silent" });
    const seed = `import {openCoreStore,SCHEMA_VERSION} from ${JSON.stringify(module46)}; if(SCHEMA_VERSION!==46)throw Error('wrong baseline'); const s=openCoreStore(process.argv[1],{ephemeral:true});const {bee}=s.createBee({name:'schema47',agent:'claude',substrate:'tmux',cwd:'/tmp'}); s.send(bee.id,'old human',{senderKind:'human'});s.close();console.log(bee.id);`;
    const beeId = execFileSync(process.execPath, ["--input-type=module", "-e", seed, path], { encoding: "utf8" }).trim();
    copyFileSync(path, join(scratch, "backup46.sqlite3"));
    const backup46Digest = digest(path);
    assert.equal(digest(join(scratch, "backup46.sqlite3")), backup46Digest);
    execFileSync(process.execPath, ["--input-type=module", "-e", `import {openCoreStore} from ${JSON.stringify(oldModule)}; const s=openCoreStore(process.argv[1],{ephemeral:true}); s.close();`, path]);
    copyFileSync(path, join(scratch, "backup47.sqlite3"));
    const backupDigest = digest(path);
    assert.equal(digest(join(scratch, "backup47.sqlite3")), backupDigest);
    let store = openCoreStore(path, { ephemeral: true });
    store.setHumanOutputMode(beeId, "explicit", "enable");
    const params = { beeId, text: "new explicit output", idempotencyKey: "tell" };
    const tell = store.tellHuman(params); store.close();
    const before = digest(path);
    for (const module of [module46, oldModule]) {
      const refusal = `import {openCoreStore} from ${JSON.stringify(module)};try{const s=openCoreStore(process.argv[1],{ephemeral:true});s.close();process.exit(2)}catch(e){if(e.kind!=='schema_newer')throw e;console.log(e.kind)}`;
      const old = spawnSync(process.execPath, ["--input-type=module", "-e", refusal, path], { encoding: "utf8" });
      assert.equal(old.status, 0, old.stderr); assert.equal(old.signal, null); assert.equal(old.stdout.trim(), "schema_newer");
      assert.equal(digest(path), before);
    }
    store = openCoreStore(path, { ephemeral: true });
    assert.deepEqual(store.tellHuman(params), { ...tell, deduped: true });
    assert.equal(store.getBee(beeId)!.humanOutputMode, "explicit"); store.close();
    const db = new DatabaseSync(path); assert.equal(db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok"); assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []); db.close();
    console.log(JSON.stringify({ baseline, baseline46, migrationPath: [46,47,48], backup46Digest, backupDigest, refusal: "schema_newer", logicalDigestUnchanged: true, forwardReceiptIntact: true, schemaVersion: 48 }));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
