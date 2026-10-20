import { createHash } from "node:crypto";

export const DELIVERY_STATUS_CAPABILITY = "delivery_status.v1";
export type DeliveryReceiptState = "not_written" | "written" | "accepted" | "refused" | "unknown";
export interface DeliveryStatus {
  id: number;
  digest: string;
  state: DeliveryReceiptState;
}
export interface TaggedDelivery {
  id: number;
  digest: string;
  beeId: string;
  generation: number;
}
interface Receipt {
  digest: string;
  requestId: string | number;
  at: number;
  state: "written" | "accepted" | "refused";
}

export class DeliveryReceipts {
  private readonly receipts = new Map<number, Receipt>();
  private retiredThrough = 0;
  private readonly beeId: string;
  private readonly generation: number;
  private readonly now: () => number;
  private readonly limit: number;
  private readonly maxAgeMs: number;

  constructor(
    beeId: string,
    generation: number,
    now: () => number = () => performance.now(),
    limit = 4096,
    maxAgeMs = 86_400_000,
  ) {
    this.beeId = beeId;
    this.generation = generation;
    this.now = now;
    this.limit = limit;
    this.maxAgeMs = maxAgeMs;
  }

  private prune(): void {
    const cutoff = this.now() - this.maxAgeMs;
    for (const [id, receipt] of this.receipts) {
      if (receipt.at > cutoff && this.receipts.size <= this.limit) break;
      this.receipts.delete(id);
      this.retiredThrough = Math.max(this.retiredThrough, id);
    }
  }

  private matches(value: TaggedDelivery): boolean {
    return value.beeId === this.beeId && value.generation === this.generation
      && Number.isSafeInteger(value.id) && value.id > 0
      && typeof value.digest === "string" && /^[a-f0-9]{64}$/.test(value.digest);
  }

  status(value: TaggedDelivery): DeliveryStatus {
    this.prune();
    const receipt = this.receipts.get(value.id);
    const state = !this.matches(value) ? "unknown"
      : receipt ? receipt.digest === value.digest ? receipt.state : "unknown"
      : value.id <= this.retiredThrough ? "unknown" : "not_written";
    return { id: value.id, digest: value.digest, state };
  }

  begin(value: TaggedDelivery, line: string): boolean {
    if (this.status(value).state !== "not_written") return false;
    if (createHash("sha256").update(line).digest("hex") !== value.digest) return false;
    let request: unknown;
    try { request = JSON.parse(line); } catch { return false; }
    if (!request || typeof request !== "object" || !("id" in request)
      || (typeof request.id !== "number" && typeof request.id !== "string")) return false;
    this.receipts.set(value.id, { digest: value.digest, requestId: request.id, at: this.now(), state: "written" });
    this.prune();
    return true;
  }

  observe(line: string): void {
    let value: unknown;
    try { value = JSON.parse(line); } catch { return; }
    if (!value || typeof value !== "object" || !("id" in value) || "method" in value) return;
    if (!("result" in value) && !("error" in value)) return;
    this.prune();
    for (const receipt of this.receipts.values()) {
      if (receipt.requestId === value.id && receipt.state === "written") {
        receipt.state = "error" in value ? "refused" : "accepted";
      }
    }
  }
}
