import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { canonicalJson, type JsonValue } from "../canonical.ts";

export type ReleaseIdentity = { component: "honeybee"; version: string; sourceRevision: string; target: string; artifact: { url: string; sha256: string } };
export type ReleaseDescriptor = { schemaVersion: 1; identity: ReleaseIdentity; engines: { node: string }; runNumber?: number; publishedAt?: string };
export type ReleaseSignature = { schemaVersion: 1; algorithm: "ed25519"; keyId: string; signature: string };
export type ReleaseVerifyReason = "descriptor_invalid" | "signature_invalid" | "key_unknown";

export class ReleaseVerifyError extends Error {
  readonly reason: ReleaseVerifyReason;
  constructor(reason: ReleaseVerifyReason, message: string) { super(message); this.name = "ReleaseVerifyError"; this.reason = reason; }
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const KEY_PATTERN = /^[a-f0-9]{64}$/;

function invalid(message: string): never { throw new ReleaseVerifyError("descriptor_invalid", message); }
function record(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("expected an object");
  const r = value as Record<string, unknown>;
  for (const key of keys) if (!Object.hasOwn(r, key)) invalid(`missing ${key}`);
  for (const key of Object.keys(r)) if (!keys.includes(key) && !optional.includes(key)) invalid(`unknown field ${key}`);
  return r;
}
function text(value: unknown, name: string, max = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) invalid(`${name} must be a non-empty string`);
  return value;
}

export function parseReleaseDescriptor(value: unknown): ReleaseDescriptor {
  const r = record(value, ["schemaVersion", "identity", "engines"], ["runNumber", "publishedAt"]);
  if (r.schemaVersion !== 1) invalid("unsupported descriptor schemaVersion");
  const identity = record(r.identity, ["component", "version", "sourceRevision", "target", "artifact"]);
  if (identity.component !== "honeybee") invalid("identity.component must be honeybee");
  const sourceRevision = text(identity.sourceRevision, "identity.sourceRevision");
  if (!SHA_PATTERN.test(sourceRevision)) invalid("identity.sourceRevision must be a full 40-hex commit");
  const target = text(identity.target, "identity.target", 64);
  if (!/^[a-z0-9]+-[a-z0-9]+$/.test(target)) invalid("identity.target must look like linux-x64");
  const artifact = record(identity.artifact, ["url", "sha256"]);
  const url = text(artifact.url, "identity.artifact.url");
  if (!URL.canParse(url) || new URL(url).protocol !== "https:") invalid("identity.artifact.url must be https");
  const sha256 = text(artifact.sha256, "identity.artifact.sha256", 71);
  if (!DIGEST_PATTERN.test(sha256)) invalid("identity.artifact.sha256 must be sha256:<64 hex>");
  const engines = record(r.engines, ["node"]);
  const node = text(engines.node, "engines.node", 128);
  const descriptor: ReleaseDescriptor = { schemaVersion: 1, identity: { component: "honeybee", version: text(identity.version, "identity.version", 128), sourceRevision, target, artifact: { url, sha256 } }, engines: { node } };
  if (r.runNumber !== undefined) {
    if (typeof r.runNumber !== "number" || !Number.isSafeInteger(r.runNumber) || r.runNumber < 0) invalid("runNumber must be a non-negative integer");
    descriptor.runNumber = r.runNumber;
  }
  if (r.publishedAt !== undefined) {
    const publishedAt = text(r.publishedAt, "publishedAt", 64);
    if (!Number.isFinite(Date.parse(publishedAt))) invalid("publishedAt must be a date");
    descriptor.publishedAt = publishedAt;
  }
  return descriptor;
}

export function parseReleaseSignature(value: unknown): ReleaseSignature {
  const r = record(value, ["schemaVersion", "algorithm", "keyId", "signature"]);
  if (r.schemaVersion !== 1) invalid("unsupported signature schemaVersion");
  if (r.algorithm !== "ed25519") invalid("signature algorithm must be ed25519");
  const keyId = text(r.keyId, "keyId", 16);
  if (!/^[a-f0-9]{16}$/.test(keyId)) invalid("keyId must be 16 hex characters");
  const signature = text(r.signature, "signature", 128);
  const bytes = Buffer.from(signature, "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== signature) invalid("signature must be the base64 of 64 bytes");
  return { schemaVersion: 1, algorithm: "ed25519", keyId, signature };
}

export function releaseKeyId(publicKeyHex: string): string {
  if (!KEY_PATTERN.test(publicKeyHex)) throw new Error("release key must be 64 hex characters");
  return createHash("sha256").update(Buffer.from(publicKeyHex, "hex")).digest("hex").slice(0, 16);
}

export function releasePublicKey(publicKeyHex: string): KeyObject {
  if (!KEY_PATTERN.test(publicKeyHex)) throw new Error("release key must be 64 hex characters");
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]), format: "der", type: "spki" });
}

export function releasePublicKeyHex(key: KeyObject): string {
  const der = key.export({ format: "der", type: "spki" });
  if (der.length !== 44 || !der.subarray(0, 12).equals(ED25519_SPKI_PREFIX)) throw new Error("not an Ed25519 public key");
  return der.subarray(12).toString("hex");
}

export function releaseSigningBytes(descriptor: ReleaseDescriptor): Buffer {
  return Buffer.from(canonicalJson(descriptor as unknown as JsonValue), "utf8");
}

export function signReleaseDescriptor(descriptor: unknown, privateKeyPem: string): ReleaseSignature {
  const parsed = parseReleaseDescriptor(descriptor);
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("release signing requires an Ed25519 private key");
  const keyId = releaseKeyId(releasePublicKeyHex(createPublicKey(key)));
  return { schemaVersion: 1, algorithm: "ed25519", keyId, signature: sign(null, releaseSigningBytes(parsed), key).toString("base64") };
}

export function verifyReleaseDescriptor(descriptor: unknown, signature: unknown, trustedKeys: readonly string[]): { descriptor: ReleaseDescriptor; keyId: string } {
  const parsed = parseReleaseDescriptor(descriptor);
  const sig = parseReleaseSignature(signature);
  const candidates = trustedKeys.filter((key) => releaseKeyId(key) === sig.keyId);
  if (candidates.length === 0) throw new ReleaseVerifyError("key_unknown", `release signature key ${sig.keyId} is not a trusted release key`);
  const bytes = releaseSigningBytes(parsed);
  const sigBytes = Buffer.from(sig.signature, "base64");
  for (const key of candidates) if (verify(null, bytes, releasePublicKey(key), sigBytes)) return { descriptor: parsed, keyId: sig.keyId };
  throw new ReleaseVerifyError("signature_invalid", "release signature does not verify against the trusted key");
}
