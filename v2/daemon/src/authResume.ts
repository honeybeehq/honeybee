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
import { AUTH_CONTINUE_BODY, type AccountRow, type AuthInterruptionRow, type AuthRestoreSource, type BeeRow, type CoreStore } from "../../core/src/index.ts";
import type { FlagEvidenceLike } from "./loops.ts";

export interface AuthResumeOptions {
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

  constructor(opts: AuthResumeOptions) {
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
    const row = this.store.recordAuthInterruption({
      beeId: bee.id,
      account: account.id,
      generation: ev.generation,
      messageIds: ev.turn?.messageIds ?? [],
      turnProgress: ev.turn?.progress ?? "unknown",
      credentialRevision: this.credentialRevision(account),
      detail: ev.detail,
    });
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
        const row = live.get(beeId);
        // A failure recorded against another account says nothing about this one.
        if (row && row.account !== account.id) continue;
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
    if (this.store.lastAuditSeq() === this.reconciledSeq) return;
    this.reconcileRows();
    this.reconciledSeq = this.store.lastAuditSeq();
  }

  private reconcileRows(): void {
    for (const row of this.store.listLiveAuthInterruptions()) {
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
