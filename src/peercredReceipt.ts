/** Offline consistency check. Only the repack writer performs authenticated CI reads. */
export function assertPeercredReceipt(value: unknown, sourceHead: string, target: string, binarySha256: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("peercred repack receipt missing");
  const peer = value as Record<string, unknown>;
  const receipt = peer.provenance as Record<string, unknown> | undefined;
  if (!receipt || receipt.repository !== "honeybeehq/honeybee" || receipt.workflow !== ".github/workflows/ci.yml"
    || receipt.event !== "push" || receipt.branch !== "main" || receipt.sourceHead !== sourceHead
    || !/^[a-f0-9]{40}$/.test(sourceHead) || receipt.target !== target || receipt.binarySha256 !== binarySha256
    || peer.target !== target || peer.sha256 !== binarySha256
    || ![peer.ciRun, peer.ciJob, receipt.artifactId].every(n => typeof n === "number" && Number.isSafeInteger(n) && n > 0)
    || receipt.runId !== peer.ciRun || receipt.jobId !== peer.ciJob
    || typeof receipt.artifactSha256 !== "string" || !/^[a-f0-9]{64}$/.test(receipt.artifactSha256)) throw new Error("peercred repack CI receipt is inconsistent");
}
