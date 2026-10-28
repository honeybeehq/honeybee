import type { SatelliteDecision } from "./satelliteEligibility.ts";
import type { AdmissionBasis, BeeRow, LandingFixerPolicy } from "../../core/src/types.ts";
import type { RpcConn } from "./rpc.ts";
import { RpcError } from "./protocol.ts";


export function humanAdmission(conn: RpcConn): boolean {
  if (conn.phoneLane === "interim-v1") return false;
  if (conn.workstationAdmission) return conn.ingress === "local_unix" && conn.registeredApiary === true && conn.workstationAdmission.intent === "human" && !conn.authenticatedBeeId;
  return conn.ingress === "local_unix" && !conn.registeredApiary && !conn.authenticatedBeeId
    && conn.caller?.client === "hive-cli" && conn.caller.runtimeBeeId === null && conn.caller.runtimeContext === false;
}

export function admissionFailure(operation: string, reason: string, nodeKind = "workstation", target: Record<string, unknown> = {}): RpcError {
  const satellite = target.satellite as { name?: string; nodeId?: string } | undefined;
  const message = satellite?.name && satellite.nodeId
    ? `Automatic agent work cannot start on this workstation. Choose satellite ${satellite.name.replace(/[\r\n\t]/g, " ")} (${satellite.nodeId.replace(/[\r\n\t]/g, " ")}).`
    : "Automatic agent work cannot start on this workstation. Choose a suitable satellite, or use forage --needs linux -- '<command>' for Linux-compatible work.";
  return new RpcError("workstation_heavy_work_denied", message, {
    policyVersion: 1, nodeKind, operation, reason, remedy: "satellite-or-forage", ...target,
  });
}

export function newAdmissionBasis(kind: string, operation: string, conn: RpcConn, policy: LandingFixerPolicy | null, now: number, decision?: SatelliteDecision): AdmissionBasis {
  if (kind !== "workstation") return "automatic_nonworkstation";
  if (humanAdmission(conn)) return "human";
  const marker = conn.workstationAdmission;
  if (operation === "spawn" && conn.registeredApiary === true && marker?.intent === "landing-fixer-local") {
    if (!policy || marker.policyId !== policy.policyId) throw admissionFailure(operation, "fixer_policy_missing");
    if (policy.expiresAt <= now) throw admissionFailure(operation, "fixer_policy_expired");
    return `fixer:${policy.policyId}`;
  }
  if (decision?.eligible) throw admissionFailure(operation, "eligible_satellite", kind, { satellite: decision.satellite, remedy: `Choose satellite ${decision.satellite.name} (${decision.satellite.nodeId})` });
  return "automatic_local_fallback";
}

export function startAdmissionAllowed(bee: BeeRow, hasStarted: boolean, policy: LandingFixerPolicy | null, now: number): boolean {
  const basis = bee.admissionBasis ?? "unadmitted";
  return !basis.startsWith("fixer:") || hasStarted || (basis === `fixer:${policy?.policyId}` && (policy?.expiresAt ?? 0) > now);
}

export function ownCellAdmission(bee: BeeRow, conn: RpcConn): boolean {
  if (humanAdmission(conn)) return true;
  const actor = conn.authenticatedBeeId ?? (conn.ingress === "local_unix" ? conn.caller?.runtimeBeeId : undefined);
  return actor === bee.id && (["continuation", "human", "automatic_local_fallback"].includes(bee.admissionBasis ?? "unadmitted") || bee.admissionBasis?.startsWith("fixer:") === true);
}
