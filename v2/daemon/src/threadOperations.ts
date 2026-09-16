import type { CoreStore, ThreadOperationRow, ThreadOperationView } from "../../core/src/index.ts";
import type { SpawnSpec } from "../../driver-hsr/src/driver.ts";
import { pidAlive, verifyProcessIdentity } from "../../driver-hsr/src/psutil.ts";
import { compactThread, type ThreadCompactorInput } from "./threadCompactor.ts";
import { copyPinnedHistory, seedSuccessorHistory, ThreadExecutionError } from "./threadHistory.ts";

/** One serialized execution per successor, at most two slow owners per daemon. */
export class ThreadOperations {
  private running = new Map<string, Promise<void>>();
  private abort = new AbortController();
  private readonly store: CoreStore;
  private readonly resolve: (beeId: string) => SpawnSpec;
  private readonly compact: (input: ThreadCompactorInput) => Promise<void>;
  constructor(store: CoreStore, resolve: (beeId: string) => SpawnSpec,
    compact: (input: ThreadCompactorInput) => Promise<void> = compactThread) {
    this.store = store; this.resolve = resolve; this.compact = compact;
  }

  tick(): void {
    if (this.abort.signal.aborted) return;
    for (const row of this.store.listThreadOperations(true)) {
      if (!this.store.getBee(row.successorBeeId)) {
        this.fail(row, "successor_deleted", "Successor was deleted", false);
        continue;
      }
      if (row.phase === "starting") {
        const runtime = this.store.currentRuntime(row.successorBeeId);
        if (runtime?.state === "idle" && runtime.bootEvidence === "real") {
          if (this.store.getBee(row.successorBeeId)?.providerSessionId !== row.successorProviderSessionId) {
            this.fail(row, "startup_failed", "Provider resumed a different conversation identity", false);
          } else this.store.updateThreadOperation(row.id, { phase: "ready" });
        } else if (this.store.activeFlags(row.successorBeeId).some(f => f.flag === "spawn_failed")) {
          this.fail(row, "startup_failed", "Successor startup exhausted its retry budget");
        } else if (runtime?.state === "stopped" && this.store.getCommand(row.commandId)?.status === "done"
          && !this.store.hasPendingReviveOrWakeCommand(row.successorBeeId, runtime.generation)) {
          // Even a plain fork has start intent when its mailbox is empty.
          // send_wake uses the normal spawn budget; revive would reset it.
          this.store.enqueueCommand("send_wake", row.successorBeeId, { threadOperationId: row.id });
        }
        continue;
      }
      if (this.running.has(row.id) || this.running.size >= 2) continue;
      const work = this.run(row).catch(error => {
        if (this.abort.signal.aborted) return;
        const current = this.store.getThreadOperation(row.id);
        if (current && current.phase !== "failed" && current.phase !== "ready") {
          this.fail(current, error instanceof ThreadExecutionError ? error.code : current.phase === "copying" ? "copy_failed" : "compaction_failed", error instanceof Error ? error.message : String(error));
        }
      }).finally(() => this.running.delete(row.id));
      this.running.set(row.id, work);
    }
  }

  private fail(row: ThreadOperationRow, code: NonNullable<ThreadOperationView["failure"]>["code"], detail: string, retryable = true): void {
    if (row.phase === "ready" || row.phase === "failed") return;
    this.store.updateThreadOperation(row.id, { phase: "failed", failure: { stage: row.phase, code, detail: detail.slice(0, 2000), retryable } });
  }

  private async run(initial: ThreadOperationRow): Promise<void> {
    let row = initial;
    // An interrupted owner cannot race a new compaction of the same session.
    if (row.worker && pidAlive(row.worker.pid)) {
      if (!verifyProcessIdentity(row.worker.pid, row.worker.startedAt)) throw new ThreadExecutionError("worker_unreachable", "Cannot verify the interrupted compactor's process identity");
      process.kill(row.worker.pid, "SIGKILL");
      for (let i = 0; i < 100 && pidAlive(row.worker.pid); i++) await new Promise(resolve => setTimeout(resolve, 20));
      if (pidAlive(row.worker.pid)) throw new ThreadExecutionError("worker_unreachable", "Interrupted compactor has not exited");
    }
    row = this.store.updateThreadOperation(row.id, { worker: null });
    if (row.attempt >= 3) throw new ThreadExecutionError("attempts_exhausted", "Automatic recovery exhausted three execution attempts; retry explicitly");
    row = this.store.updateThreadOperation(row.id, { attempt: row.attempt + 1 });
    if (row.phase === "copying") {
      if (!row.transcriptReady) {
        await copyPinnedHistory(row);
        if (this.abort.signal.aborted) return;
        row = this.store.updateThreadOperation(row.id, { transcriptReady: true });
      }
      await seedSuccessorHistory(row);
      if (this.abort.signal.aborted) return;
      row = this.store.updateThreadOperation(row.id, { phase: row.kind === "handoff" ? "compacting" : "starting" });
    }
    if (row.phase === "compacting") {
      await this.compact({ row, spec: this.resolve(row.successorBeeId), signal: this.abort.signal,
        recordWorker: worker => { this.store.updateThreadOperation(row.id, { worker }); } });
      if (this.abort.signal.aborted) return;
      this.store.updateThreadOperation(row.id, { phase: "starting", compacted: true, worker: null });
    }
  }

  async shutdown(): Promise<void> {
    this.abort.abort();
    await Promise.allSettled(this.running.values());
  }
}
