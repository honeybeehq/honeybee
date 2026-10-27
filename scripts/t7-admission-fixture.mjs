import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { packRuntimeArtifact, sha256File } from "../dist/runtimeArtifact.js";
import { parseRecoveryPlan, recoverySubjectDigest } from "../dist/release/index.js";
import { UPDATE_RECOVERY_CONTRACT } from "../dist/updateReservation.js";
import { persistNodePin, probeNativeNode } from "../dist/nodeRuntime.js";
import { backupStoreOffline } from "../v2/core/src/storeBackup.ts";

assert.equal(process.platform, "linux", "This fixture is Linux satellite only");
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === "--expect" && ["blocked", "admitted"].includes(args[1])), "Usage: node scripts/t7-admission-fixture.mjs [--expect blocked|admitted]");
const expected = args[1] ?? "admitted";
const repo = resolve(import.meta.dirname, "..");
const output = join(repo, ".artifacts", "t7-admission");
mkdirSync(output, { recursive: true });
const work = mkdtempSync("/tmp/hb-t7-");
writeFileSync(join(output, "latest.json"), JSON.stringify({ work }));
const oldRevision = execFileSync("git", ["rev-parse", "806cdf18^{commit}"], { cwd: repo, encoding: "utf8" }).trim();
const oldSource = mkdtempSync(join(output, "old-source-"));
execFileSync("tar", ["-xf", "-", "-C", oldSource], { input: execFileSync("git", ["archive", oldRevision, "v2", "src"], { cwd: repo, maxBuffer: 64 * 1024 * 1024 }) });
const old = await import(pathToFileURL(join(oldSource, "v2/core/src/index.ts")).href);
const current = await import("../v2/core/src/index.ts");
assert.equal(old.SCHEMA_VERSION, 44);
assert.ok(current.SCHEMA_VERSION >= 48);
const schema48Revision = "5bf458692e988ec54f9331bfc548a33c65236ee8";
const schema48Source = mkdtempSync(join(output, "schema48-source-"));
execFileSync("tar", ["-xf", "-", "-C", schema48Source], { input: execFileSync("git", ["archive", schema48Revision, "v2", "src"], { cwd: repo, maxBuffer: 64 * 1024 * 1024 }) });
const schema48Core = await import(pathToFileURL(join(schema48Source, "v2/core/src/index.ts")).href);
assert.equal(schema48Core.SCHEMA_VERSION, 48);
const pin = probeNativeNode(process.execPath);
const candidateSha = "a".repeat(40);
const results = [];
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const logFile = join(work, "decisions.tsv");
writeFileSync(logFile, "ts\tphase\tdecision\twhy\tevidence\tresult\n");

