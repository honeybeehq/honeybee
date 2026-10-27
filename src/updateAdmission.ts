import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { recordedSocketPath } from "./daemonSocketPath.js";
import { childNodePath, nativeNodeEnv } from "./nodeRuntime.js";
/** Read-only deploy admission. SQLite remains the daemon's sole authority. */
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseRecoveryPlan, type RecoveryPlan, type ComponentIdentity } from "./release/index.js";
import { parseRecoveryPlan as parseRoleBoundRecoveryPlan, type RecoveryPlan as RoleBoundRecoveryPlan } from "./release/v2.js";
import { canonicalDigest } from "./comb/canonical.js";
import { UPDATE_RECOVERY_CONTRACT, parseUpdateReservation, type UpdateReservation } from "./updateReservation.js";
export { UPDATE_RECOVERY_CONTRACT } from "./updateReservation.js";
export type BackupAdmission = { receiptPath: string; startedAt: number; candidateSchemaVersion: number };
export class UpdateAdmissionError extends Error {
  constructor(readonly code: "schema_newer" | "backup_missing" | "backup_stale" | "backup_invalid", detail: string) {
    super(`deploy: ${code}: ${detail}`);
    this.name = "UpdateAdmissionError";
  }
}
export type UpdateAdmission = { reservation: UpdateReservation; recovery: RecoveryPlan | RoleBoundRecoveryPlan };

/** Called inside the SAME deploy lock used by the daemon's reserve/release RPC. */
export async function assertUpdateRecoveryAdmission(root: string, identity: ComponentIdentity, admission: UpdateAdmission, candidateSchemaVersion: number): Promise<{ schemaVersion: number; reservation: UpdateReservation }> {
  if (!Number.isSafeInteger(candidateSchemaVersion) || candidateSchemaVersion < 1) throw new UpdateAdmissionError("backup_invalid", "candidate schema capability missing");
  const requested = parseUpdateReservation(admission.reservation);
  // Recovery plans have no top-level version field. Their closed combination
  // shapes discriminate readers; never convert a plan or retry a failed parser.
  const recovery = Object.hasOwn(admission.recovery?.subject?.from ?? {}, "caller")
    ? parseRoleBoundRecoveryPlan(admission.recovery)
    : parseRecoveryPlan(admission.recovery);
  if (!requested.active || recovery.subjectDigest !== requested.recoverySubjectDigest
    || recovery.state !== "compatible" || recovery.storage !== "compatible"
    || recovery.subject.strategy !== "rollback" || recovery.subject.requiresInterruption
    || recovery.subject.storageRequirements.length !== 1 || recovery.subject.storageRequirements[0] !== UPDATE_RECOVERY_CONTRACT
    || ![recovery.subject.from.honeybee, recovery.subject.to.honeybee].some(h => canonicalDigest(h) === canonicalDigest(identity))) {
    throw new Error("deploy: no exact automatic recovery admission");
  }
  const { reservation, blockers, schemaVersion } = await readUpdateOwner(root);
  if (schemaVersion > candidateSchemaVersion) throw new UpdateAdmissionError("schema_newer", `store schema ${schemaVersion} exceeds candidate schema ${candidateSchemaVersion}`);
  if (blockers || canonicalDigest(reservation) !== canonicalDigest(requested)) throw new Error("deploy: stale reservation or incompatible storage");
  return { schemaVersion, reservation: requested };
}

export async function assertUpdateAdmission(root: string, identity: ComponentIdentity, admission: UpdateAdmission, backup: BackupAdmission): Promise<void> {
  const owner = await assertUpdateRecoveryAdmission(root, identity, admission, backup.candidateSchemaVersion);
  verifyBackup(root, owner.schemaVersion, backup, owner.reservation);
}

function verifyBackup(root: string, schemaVersion: number, backup: BackupAdmission, reservation: UpdateReservation): void {
  if (!backup.receiptPath || !existsSync(backup.receiptPath)) throw new UpdateAdmissionError("backup_missing", "pre-deploy backup receipt missing");
  try {
    const receipt = JSON.parse(readFileSync(backup.receiptPath, "utf8"));
    const createdAt = Date.parse(receipt.createdAt);
    if (!Number.isFinite(createdAt) || createdAt < backup.startedAt || createdAt > Date.now()) throw new UpdateAdmissionError("backup_stale", "receipt was not created for this deploy attempt");
    const storePath = join(standardStore(root), "core.sqlite3");
    if (receipt.format !== 1 || receipt.integrityCheck !== "ok" || receipt.storePath !== storePath
      || receipt.receiptPath !== resolve(backup.receiptPath) || receipt.schemaVersion !== schemaVersion
      || typeof receipt.backupPath !== "string" || resolve(receipt.backupPath, "..") !== `${storePath}.backups`
      || receipt.sha256 !== createHash("sha256").update(readFileSync(receipt.backupPath)).digest("hex")) throw new Error("receipt paths, schema or checksum mismatch");
    const db = new DatabaseSync(receipt.backupPath, { readOnly: true });
    try {
      const integrity = db.prepare("PRAGMA integrity_check").all();
      const schema = Number(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value);
      const ddl = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").all();
      const row = db.prepare("SELECT value FROM meta WHERE key='coordinated_update'").get();
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok" || schema !== schemaVersion
        || receipt.ddlDigest !== createHash("sha256").update(JSON.stringify(ddl)).digest("hex")
        || !row || canonicalDigest(parseUpdateReservation(JSON.parse(String(row.value)))) !== canonicalDigest(reservation)) throw new Error("backup integrity, schema or reservation mismatch");
    } finally { db.close(); }
  } catch (error) {
    if (error instanceof UpdateAdmissionError) throw error;
    throw new UpdateAdmissionError("backup_invalid", error instanceof Error ? error.message : String(error));
  }
}

