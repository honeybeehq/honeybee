/**
 * Auth resume — a turn cut off by an authentication failure continues on its
 * own once the account's credential works again on this node.
 *
 * The store holds the durable record (`auth_interruptions`); this module is
 * the policy over it. Evidence arrives from the adapters through the daemon's
 * flag policy; restores arrive from every place a credential is validated
 * (login, capture, the daemon's own refresh, a readable limits probe,
 * `account.credentialsRestored`, a swap onto a healthy account). The
 * continuation is ordinary mail (`origin: auth.resume`), enqueued in the same
 * transaction that marks the row `resumed`, so a daemon death can neither
 * lose it nor send it twice.
 */
import { AUTH_DEATH_WINDOW_MS, AUTH_CONTINUE_BODY, type AccountMaterialStamp, type AccountRow, type AuthInterruptionRow, type AuthRestoreSource, type BeeRow, type CoreStore } from "../../core/src/index.ts";
import type { FlagEvidenceLike } from "./loops.ts";

export interface AuthResumeOptions {
  now?: () => number;
  material?: (account: AccountRow) => AccountMaterialStamp | null;
  store: CoreStore;
  log: (op: string) => void;
  /** The account whose credential a runtime generation of the bee ran on. */
  accountForGeneration: (bee: BeeRow, generation: number) => AccountRow | null;
  /** A stable name for the account's current credential; changes exactly when the credential does. */
  credentialRevision: (account: AccountRow) => string;
}

export interface CredentialValidatedReceipt {
  account: string;
  revision: string;
  /** Bees whose `auth_needed` flag this cleared. */
  clearedBeeIds: string[];
  /** Bees whose interrupted turn now has a continuation owed or already enqueued. */
  resumingBeeIds: string[];
  /** Bees left flagged: their continuation already failed on this same credential. */
  blockedBeeIds: string[];
}

/** An operator signing in again is a new attempt even when the credential bytes did not change. */
const OPERATOR_SOURCES: readonly AuthRestoreSource[] = ["login", "capture"];

export class AuthResume {
  private readonly store: CoreStore;
  private readonly log: (op: string) => void;
  private readonly accountForGeneration: AuthResumeOptions["accountForGeneration"];
  private readonly credentialRevision: AuthResumeOptions["credentialRevision"];
  /** Store change version of the last pass; nothing a pass decides on can change without a new audit row. */
  private reconciledSeq = -1;
  private readonly material: AuthResumeOptions["material"];
  private readonly now: () => number;

  constructor(opts: AuthResumeOptions) {
    this.now = opts.now ?? Date.now;
    this.material = opts.material;
    this.store = opts.store;
    this.log = opts.log;
    this.accountForGeneration = opts.accountForGeneration;
    this.credentialRevision = opts.credentialRevision;
  }

  /** `auth_needed` set evidence: the turn in flight on that generation was cut off. */
  interrupted(ev: FlagEvidenceLike): void {
    const bee = this.store.getBee(ev.beeId);
    if (!bee) return;
    const account = this.accountForGeneration(bee, ev.generation);
    if (!account) return;
    const runtime = this.store.currentRuntime(bee.id);
    const admitted = runtime?.credentialStamp;
    const stamp = runtime?.generation === ev.generation && admitted?.account === account.id && admitted.controlFence === (bee.authControlFence ?? 0) ? admitted : undefined;
    const row = this.store.recordAuthInterruption({
      beeId: bee.id,
      account: account.id,
      generation: ev.generation,
      messageIds: ev.turn?.messageIds ?? [],
      turnProgress: ev.turn?.progress ?? "unknown",
      credentialRevision: this.credentialRevision(account),
      detail: stamp ? "Provider authentication failed" : ev.detail,
    });
    if (stamp && !row.deathRecovery) this.store.setAuthDeathRecovery(row.id, { admitted: stamp, deathAt: null, deadline: null, claimedAt: null, replacement: null, commandId: null });
    this.log(
      `auth.interrupted bee=${bee.id} account=${account.id} gen=${ev.generation} row=${row.id} msgs=${row.messageIds.join(",") || "-"} progress=${row.turnProgress}`
        + (row.blockedRevision ? " blocked=1" : ""),
    );
  }

  /** A successful authenticated turn: the bee moved on, with or without our continuation. */
  turnSucceeded(beeId: string): void {
    const row = this.store.liveAuthInterruption(beeId);
    if (!row) return;
    const state = row.state === "resumed" ? "completed" : "superseded";
    this.store.settleAuthInterruption(row.id, state, "turn_succeeded");
    this.log(`auth.resume.${state} bee=${beeId} row=${row.id}`);
  }

