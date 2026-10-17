import type { BeeRow, CoreStore, DeliveryFallback, MessageRow, TurnTriggerSource } from "../../core/src/index.ts";
import type { RuntimeDriver } from "../../harness/src/driver.ts";
import { DeliveryFileError, DeliveryFiles } from "./deliveryFile.ts";
import { deliveryPointer } from "./envelope.ts";

export interface MultilineFallbackOptions {
  root: string;
  rootForBee?(bee: BeeRow): string;
  files?: DeliveryFiles;
  worktrees(bee: BeeRow): string[];
}

export function deliveryContentRoot(dataDir: string, substrate: BeeRow["substrate"], sandboxed: boolean, runtimeRoot: string | null, platform = process.platform): string {
  if (platform !== "linux" || substrate !== "cell" || !sandboxed || !["/tmp", "/var/tmp", "/dev"].some(path => dataDir === path || dataDir.startsWith(path + "/"))) return dataDir;
  if (!runtimeRoot) throw new DeliveryFileError("delivery_file_sandbox_unreadable");
  return runtimeRoot;
}

export class MultilineFallback {
  private readonly files: DeliveryFiles;
  private readonly store: CoreStore;
  private readonly driver: RuntimeDriver;
  private readonly options: MultilineFallbackOptions;
  constructor(store: CoreStore, driver: RuntimeDriver, options: MultilineFallbackOptions) {
    this.store = store;
    this.driver = driver;
    this.options = options;
    this.files = options.files ?? new DeliveryFiles();
  }

  private receipt(beeId: string, fallback: DeliveryFallback, messageId: number): "accepted" | "unknown" {
    try {return fallback.generation !== null && fallback.pointer !== null ? this.driver.deliveryReceipt?.(beeId, fallback.generation, messageId, fallback.pointer) ?? "unknown" : "unknown";} catch {return "unknown";}
  }

  eligible(beeId: string, messageId: number, fallback: DeliveryFallback | undefined): boolean {
    if (!fallback) return true;
    if (fallback.state === "unknown") return this.receipt(beeId, fallback, messageId) === "accepted";
    return ["preparing", "ready", "in_flight"].includes(fallback.state);
  }

  deliver(message: MessageRow, text: string, generation: number, peer: boolean, questionId: string | null, source: TurnTriggerSource): { handled: boolean; accepted: boolean; generation?: number } {
    const hold = this.store.multilineDelivery(message.id);
    if (!hold || !hold.fallback && !["held", "expired"].includes(hold.stage)) return { handled: false, accepted: false };
    if (this.store.inTransaction) return { handled: true, accepted: false };
    const bee = this.store.getBee(message.beeId);
    if (!bee || message.deliveredAt !== null) return { handled: true, accepted: false };
    let fallback = hold.fallback;
    if (!fallback) {
      try {
        fallback = this.store.prepareMultilineFallback(message.id, this.options.rootForBee?.(bee) ?? this.options.root, this.options.worktrees(bee));
      } catch (error) {
        fallback = this.store.prepareMultilineFallback(message.id, this.options.root, []);
        const detail = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "delivery_file_location_invalid";
        if (fallback?.state === "preparing") this.store.transitionMultilineFallback(message.id, "preparing", "held", { detail });
        return { handled: true, accepted: false };
      }
    }
    if (!fallback) return { handled: true, accepted: false };
    if (fallback.state === "in_flight" || fallback.state === "unknown") {
      if (this.receipt(message.beeId, fallback, message.id) === "accepted") {
        return { handled: true, accepted: this.complete(message, fallback, source), generation: fallback.generation! };
      }
      if (fallback.state === "in_flight") this.store.transitionMultilineFallback(message.id, "in_flight", "unknown", { detail: "delivery_pointer_outcome_unknown" });
      return { handled: true, accepted: false };
    }
    if (fallback.state !== "preparing" && fallback.state !== "ready") return { handled: true, accepted: false };
    try {
      if (fallback.ownerStoreId !== this.store.effectCoverage().ownerStoreId) throw Object.assign(new Error("owner differs"), { code: "delivery_file_owner_mismatch" });
      const content = `Honeybee delivery content: message=${message.id} publication=${fallback.id}\n\n${text}`;
      const published = this.files.publish(fallback.root, fallback.ownerStoreId, message.beeId, fallback.id, content, fallback.worktrees);
      const pointer = deliveryPointer(message, published.path, peer, questionId);
      if (fallback.state === "preparing") fallback = this.store.transitionMultilineFallback(message.id, "preparing", "ready", { ...published, pointer })!;
      else if (published.path !== fallback.path || published.digest !== fallback.digest || published.bytes !== fallback.bytes) throw Object.assign(new Error("content differs"), { code: "delivery_file_content_mismatch" });
      else if (pointer !== fallback.pointer) throw Object.assign(new Error("pointer differs"), { code: "delivery_file_pointer_mismatch" });
    } catch (error) {
      const detail = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "delivery_file_error";
      this.store.transitionMultilineFallback(message.id, fallback.state, "held", { detail });
      return { handled: true, accepted: false };
    }
    if (!fallback.path) return { handled: true, accepted: false };
    fallback = this.store.transitionMultilineFallback(message.id, "ready", "in_flight", { generation })!;
    try {
      const outcome = this.driver.deliver(message.beeId, generation, message.id, fallback.pointer!, { singleAttempt: true });
      if (outcome.accepted) {
        return { handled: true, accepted: this.complete(message, fallback, source), generation: fallback.generation! };
      }
      this.store.transitionMultilineFallback(message.id, "in_flight", outcome.detail === "delivery_not_attempted" ? "ready" : "unknown", { detail: outcome.detail ?? "delivery_pointer_outcome_unknown" });
    } catch {
      this.store.transitionMultilineFallback(message.id, "in_flight", "unknown", { detail: "delivery_pointer_outcome_unknown" });
    }
    return { handled: true, accepted: false };
  }

  private complete(message: MessageRow, fallback: DeliveryFallback, source: TurnTriggerSource): boolean {
    if (fallback.generation === null) return false;
    return this.store.completeMultilineFallback(message.id, fallback.generation, source).applied;
  }

  cleanupDeleted(): void {
    if (this.store.inTransaction) return;
    for (const row of this.store.deletedMultilineFiles()) {
      const fallback = row.fallback;
      if (!fallback || fallback.state === "removed" || !fallback.id) continue;
      try {
        if (fallback.ownerStoreId !== this.store.effectCoverage().ownerStoreId) continue;
        this.files.remove(fallback.root, fallback.ownerStoreId, row.beeId, fallback.id, fallback.worktrees);
        this.store.transitionMultilineFallback(row.messageId, fallback.state, "removed");
      } catch (error) {
        const detail = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "delivery_file_cleanup_error";
        this.store.recordMultilineCleanupFailure(row.messageId, detail);
      }
    }
  }
}
