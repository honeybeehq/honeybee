import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertUpdateAdmission, readOfflineUpdateReservation, UPDATE_RECOVERY_CONTRACT, type UpdateAdmission } from "../src/updateAdmission.js";
import { parseRecoveryPlan, recoverySubjectDigest } from "../src/release/index.js";
import * as v2 from "../src/release/v2.js";

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

async function roleBoundFixture() {
  const f = await fixture();
  const recovery = v2.parseRecoveryPlan(JSON.parse(await readFile(new URL("../contracts/release/v2/fixtures/remote-recovery.json", import.meta.url), "utf8")));
  recovery.subject.storageRequirements = [UPDATE_RECOVERY_CONTRACT];
  recovery.subject.from.honeybee.version = "0.0.9";
  recovery.subject.from.honeybee.artifact.sha256 = `sha256:${"f".repeat(64)}`;
  recovery.subjectDigest = v2.recoverySubjectDigest(recovery.subject);
  for (const evidence of recovery.evidence) evidence.subjectDigest = recovery.subjectDigest;
  const reservation = { ...f.admission.reservation, recoverySubjectDigest: recovery.subjectDigest };
  const db = new DatabaseSync(join(f.dir, "v2", "core.sqlite3"));
  db.prepare("UPDATE meta SET value=? WHERE key='coordinated_update'").run(JSON.stringify(reservation));
  db.close();
  return { ...f, admission: { recovery, reservation }, identity: recovery.subject.to.honeybee };
}

test("deploy admits exact v2 Honeybee forward and rollback identities with a foreign caller", async () => {
  const f = await roleBoundFixture();
  try {
    assert.equal(f.admission.recovery.subject.from.caller.target, "darwin-arm64");
    assert.equal(f.identity.target, "linux-x64");
    await assertUpdateAdmission(f.root, f.identity, f.admission);
    await assertUpdateAdmission(f.root, f.admission.recovery.subject.from.honeybee, f.admission);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

for (const scenario of ["unrelated Honeybee", "caller artifact", "changed caller", "mixed versions", "unknown version", "missing evidence", "released reservation", "active authority", "locked storage", "unverified storage", "unknown requirement"] as const) {
  test(`v2 admission preserves refusal for ${scenario}`, async () => {
    const f = await roleBoundFixture();
    const db = new DatabaseSync(join(f.dir, "v2", "core.sqlite3"));
    try {
      const { recovery, reservation } = f.admission;
      if (scenario === "unrelated Honeybee") f.identity = { ...f.identity, artifact: { ...f.identity.artifact, sha256: `sha256:${"0".repeat(64)}` } };
      if (scenario === "caller artifact") {
        await assert.rejects(assertUpdateAdmission(f.root, recovery.subject.to.caller, f.admission), /no exact automatic recovery admission/);
        return;
      }
      if (scenario === "changed caller") recovery.subject.from.caller.artifact.sha256 = `sha256:${"0".repeat(64)}`;
      if (scenario === "mixed versions") Object.assign(recovery.subject.to, { apiary: recovery.subject.to.caller });
      if (scenario === "unknown version") Object.assign(recovery, { schemaVersion: 3 });
      if (scenario === "missing evidence") recovery.evidence = [];
      if (scenario === "released reservation") db.prepare("UPDATE meta SET value=? WHERE key='coordinated_update'").run(JSON.stringify({ ...reservation, active: false }));
      if (scenario === "active authority") db.exec("INSERT INTO account_credential_authorities VALUES('enabled')");
      if (scenario === "locked storage") db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; UPDATE meta SET value=value; COMMIT");
      if (scenario === "unverified storage") recovery.storage = "unverified";
      if (scenario === "unknown requirement") {
        recovery.subject.storageRequirements.push("unknown-storage-contract");
        recovery.subjectDigest = v2.recoverySubjectDigest(recovery.subject);
        for (const evidence of recovery.evidence) evidence.subjectDigest = recovery.subjectDigest;
        reservation.recoverySubjectDigest = recovery.subjectDigest;
        db.prepare("UPDATE meta SET value=? WHERE key='coordinated_update'").run(JSON.stringify(reservation));
      }
      await assert.rejects(assertUpdateAdmission(f.root, f.identity, f.admission), /Invalid|admission|stale|incompatible|locked/);
    } finally { db.close(); await rm(f.dir, { recursive: true, force: true }); }
  });
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


test("the live owner's initial unreserved status cannot be used for recovery", async () => {
  const f = await fixture();
  try {
    const reservation = { epoch: 0, id: "", recoverySubjectDigest: "", active: false };
    await writeFile(f.statusFile, `console.log(${JSON.stringify(JSON.stringify({ ...f.status, reservation }))});`);
    await assert.rejects(assertUpdateAdmission(f.root, f.identity, f.admission), /stale/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

for (const schemaVersion of [28, 30]) {
  for (const live of [false, true]) {
    test(`schema ${schemaVersion} ${live ? "live" : "offline"} owner does not widen recovery`, async () => {
      const f = await fixture();
      try {
        const db = new DatabaseSync(join(f.dir, "v2", "core.sqlite3"));
        db.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run(String(schemaVersion));
        db.close();
        if (live) await writeFile(f.statusFile, `console.log(${JSON.stringify(JSON.stringify({ ...f.status, schemaVersion }))});`);
        await assert.rejects(assertUpdateAdmission(f.root, f.identity, f.admission), /incompatible storage/);
        assert.throws(() => readOfflineUpdateReservation(f.root), /incompatible storage/);
      } finally { await rm(f.dir, { recursive: true, force: true }); }
    });
  }
}
