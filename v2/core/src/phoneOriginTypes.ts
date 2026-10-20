export interface PhoneSource {
  ownerStoreId: string;
  admissionId: string;
  contentDigest: string;
  relation: "forward" | "summary" | "bio-briefing";
}
export interface PhoneOriginRequest {
  format: "honeybee.phone-origin/1";
  channel: "phone";
  issuerNodeId: string;
  assigner: string;
  credentialRef: string;
  target: { kind: "bee" | "crew"; id: string };
  contentKind: "message" | "initial-prompt" | "crew-bio";
  assurance: "credential-possession-only";
  humanApproval: "not-verified";
  lane: "envelope-v1";
  parentSources: PhoneSource[];
  rootSources: PhoneSource[];
  ancestry: "complete" | "unknown-overflow";
}
export interface PhoneInput {
  envelope: PhoneOriginRequest & {
    ancestryDepth: number;
    omittedSourcesDigest?: string;
    ownerStoreId: string;
    admissionId: string;
    targetBeeId: string;
    idempotencyKey: string;
    contentDigest: string;
  };
  originalContent: string;
}
export type PhoneOperationOrigin = Omit<PhoneInput["envelope"], "contentDigest"> & { contentDigest: null };