function standardStore(root: string): string {
  const dataDir = resolve(root, "..", "v2"), config = join(dataDir, "config.json");
  if (existsSync(config)) {
    const value = JSON.parse(readFileSync(config, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)
      || (value.storePath !== undefined && value.storePath !== join(dataDir, "core.sqlite3"))
      || (value.socketPath !== undefined && value.socketPath !== join(dataDir, "hived.sock"))) {
      throw new Error("deploy: custom storage/socket requires coordinated migration");
    }
  }
  return dataDir;
}

type Owner = { reservation: UpdateReservation | null; blockers: boolean; schemaVersion: number };
async function readUpdateOwner(root: string): Promise<Owner> {
  const dataDir = standardStore(root);
  // With no database there cannot be a durable reservation. Do not query an
  // ambient/default socket belonging to a different node.
  if (!existsSync(join(dataDir, "core.sqlite3"))) return { reservation: null, blockers: false, schemaVersion: 0 };
  let response: string | undefined;
  try {
    const { stdout } = await promisify(execFile)(childNodePath(dataDir, true),
      ["--input-type=module", "--eval", `const { runV2Cli } = await import(${JSON.stringify(pathToFileURL(join(root, "current", "dist", "v2", "cli.js")).href)}); process.exitCode = await runV2Cli(process.argv.slice(1));`, "update-owner", "status", "--data-dir", dataDir, "--socket", recordedSocketPath(dataDir)],
      { timeout: 10_000, env: nativeNodeEnv() });
    response = stdout;
  } catch {
    // The core holds SQLite EXCLUSIVE for its entire lifetime. A read can only
    // succeed after that owner exits; a busy/unknown store fails closed below.
  }
  if (response !== undefined) {
    const live = JSON.parse(response);
    if (![UPDATE_RECOVERY_CONTRACT, "honeybee-v27-disabled-authority-v1"].includes(live.contract) || !Number.isSafeInteger(live.schemaVersion) || live.schemaVersion < 27 || live.schemaVersion === 29
      || typeof live.runtimeRoot !== "string" || resolve(live.runtimeRoot) !== resolve(root)
      || typeof live.storePath !== "string" || resolve(live.storePath) !== join(dataDir, "core.sqlite3")
      || !Array.isArray(live.blockers)) throw new Error("deploy: incompatible live owner");
    // A never-reserved owner reports an explicit epoch-zero sentinel. It is
    // valid absence for ordinary deployment, never a usable admission token.
    const initial = live.reservation?.epoch === 0 && live.reservation.id === ""
      && live.reservation.recoverySubjectDigest === "" && live.reservation.active === false;
    return { reservation: live.reservation === null || initial ? null : parseUpdateReservation(live.reservation), schemaVersion: live.schemaVersion, blockers: live.blockers.length > 0 };
  }
  return readOfflineOwner(root);
}

function readOfflineOwner(root: string): Owner {
  const dataDir = standardStore(root);
  const db = new DatabaseSync(join(dataDir, "core.sqlite3"), { readOnly: true });
  try {
    db.exec("BEGIN");
    const schema = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
    const row = db.prepare("SELECT value FROM meta WHERE key='coordinated_update'").get();
    // v26 predates reservations; allow its ordinary offline deployment, never
    // automatic recovery admission. Unknown schemas defer to migration.
    if (schema?.value === "26" && !row) return { reservation: null, blockers: true, schemaVersion: 26 };
    const schemaVersion = Number(schema?.value);
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 27 || schemaVersion === 29) throw new Error("deploy: incompatible storage; coordinated migration required");
    return { reservation: row ? parseUpdateReservation(JSON.parse(String(row.value))) : null,
      schemaVersion, blockers: !!db.prepare("SELECT 1 FROM account_credential_authorities WHERE phase <> 'disabled' LIMIT 1").get() };
  } finally { db.close(); }
}

export function readOfflineUpdateReservation(root: string): UpdateReservation {
  const owner = readOfflineOwner(root);
  if (!owner.reservation || owner.blockers) throw new Error("deploy: stale reservation or incompatible storage; coordinated migration required");
  return owner.reservation;
}
