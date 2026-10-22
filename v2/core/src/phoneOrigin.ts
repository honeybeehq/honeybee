import type { PhoneSource, PhoneOriginRequest, PhoneInput, PhoneOperationOrigin } from "./phoneOriginTypes.ts";
export type { PhoneSource, PhoneOriginRequest, PhoneInput, PhoneOperationOrigin } from "./phoneOriginTypes.ts";
import { createHash } from "node:crypto";
import { EffectKeyError } from "./effectResolve.ts";

export const PHONE_PROVENANCE_CAPABILITY = "mail.phone_provenance.v1";
export const PHONE_ENVELOPE_CAPABILITY = "phone.envelope.v1";
export const PHONE_LABEL = "Paired-phone message — human approval not verified";
export const PHONE_FORMAT = "honeybee.phone-origin/1";
type PhoneFormatEquality<Runtime extends PhoneOriginRequest["format"] = typeof PHONE_FORMAT, Contract extends typeof PHONE_FORMAT = PhoneOriginRequest["format"]> = [Runtime, Contract];
export const PHONE_MAX_CONTENT_BYTES = 1024 * 1024;
function invalid(message: string): never { throw new EffectKeyError("invalid_request", message); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Phone origin requires an object");
  return value as Record<string, unknown>;
}
function closed(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) invalid("Unknown phone origin field");
}
function reference(value: unknown): string {
  if (typeof value !== "string" || !value.length || Buffer.byteLength(value) > 256 || /[\u0000-\u001f]/u.test(value) || /[\ud800-\udfff]/u.test(value)) invalid("Invalid phone origin reference");
  return value;
}
export function phoneContent(value: string): string {
  if (/[\ud800-\udfff]/u.test(value) || Buffer.byteLength(value) > PHONE_MAX_CONTENT_BYTES) invalid("Invalid or oversized phone content");
  return value;
}
export function phoneDigest(value: string): string { return `sha256:${createHash("sha256").update(phoneContent(value), "utf8").digest("hex")}`; }
export function phoneSource(value: unknown): PhoneSource {
  const row = object(value);
  closed(row, ["ownerStoreId", "admissionId", "contentDigest", "relation"]);
  if (!["forward", "summary", "bio-briefing"].includes(String(row.relation)) || typeof row.contentDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(row.contentDigest)) invalid("Invalid phone parent source");
  return { ownerStoreId: reference(row.ownerStoreId), admissionId: reference(row.admissionId), contentDigest: row.contentDigest, relation: row.relation as PhoneSource["relation"] };
}
export function parsePhoneOrigin(value: unknown): PhoneOriginRequest {
  const row = object(value);
  if (Buffer.byteLength(JSON.stringify(value)) > 16 * 1024) invalid("Phone envelope exceeds 16 KiB");
  closed(row, ["format", "channel", "issuerNodeId", "assigner", "credentialRef", "target", "contentKind", "assurance", "humanApproval", "lane", "parentSources", "rootSources", "ancestry"]);
  if (row.format !== PHONE_FORMAT || row.channel !== "phone" || row.assurance !== "credential-possession-only" || row.humanApproval !== "not-verified" || row.lane !== "envelope-v1") invalid("Phone origin must only restrict assurance");
  if (!["message", "initial-prompt", "crew-bio"].includes(String(row.contentKind)) || !["complete", "unknown-overflow"].includes(String(row.ancestry))) invalid("Invalid phone origin kind or ancestry");
  const target = object(row.target); closed(target, ["kind", "id"]);
  if (target.kind !== "bee" && target.kind !== "crew") invalid("Invalid phone target");
  if (!Array.isArray(row.parentSources) || !Array.isArray(row.rootSources)) invalid("Phone ancestry requires arrays");
  const parents = row.parentSources.map(phoneSource), roots = row.rootSources.map(phoneSource);
  return {
    format: PHONE_FORMAT, channel: "phone", issuerNodeId: reference(row.issuerNodeId), assigner: reference(row.assigner), credentialRef: reference(row.credentialRef),
    target: { kind: target.kind, id: reference(target.id) }, contentKind: row.contentKind as PhoneOriginRequest["contentKind"],
    assurance: "credential-possession-only", humanApproval: "not-verified", lane: "envelope-v1",
    parentSources: parents, rootSources: roots, ancestry: parents.length > 8 || roots.length > 8 ? "unknown-overflow" : row.ancestry as PhoneOriginRequest["ancestry"],
  };
}
export function escapePhoneText(value: string): string {
  return phoneContent(value).replace(/[&<>\u0000-\u0008\u000b-\u001f]/gu, char => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    return `&#x${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")};`;
  });
}
export function renderPhoneInput(originalContent: string): string {
  return `${PHONE_LABEL}\n<apiary-phone-unverified encoding=escaped-text-v1>\n${escapePhoneText(originalContent)}\n</apiary-phone-unverified>\n${PHONE_LABEL}`;
}

export interface PhoneRequestBinding {
  version: 1;
  verb: "send" | "spawn";
  lane: "envelope-v1" | "interim-v1" | "legacy";
  requestDigest: string;
}
export interface PhoneAdmissionReceipt {
  ownerStoreId: string;
  admissionId: string;
  contentDigest: string | null;
  lane: "envelope-v1";
}

export function forwardPhoneOrigin(input: PhoneInput, relation: PhoneSource["relation"]): PhoneOriginRequest {
  const source = input.envelope;
  return {
    format: PHONE_FORMAT, channel: "phone", issuerNodeId: source.issuerNodeId,
    assigner: source.assigner, credentialRef: source.credentialRef,
    target: source.target, contentKind: "message", assurance: "credential-possession-only",
    humanApproval: "not-verified", lane: "envelope-v1", ancestry: source.ancestry,
    parentSources: [{ ownerStoreId: source.ownerStoreId, admissionId: source.admissionId, contentDigest: source.contentDigest, relation }],
    rootSources: source.rootSources,
  };
}

export function derivePhoneOrigin(source: PhoneOperationOrigin, target: PhoneOriginRequest["target"], contentKind: PhoneOriginRequest["contentKind"], snapshot?: PhoneOriginRequest): PhoneOriginRequest {
  return parsePhoneOrigin({
    format: PHONE_FORMAT, channel: "phone", issuerNodeId: source.issuerNodeId,
    assigner: source.assigner, credentialRef: source.credentialRef, target, contentKind,
    assurance: "credential-possession-only", humanApproval: "not-verified", lane: "envelope-v1",
    parentSources: [...source.parentSources, ...(snapshot?.parentSources ?? [])],
    rootSources: [...source.rootSources, ...(snapshot?.rootSources ?? [])],
    ancestry: source.ancestry === "unknown-overflow" || snapshot?.ancestry === "unknown-overflow" ? "unknown-overflow" : "complete",
  });
}
