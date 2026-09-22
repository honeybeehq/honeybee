import { generateKeyPairSync } from "node:crypto";
import { humanRefAuthorityId, signHumanRefReceipt } from "../src/humanRefs.ts";
import type { CoreStore } from "../src/store.ts";

const pair = generateKeyPairSync("ed25519");
const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const privateKey = pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
/** Fixture authority can choose a known code; production tests exercise the allocator itself. */
export const referenceReceipt = (installationId: string, namespace = "k7") => signHumanRefReceipt({ namespace, installationId, authorityId: humanRefAuthorityId(publicKey) }, publicKey, privateKey);
export const enrollReferences = (store: CoreStore, namespace = "k7") => store.enrollHumanRefs(referenceReceipt(store.humanRefInstallationId(), namespace));
