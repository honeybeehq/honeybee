import { provisionCell, type ProvisionRequest } from "./provision.ts";
import { claimFromPool } from "./warmPool.ts";
import type { ExecutionStart } from "../../core/src/executionStart.ts";
import { canonicalDigest, type JsonValue } from "../../../src/comb/canonical.ts";

interface Work {
  start: ExecutionStart;
  cellsRoot: string;
  request: ProvisionRequest;
  opId: string;
  disableCow: boolean;
  useGitImages: boolean;
  gitImagesRoot?: string;
  claimFromPool: boolean;
}
let started = false, sequence = 0;
const gates = new Map<number, () => void>();
process.on("message", (message: unknown) => {
  if (!message || typeof message !== "object") return;
  const frame = message as Record<string, unknown>;
  if (frame.op === "execution_permit" && typeof frame.sequence === "number") { const done = gates.get(frame.sequence); gates.delete(frame.sequence); done?.(); return; }
  if (frame.op !== "execution_work" || started) return;
  started = true;
  void run(frame.work as Work).catch(() => { process.send?.({ op: "execution_failed" }); process.exitCode = 1; process.disconnect?.(); });
});
process.on("disconnect", () => { if (!started || gates.size) process.exit(1); });
async function run(work: Work): Promise<void> {
  if (!process.send || work.start.beeId !== work.request.beeId) throw new Error("Invalid fenced Cell work");
  const bindingDigest = canonicalDigest(work.start as unknown as JsonValue);
  const gate = (operation: string) => new Promise<void>(resolve => {
    const id = ++sequence; gates.set(id,resolve);
    process.send!({ op: "execution_checkpoint", intentId: work.start.intentId, bindingDigest, sequence: id, operation });
  });
  let cell = null;
  if (work.claimFromPool) { await gate("pool_claim"); try { cell = claimFromPool(work.cellsRoot, work.request); } catch {} }
  if (!cell) {
    await gate("cell_provision");
    cell = provisionCell(work.cellsRoot, work.request, work.opId, { disableCow: work.disableCow, useGitImages: work.useGitImages, gitImagesRoot: work.gitImagesRoot });
  }
  process.send!({ op: "execution_ready", intentId: work.start.intentId, bindingDigest });
  process.disconnect?.();
}
