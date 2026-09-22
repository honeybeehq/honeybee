import { createHash, createPublicKey, sign, verify } from "node:crypto";
import { CoreError } from "./types.ts";

export interface HumanRefIssuer {
  namespace: string;
  installationId: string;
  authorityId: string;
}

/** Durable allocation receipt. First enrollment explicitly trusts this registry;
 * its identity is then immutable. This is not federation between registries. */
export interface HumanRefReceipt extends HumanRefIssuer {
  version: 1;
  publicKey: string;
  signature: string;
}
export interface HumanRefRegistry {
  authorityId: string;
  publicKey: string;
  allocations: number;
}

export function humanRefAuthorityId(publicKey: string): string {
  return `hr-${createHash("sha256").update(publicKey).digest("hex")}`;
}
const signedBytes = (issuer: HumanRefIssuer): Buffer => Buffer.from(JSON.stringify([
  1, issuer.authorityId, issuer.installationId, issuer.namespace,
]));

export function signHumanRefReceipt(issuer: HumanRefIssuer, publicKey: string, privateKey: string): HumanRefReceipt {
  return { version: 1, ...issuer, publicKey, signature: sign(null, signedBytes(issuer), {
    key: Buffer.from(privateKey, "base64"), type: "pkcs8", format: "der",
  }).toString("base64") };
}

export function verifyHumanRefReceipt(value: unknown): HumanRefReceipt {
  const r = value as Partial<HumanRefReceipt> | null;
  if (!r || r.version !== 1 || typeof r.namespace !== "string" || !/^[a-z0-9]+$/.test(r.namespace)
    || typeof r.installationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.installationId)
    || typeof r.authorityId !== "string" || typeof r.publicKey !== "string" || typeof r.signature !== "string") {
    throw new CoreError("humanRef.enroll: malformed allocation receipt");
  }
  const receipt = r as HumanRefReceipt;
  try {
    const publicKey = createPublicKey({ key: Buffer.from(receipt.publicKey, "base64"), type: "spki", format: "der" });
    if (publicKey.asymmetricKeyType !== "ed25519" || humanRefAuthorityId(receipt.publicKey) !== receipt.authorityId
      || !verify(null, signedBytes(receipt), publicKey, Buffer.from(receipt.signature, "base64"))) throw new Error("signature mismatch");
  } catch { throw new CoreError("humanRef.enroll: invalid allocation receipt signature/authority"); }
  return receipt;
}
