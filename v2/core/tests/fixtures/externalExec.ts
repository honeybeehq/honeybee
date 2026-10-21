import { dispatchValue, dispatchBytes, sha256, type ExternalBinding } from "../../src/externalExec.ts";

export function externalFixture(): ExternalBinding {
  const h = "a".repeat(64);
  return {
    beeId: "external-test", bridgeId: "urbench-v2", workspace: "ur", admissionDigest: `sha256:${"a".repeat(64)}`,
    registration: { executable: "/missing/bridge", executableSha256: h, filesManifest: "/missing/files.json", filesManifestSha256: h, payloadManifest: "/missing/payload.sha256", payloadManifestSha256: h },
    dispatch: dispatchValue({ schema: "urbench.dispatch.v1", attemptId: "test-attempt", fencingToken: "synthetic-attempt-fence", mode: "no-inference", stateDir: "/synthetic/state", prompt: { path: "/synthetic/prompt", sha256: h, bytes: 10 }, inputSnapshot: { path: "/synthetic/input", sha256: h }, guest: { baseIdentity: h, profileFingerprint: h, policySha256: h }, requested: { model: "test", effort: "low" }, limits: { cpus: 2, memoryMiB: 2048, wallSeconds: 180 }, auth: { handle: "", claim: null, accountId: null } }),
  };
}
export function externalReceipt(binding: ExternalBinding) {
  return { schema: "urbench.receipt.v1", attemptId: binding.dispatch.attemptId, fencingTokenSha256: sha256(binding.dispatch.fencingToken), dispatchManifestSha256: sha256(dispatchBytes(binding.dispatch)), installManifestSha256: binding.registration.payloadManifestSha256, status: "failed", mode: "no-inference", qualified: false, nativeReceipt: { path: `${binding.dispatch.stateDir}/attempts/${binding.dispatch.attemptId}/terminal.json`, sha256: "b".repeat(64) }, captureErrors: [], evidence: { "run-output.log": "c".repeat(64) }, auth: { handle: "", accountId: null, release: "not-applicable-no-inference" } };
}
