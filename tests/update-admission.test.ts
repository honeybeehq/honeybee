import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertNoUpdateReservation, assertUpdateAdmission, UPDATE_RECOVERY_CONTRACT, type UpdateAdmission } from "../src/updateAdmission.js";
import { parseRecoveryPlan, recoverySubjectDigest } from "../src/release/index.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "hon8-admission-"));
  const root = join(dir, "runtime");
  const recovery = parseRecoveryPlan(JSON.parse(await readFile(new URL("../contracts/release/v1/fixtures/recovery-plan.json", import.meta.url), "utf8")));
  recovery.subject.storageRequirements = [UPDATE_RECOVERY_CONTRACT];
  recovery.subjectDigest = recoverySubjectDigest(recovery.subject);
  for (const evidence of recovery.evidence) evidence.subjectDigest = recovery.subjectDigest;
  const reservation = { epoch: 1, id: "isolated-update", recoverySubjectDigest: recovery.subjectDigest, active: true };
  await mkdir(join(dir, "v2"));
  const db = new DatabaseSync(join(dir, "v2", "core.sqlite3"));
  db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE account_credential_authorities(phase TEXT); INSERT INTO meta VALUES('schema_version','27')");
  db.prepare("INSERT INTO meta VALUES('coordinated_update',?)").run(JSON.stringify(reservation));
  db.close();
  await mkdir(join(root, "current", "dist", "v2"), { recursive: true });
  const status = { contract: UPDATE_RECOVERY_CONTRACT, schemaVersion: 27, runtimeRoot: root,
    storePath: join(dir, "v2", "core.sqlite3"), blockers: [], reservation };
  const statusFile = join(root, "current", "dist", "v2", "cli.js");
  return { dir, root, statusFile, status, identity: recovery.subject.to.honeybee,
    admission: { reservation, recovery } satisfies UpdateAdmission };
}

test("a live owner for another store cannot authorize the local reservation", async () => {
  const f = await fixture();
  try {
    await writeFile(f.statusFile, `console.log(${JSON.stringify(JSON.stringify({ ...f.status, storePath: join(f.dir, "other.sqlite3") }))});`);
    await assert.rejects(assertUpdateAdmission(f.root, f.identity, f.admission), /incompatible live owner/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

for (const scenario of ["unknown requirement", "custom offline store", "released reservation", "live runtime mismatch"] as const) {
  test(`admission refuses ${scenario}`, async () => {
    const f = await fixture();
    try {
      if (scenario === "unknown requirement") {
        f.admission.recovery.subject.storageRequirements.push("unknown-storage-contract");
        f.admission.recovery.subjectDigest = recoverySubjectDigest(f.admission.recovery.subject);
        f.admission.reservation.recoverySubjectDigest = f.admission.recovery.subjectDigest;
        for (const e of f.admission.recovery.evidence) e.subjectDigest = f.admission.recovery.subjectDigest;
        const db = new DatabaseSync(join(f.dir, "v2", "core.sqlite3"));
        db.prepare("UPDATE meta SET value=? WHERE key='coordinated_update'").run(JSON.stringify(f.admission.reservation));
        db.close();
      }
      if (scenario === "custom offline store") await writeFile(join(f.dir, "v2", "config.json"), JSON.stringify({ storePath: join(f.dir, "other.sqlite3") }));
      if (scenario === "released reservation") {
        const db = new DatabaseSync(join(f.dir, "v2", "core.sqlite3"));
        db.prepare("UPDATE meta SET value=? WHERE key='coordinated_update'").run(JSON.stringify({ ...f.admission.reservation, active: false }));
        db.close();
      }
      if (scenario === "live runtime mismatch") await writeFile(f.statusFile, `console.log(${JSON.stringify(JSON.stringify({ ...f.status, runtimeRoot: join(f.dir, "other-runtime") }))});`);
      await assert.rejects(assertUpdateAdmission(f.root, f.identity, f.admission), /admission|migration|stale|incompatible/);
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  });
}

test("status query explicitly targets this node's data directory and socket", async () => {
  const f = await fixture();
  try {
    await writeFile(f.statusFile, `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(join(f.dir, "args.json"))}, JSON.stringify(process.argv.slice(2))); console.log(${JSON.stringify(JSON.stringify(f.status))});`);
    await assertUpdateAdmission(f.root, f.identity, f.admission);
    const args = JSON.parse(await readFile(join(f.dir, "args.json"), "utf8"));
    assert.deepEqual(args, ["update-owner", "status", "--data-dir", join(f.dir, "v2"), "--socket", join(f.dir, "v2", "hived.sock")]);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});


test("offline admission refuses while a daemon owns SQLite exclusively", async () => {
  const f = await fixture();
  const db = new DatabaseSync(join(f.dir, "v2", "core.sqlite3"));
  try {
    db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; UPDATE meta SET value=value; COMMIT");
    await assert.rejects(assertUpdateAdmission(f.root, f.identity, f.admission), /locked/);
  } finally { db.close(); await rm(f.dir, { recursive: true, force: true }); }
});


test("ordinary deploy accepts the live owner's initial unreserved status but cannot use it for recovery", async () => {
  const f = await fixture();
  try {
    const reservation = { epoch: 0, id: "", recoverySubjectDigest: "", active: false };
    await writeFile(f.statusFile, `console.log(${JSON.stringify(JSON.stringify({ ...f.status, reservation }))});`);
    await assert.doesNotReject(assertNoUpdateReservation(f.root));
    await assert.rejects(assertUpdateAdmission(f.root, f.identity, f.admission), /stale/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
