/** Public verification contract. This module never resolves or holds signing authority. */
import { createHash, createPublicKey, verify } from "node:crypto";

export interface TranscriptArchiveIdentity { nodeId: string; beeId: string; epoch: string; compat: number }
export interface TranscriptArchiveSummary { feedRows: number; segmentRows: number; expandedBytes: number; digest: string; lastLine: number; segmentSeq: number; segmentDigest: string }
export interface VerifiedTranscriptObject {
  sourcePath: string; ref: string; bytes: number; identity: TranscriptArchiveIdentity; summary: TranscriptArchiveSummary;
}
export interface BackupVerificationPayload {
  format: "honeybee.verified-backup.v1";
  verification: "verified";
  machine: string; cellId: string; generation: string;
  repository: string; repositoryId: string; snapshotId: string;
  manifestPath: string; manifestHash: string;
  files: number; bytes: number;
  git: { head: string; base: string };
  databases: { sha256: string; schemaVersion: number; ddlDigest: string; integrityCheck: "ok" }[];
  transcripts: VerifiedTranscriptObject[];
  verifier: { id: string; keyId: string };
  verifiedAt: string;
}
export interface VerifiedBackupReceipt { payload: BackupVerificationPayload; signature: string }
export class BackupReceiptError extends Error { constructor() { super("invalid_backup_receipt"); } }
export const backupDigest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
/** Sorted keys remove representation ambiguity; arrays retain their declared order. */
export function canonicalBackupJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalBackupJson).join(",") + "]";
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const row = value as Record<string, unknown>;
    return "{" + Object.keys(row).sort().map(key => JSON.stringify(key) + ":" + canonicalBackupJson(row[key])).join(",") + "}";
  }
  throw new BackupReceiptError();
}
export function backupVerifierKeyId(publicKeyBase64: string): string {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyBase64, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") throw 0;
    return backupDigest(key.export({ format: "der", type: "spki" }));
  } catch { throw new BackupReceiptError(); }
}
export function verifyBackupReceipt(value: unknown, publicKeyBase64: string): VerifiedBackupReceipt {
  try {
    if (!value || typeof value !== "object") throw 0;
    const row = value as Record<string, unknown>;
    if (!row.payload || typeof row.payload !== "object" || typeof row.signature !== "string") throw 0;
    const p = row.payload as Record<string, unknown>;
    if (p.format !== "honeybee.verified-backup.v1" || p.verification !== "verified") throw 0;
    for (const field of ["machine", "cellId", "generation", "repository", "manifestPath", "verifiedAt"]) if (typeof p[field] !== "string" || !(p[field] as string).length || (p[field] as string).length > 4096) throw 0;
    for (const field of ["repositoryId", "snapshotId", "manifestHash"]) if (typeof p[field] !== "string" || !/^[a-f0-9]{64}$/.test(p[field] as string)) throw 0;
    for (const field of ["files", "bytes"]) if (typeof p[field] !== "number" || !Number.isSafeInteger(p[field]) || (p[field] as number) < 0) throw 0;
    if (!Number.isFinite(Date.parse(String(p.verifiedAt))) || !p.git || typeof p.git !== "object" || !p.verifier || typeof p.verifier !== "object" || !Array.isArray(p.databases) || !Array.isArray(p.transcripts)) throw 0;
    const git = p.git as Record<string, unknown>, authority = p.verifier as Record<string, unknown>;
    if (![git.head, git.base].every(item => typeof item === "string" && /^[a-f0-9]{40,64}$/.test(item))) throw 0;
    if (typeof authority.id !== "string" || !authority.id || authority.keyId !== backupVerifierKeyId(publicKeyBase64)) throw 0;
    const canonical = canonicalBackupJson(p);
    if (Buffer.byteLength(canonical) > 1024 * 1024 || Buffer.from(row.signature, "base64").length !== 64) throw 0;
    const key = createPublicKey({ key: Buffer.from(publicKeyBase64, "base64"), format: "der", type: "spki" });
    if (!verify(null, Buffer.from(canonical), key, Buffer.from(row.signature, "base64"))) throw 0;
    if (Buffer.from(row.signature, "base64").toString("base64") !== row.signature) throw 0;
    return { payload: JSON.parse(canonical) as BackupVerificationPayload, signature: row.signature };
  } catch { throw new BackupReceiptError(); }
}
