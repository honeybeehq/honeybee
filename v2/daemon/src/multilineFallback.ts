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

  private receipt(beeId: string, fallback: DeliveryFallback, messageId: number): "accepted" | "unknown" | "not_attempted" {
    try {return fallback.generation !== null && fallback.pointer !== null ? this.driver.deliveryReceipt?.(beeId, fallback.generation, messageId, fallback.pointer) ?? "unknown" : "unknown";} catch {return "unknown";}
  }

  eligible(beeId: string, messageId: number, fallback: DeliveryFallback | undefined): boolean {
    if (!fallback) return true;
    if (fallback.state === "unknown") return this.receipt(beeId, fallback, messageId) !== "unknown";
    return ["preparing", "ready", "in_flight"].includes(fallback.state);
  }

  reconcile(message: MessageRow, source: TurnTriggerSource): boolean {
    if (this.store.inTransaction || message.deliveredAt !== null) return false;
    const fallback = this.store.multilineDelivery(message.id)?.fallback;
    if (!fallback || !["in_flight", "unknown"].includes(fallback.state)) return false;
    const runtime = this.store.currentRuntime(message.beeId);
    if (runtime && fallback.pointer && this.driver.planDeliveryConfirmation?.(message.beeId, runtime.generation, message.id, fallback.pointer) != null) {
      if (!this.store.getDeliveryConfirmationIntent(message.id)) {
        this.store.prepareUnknownDeliveryConfirmationIntent({ beeId: message.beeId, messageId: message.id, generation: runtime.generation });
        if (fallback.state === "in_flight") this.store.transitionMultilineFallback(message.id, "in_flight", "unknown", { detail: "delivery_pointer_outcome_unknown" });
      }
      return false;
    }
    const receipt = this.receipt(message.beeId, fallback, message.id);
    if (receipt === "accepted") return this.complete(message, fallback, source);
    if (receipt === "not_attempted") {
      this.store.transitionMultilineFallback(message.id, fallback.state, "ready", {detail: "delivery_not_attempted", attemptPhase: "before_enter_cleared"});
      return false;
    }
    if (fallback.state === "in_flight" && (!runtime || runtime.generation !== fallback.generation || !["booting", "running", "idle"].includes(runtime.state))) {
      this.store.transitionMultilineFallback(message.id, "in_flight", "unknown", { detail: "delivery_pointer_outcome_unknown" });
    }
    return false;
  }

  deliver(message: MessageRow, text: string, generation: number, peer: boolean, questionId: string | null, source: TurnTriggerSource, reorderMessageIds: number[] = []): { handled: boolean; accepted: boolean; generation?: number; confirmationBody?: string } {
    const hold = this.store.multilineDelivery(message.id);
    if (!hold || !hold.fallback && !["held", "expired"].includes(hold.stage)) return { handled: false, accepted: false };
    if (this.store.inTransaction) return { handled: true, accepted: false };
    if (hold.detail === "delivery_hold_state_unknown") {this.store.reconcileUnknownMultilineHold(message.id); return {handled: true, accepted: false};}
    const bee = this.store.getBee(message.beeId);
    if (!bee || message.deliveredAt !== null) return { handled: true, accepted: false };
    let fallback = hold.fallback;
    if (!fallback) {
      try {
        fallback = this.store.prepareMultilineFallback(message.id, this.options.rootForBee?.(bee) ?? this.options.root, this.options.worktrees(bee), reorderMessageIds);
      } catch (error) {
        fallback = this.store.prepareMultilineFallback(message.id, this.options.root, [], reorderMessageIds);
        const detail = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "delivery_file_location_invalid";
        if (fallback?.state === "preparing") this.store.transitionMultilineFallback(message.id, "preparing", "held", { detail });
        return { handled: true, accepted: false };
      }
    }
    if (!fallback) return { handled: true, accepted: false };
    if (fallback.state === "in_flight" || fallback.state === "unknown") {
      if (fallback.pointer && this.driver.planDeliveryConfirmation?.(message.beeId, generation, message.id, fallback.pointer) != null) {
        const intent = this.store.getDeliveryConfirmationIntent(message.id);
        if (!intent || fallback.generation !== generation || intent.generation !== generation) {
          if (!intent) this.store.prepareUnknownDeliveryConfirmationIntent({ beeId: message.beeId, messageId: message.id, generation });
          if (fallback.state === "in_flight") this.store.transitionMultilineFallback(message.id, "in_flight", "unknown", { detail: "delivery_pointer_outcome_unknown" });
          return { handled: true, accepted: false };
        }
        return { handled: false, accepted: false, confirmationBody: fallback.pointer };
      }
      return { handled: true, accepted: this.reconcile(message, source), ...(fallback.generation === null ? {} : { generation: fallback.generation }) };
    }
    if (fallback.state !== "preparing" && fallback.state !== "ready") return { handled: true, accepted: false };
    try {
      if (fallback.ownerStoreId !== this.store.effectCoverage().ownerStoreId) throw Object.assign(new Error("owner differs"), { code: "delivery_file_owner_mismatch" });
      if (fallback.state === "preparing") {
        this.store.fenceMultilineFallbackPublication(message.id, fallback.id);
        const content = `Honeybee delivery content: message=${message.id} publication=${fallback.id}\n\n${text}`;
        const published = this.files.publish(fallback.root, fallback.ownerStoreId, message.beeId, fallback.id, content, fallback.worktrees);
        const pointer = deliveryPointer(message, published.path, peer, questionId, this.store.dismissedQuestionId(message.id));
        fallback = this.store.transitionMultilineFallback(message.id, "preparing", "ready", { ...published, pointer })!;
      }
    } catch (error) {
      const detail = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "delivery_file_error";
      this.store.transitionMultilineFallback(message.id, fallback.state, "held", { detail });
      return { handled: true, accepted: false };
    }
    if (!fallback.path) return { handled: true, accepted: false };
    if (fallback.pointer && this.driver.planDeliveryConfirmation?.(message.beeId, generation, message.id, fallback.pointer) != null) {
      this.store.transitionMultilineFallback(message.id, "ready", "in_flight", { generation, attempts: (fallback.attempts ?? 0) + 1, attemptPhase: "injecting" });
      return { handled: false, accepted: false, confirmationBody: fallback.pointer };
    }
    const pane = this.driver.deliveryPane?.(message.beeId, generation);
    if (bee.substrate === "tmux" && !pane) {
      this.store.transitionMultilineFallback(message.id, "ready", "held", {detail: "delivery_pane_identity_unavailable"});
      return {handled: true, accepted: false};
    }
    const paneInput = pane ? {code: "pane_input_unknown" as const, ...pane, generation, since: Date.now(), reason: "single_attempt_injection_in_progress"} : undefined;
    fallback = this.store.transitionMultilineFallback(message.id, "ready", "in_flight", { generation, attempts: (fallback.attempts ?? 0) + 1, attemptPhase: "injecting", ...(paneInput ? {paneInput} : {}) })!;
    try {
      const outcome = this.driver.deliver(message.beeId, generation, message.id, fallback.pointer!, { singleAttempt: true, ...(pane ? {expectedPane: pane} : {}) });
      if (outcome.accepted) {
        return { handled: true, accepted: this.complete(message, fallback, source), generation: fallback.generation! };
      }
      if (outcome.pendingConfirmation) return {handled: true, accepted: false};
      const cleared = outcome.attemptPhase === "before_enter_cleared" || outcome.detail === "delivery_not_attempted";
      this.store.transitionMultilineFallback(message.id, "in_flight", cleared ? "ready" : "unknown", {
        detail: outcome.detail ?? "delivery_pointer_outcome_unknown", ...(outcome.attemptPhase ? {attemptPhase: outcome.attemptPhase} : cleared ? {attemptPhase: "before_enter_cleared" as const} : {}),
        ...(paneInput ? {paneInput: {...paneInput, reason: outcome.detail ?? "delivery_pointer_outcome_unknown", ...(cleared || outcome.attemptPhase === "enter_attempted" && outcome.accepted ? {clearedAt: Date.now()} : {})}} : {}),
      });
    } catch {
      this.store.transitionMultilineFallback(message.id, "in_flight", "unknown", { detail: "delivery_pointer_outcome_unknown" });
    }
    return { handled: true, accepted: false };
  }

  private complete(message: MessageRow, fallback: DeliveryFallback, source: TurnTriggerSource): boolean {
    if (fallback.generation === null) return false;
    return this.store.completeMultilineFallback(message.id, fallback.generation, source, !fallback.paneInput || this.driver.deliveryPaneClear?.(message.beeId, fallback.generation) === true).applied;
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
