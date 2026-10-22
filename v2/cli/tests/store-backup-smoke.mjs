import { persistNodePin, probeNativeNode } from "../../../src/nodeRuntime.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION } from "../../core/src/schema.ts";

const root = resolve(import.meta.dirname, "../../..");
const sourceRevision = execFileSync("git", ["rev-parse", "296b92e8^"], { cwd: root, encoding: "utf8" }).trim();
mkdirSync(join(root, ".audit"), { recursive: true });
const source = mkdtempSync(join(root, ".audit", "t5-old-source-"));
execFileSync("tar", ["-x", "-C", source], { input: execFileSync("git", ["archive", sourceRevision, "v2", "src"], { cwd: root, maxBuffer: 64 * 1024 * 1024 }) });
const old = await import(pathToFileURL(join(source, "v2/core/src/index.ts")).href);
assert.equal(old.SCHEMA_VERSION, 44);
const fixture = mkdtempSync("/tmp/hb-t5-");
const data = join(fixture, "v2");
mkdirSync(data, { mode: 0o700 });
const storePath = join(data, "core.sqlite3");
persistNodePin(data, probeNativeNode(process.execPath));
const prior = old.openCoreStore(storePath);
const { bee, runtime } = prior.createBee({ name: "restore-proof", agent: "claude", substrate: "tmux", cwd: data });
prior.updateRuntimeState(bee.id, runtime.generation, "stopped", { exitCause: "clean" });
const logical = prior.dumpState();
prior.close();
console.log(`Created genuine schema44 store with old core ${sourceRevision}; logical bee rows=${logical.bees.length}`);
const cli = join(root, "dist/cli.js");
const runtimeRoot = join(fixture, "runtime");
const priorBuildDir = join(runtimeRoot, sourceRevision, "dist");
mkdirSync(priorBuildDir, { recursive: true });
writeFileSync(join(priorBuildDir, "build-identity.json"), JSON.stringify({ component: "honeybee", sourceRevision, target: `${process.platform}-${process.arch}`, fixture: "archived schema44 core" }));
const { backupBeforeSwap } = await import(pathToFileURL(join(root, "dist/commands/deploy.js")).href);
const deployBackup = await backupBeforeSwap({ root: runtimeRoot, installedDir: root, sourceRevision });
console.log(`Production pre-swap hook finalized schema44 receipt ${deployBackup.receiptPath}`);
const logPath = join(data, "candidate.log");
const fd = openSync(logPath, "w", 0o600);
const child = spawn(process.execPath, [cli, "v2", "daemon", "run", "--data-dir", data], { cwd: root, stdio: ["ignore", fd, fd] });
closeSync(fd);
const exited = once(child, "exit");
let receiptPath;
try {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (existsSync(`${storePath}.backups`)) {
      const names = readdirSync(`${storePath}.backups`).filter(name => name.endsWith(".json") && join(`${storePath}.backups`, name) !== deployBackup.receiptPath);
      if (names.length && existsSync(join(data, "hived.endpoint.json"))) { receiptPath = join(`${storePath}.backups`, names[0]); break; }
    }
    if (child.exitCode !== null) throw new Error(`Candidate exited before migration: ${readFileSync(logPath, "utf8")}`);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.ok(receiptPath, `No migration receipt: ${readFileSync(logPath, "utf8")}`);
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  await exited;
}
const upgraded = new DatabaseSync(storePath);
assert.equal(Number(upgraded.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), SCHEMA_VERSION);
upgraded.close();
const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
assert.equal(receipt.schemaVersion, 44);
console.log(`Candidate binary migrated 44 -> ${SCHEMA_VERSION}; finalized receipt ${receiptPath}`);
console.log(execFileSync(process.execPath, [cli, "v2", "store", "restore", "--from", receiptPath, "--data-dir", data], { encoding: "utf8" }).trim());
const restored = old.openCoreStore(storePath);
assert.deepEqual(restored.dumpState(), logical);
restored.close();
const checked = new DatabaseSync(storePath);
assert.equal(checked.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, "44");
assert.equal(checked.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
checked.close();
console.log(`PASS old schema44 core reopened restored store; identical logical rows; integrity_check=ok; daemon log ${logPath}`);
writeFileSync(join(data, "fixture-evidence.json"), JSON.stringify({ sourceRevision, candidateSchema: SCHEMA_VERSION, receiptPath, logPath, identicalLogicalRows: true }, null, 2), { mode: 0o600 });