  /**
   * The account's credential is known to work on this node. Clears
   * `auth_needed` for every bee the evidence points at — bees bound to the
   * account, and bees whose failure came from it before they were swapped
   * away — and makes each interrupted turn's continuation owed.
   */
  credentialValidated(account: AccountRow, by: AuthRestoreSource): CredentialValidatedReceipt {
    const revision = this.credentialRevision(account);
    const receipt: CredentialValidatedReceipt = { account: account.id, revision, clearedBeeIds: [], resumingBeeIds: [], blockedBeeIds: [] };
    const live = new Map(this.store.listLiveAuthInterruptions().map((row) => [row.beeId, row]));
    const beeIds = new Set(this.store.beesOnAccount(account.id).map((bee) => bee.id));
    for (const row of live.values()) if (row.account === account.id) beeIds.add(row.beeId);
    this.store.transact(() => {
      for (const beeId of beeIds) {
        let row = live.get(beeId);
        // A failure recorded against another account says nothing about this one.
        if (row && row.account !== account.id) continue;
        if (!row && !this.store.activeFlags(beeId).some((flag) => flag.flag === "auth_needed")) continue;
        if (row?.deathRecovery && this.holdsStoppedRuntime(row)) {
          const recovery = row.deathRecovery;
          const current = this.material?.(this.store.getAccount(account.id) ?? account);
          const admitted = recovery.admitted.material;
          const validatedSource = ["refresh", "limits_probe", "credentials_restored", "login", "capture"].includes(by);
          if (recovery.claimedAt === null && validatedSource && current && current.kind === admitted.kind && current.scope === admitted.scope && current.epoch === admitted.epoch && current.generation === admitted.generation && current.authorityInstanceId === admitted.authorityInstanceId) {
            row = this.store.releaseAuthDeathRecovery(row.id, "same_material_validated") ?? row;
          } else {
            if (row.state === "open" && (row.blockedRevision !== revision || OPERATOR_SOURCES.includes(by))) this.store.restoreAuthInterruption(row.id, { revision, by });
            continue;
          }
        }
        if (row?.state === "open" && row.blockedRevision === revision && !OPERATOR_SOURCES.includes(by)) {
          receipt.blockedBeeIds.push(beeId);
          this.log(`auth.resume.blocked bee=${beeId} account=${account.id} row=${row.id} by=${by}`);
          continue;
        }
        if (this.store.clearFlag(beeId, "auth_needed", `credential validated for account ${account.id} by ${by}`).applied) {
          receipt.clearedBeeIds.push(beeId);
          this.log(`flag.clear bee=${beeId} flag=auth_needed by=${by}`);
        }
        if (!row) continue;
        if (row.state === "open") {
          this.store.restoreAuthInterruption(row.id, { revision, by });
          this.log(`auth.restored bee=${beeId} account=${account.id} row=${row.id} by=${by}`);
        }
        receipt.resumingBeeIds.push(beeId);
      }
    });
    this.reconcile();
    return receipt;
  }

  /** The interrupted work follows the bee: it now waits on (or resumes with) the target account. */
  beeSwapped(beeId: string, target: AccountRow): void {
    const row = this.store.rebindAuthInterruption(beeId, target.id);
    if (!row || row.state !== "open" || target.status !== "ok") return;
    this.store.restoreAuthInterruption(row.id, { revision: this.credentialRevision(target), by: "account_swap" });
    this.log(`auth.restored bee=${beeId} account=${target.id} row=${row.id} by=account_swap`);
  }

  /**
   * Settle what the operator ended and enqueue every owed continuation whose
   * bee can take it. Runs each tick and at boot; every step is idempotent.
   */
  reconcile(): void {
    if (!this.material && this.store.lastAuditSeq() === this.reconciledSeq) return;
    this.reconcileRows();
    this.reconciledSeq = this.store.lastAuditSeq();
  }

  private reconcileRows(): void {
    for (const row of this.store.listLiveAuthInterruptions()) {
      if (row.deathRecovery && this.reconcileDeath(row)) continue;
      if (row.state === "resumed") continue;
      const bee = this.store.getBee(row.beeId);
      if (!bee) continue;
      const ended = this.endedByOperator(bee, row);
      if (ended) {
        this.store.settleAuthInterruption(row.id, "cancelled", ended);
        this.log(`auth.resume.cancelled bee=${bee.id} row=${row.id} reason=${ended}`);
        continue;
      }
      if (row.state !== "restored" || !this.canTakeContinuation(bee)) continue;
      const resumed = this.store.resumeAuthInterruption(row.id, AUTH_CONTINUE_BODY);
      if (!resumed.applied || !resumed.interruption) continue;
      this.log(
        `auth.resume bee=${bee.id} account=${row.account} row=${row.id} kind=${resumed.interruption.continuationKind} msgs=${resumed.interruption.continuationMessageIds.join(",")}`,
      );
    }
  }