for (const schema of [...new Set([44, 48, current.SCHEMA_VERSION])]) {
  for (const receiptMode of ["valid", "missing", "stale"]) {
    const name = `schema${schema}-${receiptMode}`;
    const dir = join(work, name);
    const runtime = join(dir, "runtime");
    const data = join(dir, "v2");
    const stage = join(dir, "stage");
    const calls = join(dir, "calls.jsonl");
    const bin = join(dir, "bin");
    for (const path of [data, join(stage, "dist", "v2"), bin, join(dir, "home"), join(dir, "services")]) mkdirSync(path, { recursive: true });
    const sourceSha = schema === 44 ? oldRevision : schema === 48 ? schema48Revision : execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const sourceBuild = { schemaVersion: 1, component: "honeybee", version: "0.0.1", packageVersion: "0.0.1", sourceRevision: sourceSha, dirty: false, release: true, target: `${process.platform}-${process.arch}` };
    const candidateBuild = { ...sourceBuild, sourceRevision: candidateSha };
    const oldDir = join(runtime, sourceSha, "dist", "v2");
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(runtime, sourceSha, "dist", "build-identity.json"), JSON.stringify(sourceBuild));
    writeFileSync(join(oldDir, "cli.js"), `var SCHEMA_VERSION = ${schema};\nvar PROTOCOL = "v2/1";\nprocess.exit(1);\n`);
    execFileSync("ln", ["-s", sourceSha, join(runtime, "current")]);
    const shim = `const fs = require("node:fs");\nconst child = require("node:child_process");\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args)+"\\n");\nif (args.slice(0,3).join(" ") === "v2 store backup") {\n  if (${JSON.stringify(receiptMode)} === "missing") { console.log(JSON.stringify({format:1,integrityCheck:"ok",receiptPath:${JSON.stringify(join(dir, "missing.json"))},sourceBuild:${JSON.stringify(JSON.stringify(sourceBuild))}})); process.exit(0); }\n  if (${JSON.stringify(receiptMode)} === "stale") { console.log(fs.readFileSync(${JSON.stringify(join(dir, "stale.json"))},"utf8")); process.exit(0); }\n  const result = child.spawnSync(process.execPath,[${JSON.stringify(join(repo, "dist", "cli.js"))},...args],{env:process.env,encoding:"utf8"});\n  process.stdout.write(result.stdout || ""); process.stderr.write(result.stderr || ""); process.exit(result.status ?? 1);\n}\nif (args.slice(0,2).join(" ") === "v2 deploy-info") { console.log(JSON.stringify({pid:process.pid,startedAt:1,nodeVersion:process.version,identity:{sourceRevision:${JSON.stringify(candidateSha)}}})); process.exit(0); }\nif (args.slice(0,2).join(" ") === "v2 daemon" && ["install","stop","start","status"].includes(args[2])) { console.log(JSON.stringify({running:args[2] === "status",service:{installed:false}})); process.exit(0); }\nprocess.exit(91);\n`;
    writeFileSync(join(stage, "dist", "cli.js"), shim);
    writeFileSync(join(runtime, sourceSha, "dist", "cli.js"), shim);
    writeFileSync(join(stage, "dist", "v2", "cli.js"), `var SCHEMA_VERSION = ${current.SCHEMA_VERSION};\nvar PROTOCOL = "v2/1";\nvar UPDATE_RECOVERY_CONTRACT = "${UPDATE_RECOVERY_CONTRACT}";\nprocess.exit(1);\n`);
    writeFileSync(join(stage, "dist", "build-identity.json"), JSON.stringify(candidateBuild));
    writeFileSync(join(stage, "package.json"), JSON.stringify({ name: "honeybee", version: "0.0.1", engines: { node: ">=24" } }));
    cpSync(join(repo, "contracts", "execution", "v1"), join(stage, "contracts", "execution", "v1"), { recursive: true });
    const packed = await packRuntimeArtifact({ artifactDir: stage, sha: candidateSha, outDir: join(dir, "archive"), gate: "full" });
    const identity = { component: "honeybee", version: "0.0.1", sourceRevision: candidateSha, target: `${process.platform}-${process.arch}`, artifact: { url: "https://example.test/t7-fixture.tgz", sha256: `sha256:${(await sha256File(packed.tarballPath)).sha256}` } };
    const recovery = parseRecoveryPlan(JSON.parse(readFileSync(join(repo, "contracts/release/v1/fixtures/recovery-plan.json"), "utf8")));
    recovery.subject.to.honeybee = identity;
    recovery.subject.storageRequirements = [UPDATE_RECOVERY_CONTRACT];
    recovery.subjectDigest = recoverySubjectDigest(recovery.subject);
    for (const evidence of recovery.evidence) evidence.subjectDigest = recovery.subjectDigest;
    const api = schema === 44 ? old : schema === 48 ? schema48Core : current;
    const storePath = join(data, "core.sqlite3");
    const store = api.openCoreStore(storePath);
    let reservation;
    try {
      const { bee, runtime: generation } = store.createBee({ name: "t7-fixture", agent: "stub", substrate: "hsr", cwd: dir });
      store.updateRuntimeState(bee.id, generation.generation, "stopped", { exitCause: "clean" });
      reservation = store.reserveUpdate({ id: "t7-fixture", recoverySubjectDigest: recovery.subjectDigest, expectedEpoch: 0 });
    } finally { store.close(); }
    persistNodePin(data, pin);
    if (receiptMode === "stale") {
      const stale = await backupStoreOffline(storePath, JSON.stringify(sourceBuild));
      writeFileSync(join(dir, "stale.json"), JSON.stringify(stale));
      const changed = api.openCoreStore(storePath);
      try { changed.releaseUpdate({ ...reservation }); changed.reserveUpdate({ id: reservation.id, recoverySubjectDigest: reservation.recoverySubjectDigest, expectedEpoch: reservation.epoch }); } finally { changed.close(); }
      const db = new DatabaseSync(storePath, { readOnly: true });
      try { reservation = JSON.parse(db.prepare("SELECT value FROM meta WHERE key='coordinated_update'").get().value); } finally { db.close(); }
    }
    writeFileSync(join(dir, "identity.json"), JSON.stringify(identity));
    writeFileSync(join(dir, "admission.json"), JSON.stringify({ reservation, recovery }));
    writeFileSync(join(bin, "systemctl"), `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(calls)},JSON.stringify(["systemctl",...process.argv.slice(2)])+"\\n");\nif(process.argv.includes("show")) console.log("ActiveState=inactive\\nMainPID=0");\nelse if(!process.argv.includes("daemon-reload")) process.exit(92);\n`, { mode: 0o755 });
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: join(dir, "home"), LANG: "C.UTF-8", HIVE_STORE_ROOT: dir, HIVE_V2_DATA_DIR: data, HIVE_V2_SERVICE_DIR: join(dir, "services"), HIVE_V2_SERVICE_LABEL: "t7-fixture", HIVE_NODE_PATH: pin.path, HIVE_NO_KEYCHAIN: "1", XDG_CONFIG_HOME: join(dir, "home", ".config") };
    const before = hash(storePath);
    const command = [join(repo, "dist", "cli.js"), "deploy", "--artifact", packed.tarballPath, "--identity", join(dir, "identity.json"), "--admission", join(dir, "admission.json"), "--expected-current", sourceSha];
    const result = spawnSync(process.execPath, command, { cwd: dir, env, encoding: "utf8", timeout: 30000 });
    writeFileSync(join(dir, "stdout.log"), result.stdout ?? "");
    writeFileSync(join(dir, "stderr.log"), result.stderr ?? "");
    const activated = readlinkSync(join(runtime, "current")) === candidateSha;
    const callList = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
    const check = new DatabaseSync(storePath, { readOnly: true });
    try { assert.equal(Number(check.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), schema); assert.equal(check.prepare("PRAGMA integrity_check").get().integrity_check, "ok"); } finally { check.close(); }
    assert.equal(hash(storePath), before, `${name}: deploy fixture changed database bytes`);
    const row = { name, schema, receiptMode, expected, status: result.status, signal: result.signal, error: result.error?.message, activated, oldRevision, candidateSha, contract: UPDATE_RECOVERY_CONTRACT, command: [process.execPath, ...command], stdout: result.stdout, stderr: result.stderr, calls: callList, databaseUnchanged: true, fixture: dir };
    results.push(row);
    writeFileSync(join(work, "results.json"), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(row));
    const success = expected === "admitted" && receiptMode === "valid";
    assert.equal(result.status, success ? 0 : 1, `${name}: unexpected exit; see ${dir}`);
    if (expected === "blocked") assert.match(result.stderr, /incompatible storage|recovery admission/, `${name}: failed before admission`);
    assert.equal(activated, success, `${name}: unexpected current target`);
    assert.equal(callList.some(call => call[0] === "v2" && call[1] === "daemon"), success, `${name}: unexpected activation attempt`);
    writeFileSync(logFile, `${new Date().toISOString()}\tfixture\t${name} exercised real deploy CLI\tverify backup-bound admission without a daemon\t${join(dir, "stdout.log")}\t${success ? "admitted" : "refused"}\n`, { flag: "a" });
  }
}
console.log(`PASS ${results.length} isolated deploy fixtures (${expected}); evidence ${work}`);
