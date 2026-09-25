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
export type UpdateAdmission = { reservation: UpdateReservation; recovery: RecoveryPlan | RoleBoundRecoveryPlan };

/** Called inside the SAME deploy lock used by the daemon's reserve/release RPC. */
export async function assertUpdateAdmission(root: string, identity: ComponentIdentity, admission: UpdateAdmission): Promise<void> {
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
  const { reservation, blockers } = await readUpdateOwner(root);
  if (blockers || canonicalDigest(reservation) !== canonicalDigest(requested)) throw new Error("deploy: stale reservation or incompatible storage");
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

type Owner = { reservation: UpdateReservation | null; blockers: boolean };
async function readUpdateOwner(root: string): Promise<Owner> {
  const dataDir = standardStore(root);
  // With no database there cannot be a durable reservation. Do not query an
  // ambient/default socket belonging to a different node.
  if (!existsSync(join(dataDir, "core.sqlite3"))) return { reservation: null, blockers: false };
  let response: string | undefined;
  try {
    const { stdout } = await promisify(execFile)(process.execPath,
      [join(root, "current", "dist", "v2", "cli.js"), "update-owner", "status", "--data-dir", dataDir, "--socket", join(dataDir, "hived.sock")],
      { timeout: 10_000 });
    response = stdout;
  } catch {
    // The core holds SQLite EXCLUSIVE for its entire lifetime. A read can only
    // succeed after that owner exits; a busy/unknown store fails closed below.
  }
  if (response !== undefined) {
    const live = JSON.parse(response);
    if (live.contract !== UPDATE_RECOVERY_CONTRACT || ![27, 28, 30].includes(live.schemaVersion)
      || typeof live.runtimeRoot !== "string" || resolve(live.runtimeRoot) !== resolve(root)
      || typeof live.storePath !== "string" || resolve(live.storePath) !== join(dataDir, "core.sqlite3")
      || !Array.isArray(live.blockers)) throw new Error("deploy: incompatible live owner");
    // A never-reserved owner reports an explicit epoch-zero sentinel. It is
    // valid absence for ordinary deployment, never a usable admission token.
    const initial = live.reservation?.epoch === 0 && live.reservation.id === ""
      && live.reservation.recoverySubjectDigest === "" && live.reservation.active === false;
    return { reservation: live.reservation === null || initial ? null : parseUpdateReservation(live.reservation), blockers: live.schemaVersion !== 27 || live.blockers.length > 0 };
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
    if (schema?.value === "26" && !row) return { reservation: null, blockers: true };
    if (!["27", "28", "30"].includes(String(schema?.value))) throw new Error("deploy: incompatible storage; coordinated migration required");
    return { reservation: row ? parseUpdateReservation(JSON.parse(String(row.value))) : null,
      blockers: schema?.value !== "27" || !!db.prepare("SELECT 1 FROM account_credential_authorities WHERE phase <> 'disabled' LIMIT 1").get() };
  } finally { db.close(); }
}

export function readOfflineUpdateReservation(root: string): UpdateReservation {
  const owner = readOfflineOwner(root);
  if (!owner.reservation || owner.blockers) throw new Error("deploy: stale reservation or incompatible storage; coordinated migration required");
  return owner.reservation;
}