  waitingForMaterial(beeId: string): boolean {
    const row = this.store.liveAuthInterruption(beeId);
    const recovery = row?.deathRecovery;
    return Boolean(row && recovery && recovery.claimedAt === null && this.holdsStoppedRuntime(row) && (recovery.deadline === null || this.now() < recovery.deadline));
  }

  holdsStoppedRuntime(row: AuthInterruptionRow): boolean {
    const runtime = this.store.currentRuntime(row.beeId);
    const recovery = row.deathRecovery;
    if (!recovery || runtime?.generation !== row.generation || runtime.state !== "stopped") return false;
    if (recovery.claimedAt === null) return true;
    return recovery.commandId !== null && this.store.getCommand(recovery.commandId)?.status === "queued" && this.store.getAccount(row.account)?.status === "paused";
  }

  private reconcileDeath(row: AuthInterruptionRow): boolean {
    const runtime = this.store.currentRuntime(row.beeId);
    const recovery = row.deathRecovery!;
    const bee = this.store.getBee(row.beeId);
    if (!bee) return true;
    if ((bee.authControlFence ?? 0) !== recovery.admitted.controlFence || bee.lifecycle !== "active" || bee.account !== row.account || bee.agent !== recovery.admitted.agent || bee.cwd !== recovery.admitted.cwd || bee.cellId !== recovery.admitted.cellId || bee.activeMoveId || bee.activeHandoffId) {
      this.store.releaseAuthDeathRecovery(row.id, "provenance_changed");
      return false;
    }
    if (recovery.releasedWhilePaused) {
      if (this.store.getAccount(row.account)?.status === "paused") return true;
      this.store.releaseAuthDeathRecovery(row.id, "pause_lifted");
      return true;
    }
    if (recovery.claimedAt !== null) {
      if (runtime?.generation === row.generation && runtime.state === "stopped" && recovery.commandId !== null && this.store.getCommand(recovery.commandId)?.status === "queued" && this.store.getAccount(row.account)?.status === "paused" && recovery.deadline !== null && this.now() >= recovery.deadline) this.store.releaseAuthDeathRecovery(row.id, "deadline_expired");
      return true;
    }
    if (runtime?.generation !== row.generation) {
      this.store.settleAuthInterruption(row.id, "superseded", "auth_recovery_cancelled");
      return true;
    }
    if (runtime.state !== "stopped") return false;
    if (!["clean", "crashed", "stopped_by_system"].includes(runtime.exitCause ?? "")) {
      if (runtime.exitCause === "stopped_by_user") {
        this.store.settleAuthInterruption(row.id, "cancelled", "auth_recovery_cancelled");
        return true;
      }
      this.store.releaseAuthDeathRecovery(row.id, "ordinary_exit");
      return false;
    }
    const fixed = recovery.deathAt === null ? { ...recovery, deathAt: runtime.updatedAt, deadline: runtime.updatedAt + AUTH_DEATH_WINDOW_MS } : recovery;
    this.store.setAuthDeathRecovery(row.id, fixed);
    if (this.now() >= fixed.deadline!) {
      this.store.releaseAuthDeathRecovery(row.id, "deadline_expired");
      if (row.state === "restored") this.store.clearFlag(bee.id, "auth_needed", "Previously validated account material; ordinary continuation restored");
      return false;
    }
    const account = this.store.getAccount(row.account);
    const material = account ? this.material?.(account) : null;
    if (account && material) this.store.claimAuthDeathRecovery(row.id, material, this.credentialRevision(account), AUTH_CONTINUE_BODY);
    return true;
  }

  private endedByOperator(bee: BeeRow, row: AuthInterruptionRow): "archived" | "stopped_by_user" | null {
    if (bee.lifecycle === "archived") return "archived";
    const stopped = this.store.listRuntimes(bee.id).some((rt) => rt.generation >= row.generation && rt.exitCause === "stopped_by_user");
    return stopped ? "stopped_by_user" : null;
  }

  /**
   * A turn in flight is left alone: it either succeeds (the row is settled)
   * or fails authentication again (the row absorbs it). A runtime that is
   * being stopped, moved or handed off takes the continuation afterwards.
   */
  private canTakeContinuation(bee: BeeRow): boolean {
    if (bee.activeMoveId || bee.activeHandoffId) return false;
    const rt = this.store.currentRuntime(bee.id);
    if (!rt || rt.state === "stopped") return true;
    return rt.state === "idle" && !this.store.hasPendingStopCommand(bee.id, rt.generation);
  }
}
