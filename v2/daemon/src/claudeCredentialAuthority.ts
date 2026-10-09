/** Opt-in per account. The private document is the only refresh-chain owner for each enrolled account. */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseClaudeCredentials, type AccountCredentialAuthority, type AccountRow, type CoreStore, type CredentialRefreshFailure } from "../../core/src/index.ts";
import { describeRefreshFailure, sanitizeProviderText, type ClaudeRefreshFailure, type ClaudeRefreshResult, type ClaudeRefreshTransport } from "./claudeRefreshTransport.ts";

export interface AuthorityDocument {
  generation: number;
  operationKey: string | null;
  document: Record<string, unknown>;
  /** The native chain enrollment adopted, secret-free, so its untouched copies are not mistaken for a foreign login. */
  adopted?: AdoptedChain;
  /** Enrollment provenance retained while disabling, including after a restart. */
  rollbackAdopted?: AdoptedChain;
}
export interface AdoptedChain {
  refreshTokenDigest: string;
  expiresAt: number;
}
export function refreshTokenDigest(refreshToken: string): string {
  return createHash("sha256").update(refreshToken).digest("hex");
}
export interface CentralCredentialOptions {
  store: CoreStore;
  root: string;
  beforeEnroll: (account: AccountRow) => void;
  nativeCredential: (account: AccountRow) => Promise<Record<string, unknown> | null>;
  publish: (account: AccountRow, document: Record<string, unknown>, accessOnly: boolean) => Promise<void>;
  beforeUse: (account: AccountRow, document: Record<string, unknown>) => void;
  beforeRefresh: (account: AccountRow, document: Record<string, unknown>) => Promise<unknown>;
  refresh: ClaudeRefreshTransport;
  /** A rotation was saved and published: runtimes can read the new credential. */
  onRefreshed?: (account: AccountRow) => void;
  now: () => number;
  log: (op: string) => void;
  /** First retry delay after a refresh that did not succeed; doubles per consecutive attempt up to REFRESH_RETRY_MAX_MS. */
  retryBaseMs: number;
}
export const REFRESH_RETRY_MAX_MS = 15 * 60_000;
/**
 * `login_required`: only a new login recovers the account. `operation_in_progress`:
 * another credential operation holds the account's lane; retry shortly.
 */
export type CredentialUnavailableReason = "login_required" | "operation_in_progress" | "unavailable";
export class CredentialAuthorityError extends Error {
  readonly code = "account_unavailable";
  readonly reason: CredentialUnavailableReason;
  constructor(message: string, reason: CredentialUnavailableReason = "unavailable") {
    super(message);
    this.reason = reason;
  }
}
export class CredentialOwnershipConflict extends CredentialAuthorityError {}
type RefreshAttempt = { kind: "success"; token: Extract<ClaudeRefreshResult, { kind: "success" }>["token"] } | { kind: "failed"; result: ClaudeRefreshFailure; failure: CredentialRefreshFailure };

/** Persist the rotated chain before acknowledging it or publishing any access-only copy. */
function save(path: string, value: AuthorityDocument): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

export class ClaudeCredentialAuthority {
  private readonly pending = new Map<string, { kind: string; promise: Promise<AccountCredentialAuthority> }>();
  private readonly options: CentralCredentialOptions;
  constructor(options: CentralCredentialOptions) { this.options = options; }

  status(account: AccountRow): AccountCredentialAuthority | null {
    return this.options.store.getAccountCredentialAuthority(account.id);
  }
  enabled(account: AccountRow): boolean {
    const state = this.status(account);
    return state !== null && state.phase !== "disabled";
  }
  busy(account: AccountRow): boolean { return this.pending.has(account.id); }
  private path(account: AccountRow): string { return join(this.options.root, `${encodeURIComponent(account.id)}.json`); }
  private read(account: AccountRow): AuthorityDocument {
    let value: AuthorityDocument;
    try { value = JSON.parse(readFileSync(this.path(account), "utf8")) as AuthorityDocument; }
    catch { throw new CredentialAuthorityError("Central credential is unavailable; do not import a runtime copy over it."); }
    if (!Number.isSafeInteger(value.generation) || !parseClaudeCredentials(JSON.stringify(value.document))) {
      throw new CredentialAuthorityError("Central credential is invalid; account recovery is required.");
    }
    return value;
  }
  document(account: AccountRow): Record<string, unknown> {
    return this.read(account).document;
  }
  private put(account: AccountRow, phase: AccountCredentialAuthority["phase"], value: AuthorityDocument, failure: CredentialRefreshFailure | null = null): AccountCredentialAuthority {
    const before = this.status(account);
    const credential = parseClaudeCredentials(JSON.stringify(value.document));
    const next = this.options.store.putAccountCredentialAuthority({ account: account.id, phase,
      generation: value.generation, operationKey: value.operationKey,
      expiresAt: credential?.expiresAt ?? null, refreshTokenExpiresAt: credential?.refreshTokenExpiresAt ?? null, failure });
    if (before?.phase !== phase) {
      this.options.log(`account.credentials.phase account=${account.id} from=${before?.phase ?? "-"} to=${phase} generation=${value.generation}`
        + ` reason=${JSON.stringify(failure ? `${failure.outcome}: ${describeRefreshFailure(failure)}` : null)}`);
    }
    return next;
  }
  /**
   * The one way into `ready`. `resolveDoubt`: this rotation answers an unknown
   * outcome, so the account's status is restored before anyone is told the
   * credential works again.
   */
  private ready(account: AccountRow, value: AuthorityDocument, resolveDoubt: boolean): AccountCredentialAuthority {
    const refreshTokenExpiresAt = parseClaudeCredentials(JSON.stringify(value.document))?.refreshTokenExpiresAt;
    if (refreshTokenExpiresAt !== undefined) this.options.store.setAccountRefreshTokenExpiry(account.id, refreshTokenExpiresAt, "central credential refreshed");
    const ready = this.put(account, "ready", value);
    if (resolveDoubt) this.doubtResolved(account);
    this.options.onRefreshed?.(account);
    return ready;
  }
  private retryDelayMs(attempts: number): number {
    return Math.min(this.options.retryBaseMs * 2 ** Math.min(attempts - 1, 20), REFRESH_RETRY_MAX_MS);
  }
  private failureOf(result: ClaudeRefreshFailure, previous: CredentialRefreshFailure | null): CredentialRefreshFailure {
    const at = this.options.now();
    const attempts = (previous?.attempts ?? 0) + 1;
    const retryAt = result.kind === "rejected" ? null
      : at + (result.kind === "retryable" && result.retryAfterMs !== undefined ? result.retryAfterMs : this.retryDelayMs(attempts));
    return { outcome: result.kind, httpStatus: result.kind === "unknown_outcome" ? null : result.httpStatus,
      error: result.kind === "unknown_outcome" ? null : result.error, description: result.description, at, attempts, retryAt };
  }
  /** A process death proves nothing about the token and leaves nothing to wait for: the retry is due at once. */
  private interrupted(description: string, previous: CredentialRefreshFailure | null): CredentialRefreshFailure {
    return { ...this.failureOf({ kind: "unknown_outcome", description }, previous), retryAt: this.options.now() };
  }
  /** One provider round trip. Every attempt is logged with its outcome; a throw from the transport proves nothing about the token. */
  private async attempt(account: AccountRow, refreshToken: string, generation: number, previous: CredentialRefreshFailure | null, during: "enroll" | "refresh"): Promise<RefreshAttempt> {
    let result: ClaudeRefreshResult;
    try { result = await this.options.refresh(refreshToken); }
    catch (error) {
      result = { kind: "unknown_outcome", description: sanitizeProviderText(error instanceof Error ? error.message : String(error), [refreshToken]) ?? "transport failed" };
    }
    if (result.kind === "success") {
      const token = result.token;
      if (token.accessToken && token.refreshToken && Number.isFinite(token.expiresAt) && token.expiresAt > this.options.now()) {
        this.options.log(`account.credentials.refresh account=${account.id} during=${during} generation=${generation} outcome=success`
          + ` expires=${new Date(token.expiresAt).toISOString()} login_expires=${token.refreshTokenExpiresAt !== undefined ? new Date(token.refreshTokenExpiresAt).toISOString() : "-"}`);
        return { kind: "success", token };
      }
      result = { kind: "unknown_outcome", description: "the provider answered with an unusable token" };
    }
    const failure = this.failureOf(result, previous);
    this.options.log(`account.credentials.refresh account=${account.id} during=${during} generation=${generation} outcome=${failure.outcome}`
      + ` reason=${JSON.stringify(describeRefreshFailure(failure))} attempts=${failure.attempts} retry_at=${failure.retryAt !== null ? new Date(failure.retryAt).toISOString() : "-"}`);
    return { kind: "failed", result, failure };
  }
  /** What the operator must do; also the account's status reason and the lease refusal text. */
  loginRequiredMessage(account: AccountRow, failure: CredentialRefreshFailure | null): string {
    const why = failure ? `the provider refused the refresh token (${describeRefreshFailure(failure)})` : "the refresh token is no longer usable";
    return `Claude login required for ${account.id}: ${why}. Recover with: hive account credentials disable ${account.id}; hive account login ${account.id}; hive account credentials enable ${account.id}`;
  }
  /** A paused account stays paused: the operator parked it, and unpausing re-derives the honest status. */
  private markAuthNeeded(account: AccountRow, reason: string): void {
    const current = this.options.store.getAccount(account.id);
    if (current && current.status !== "paused" && this.options.store.setAccountStatus(account.id, "auth_needed", reason).applied) {
      this.options.log(`account.auth_needed account=${account.id} by=central_refresh`);
    }
  }
  private requireLogin(account: AccountRow, value: AuthorityDocument, failure: CredentialRefreshFailure): CredentialAuthorityError {
    this.put(account, "login_required", value, failure);
    const message = this.loginRequiredMessage(account, failure);
    this.markAuthNeeded(account, message);
    return new CredentialAuthorityError(message, "login_required");
  }
  /** A token the provider issued is the evidence that ends the doubt `outcomeUnknown` raised. */
  private doubtResolved(account: AccountRow): void {
    if (this.options.store.getAccount(account.id)?.status === "auth_needed"
      && this.options.store.setAccountStatus(account.id, "ok", "central refresh succeeded").applied) {
      this.options.log(`account.auth_ok account=${account.id} by=central_refresh`);
    }
  }
  private outcomeUnknownMessage(account: AccountRow, failure: CredentialRefreshFailure | null): string {
    return `Central refresh outcome unknown for ${account.id} (${failure ? describeRefreshFailure(failure) : "no detail"}); retrying automatically, ends in ready or login_required`;
  }
  /** The token may be consumed, so the credential is not known to work until the scheduled retry answers. */
  private outcomeUnknown(account: AccountRow, value: AuthorityDocument, failure: CredentialRefreshFailure): void {
    this.put(account, "uncertain", value, failure);
    this.markAuthNeeded(account, this.outcomeUnknownMessage(account, failure));
  }
  /** Why this authority does not vouch for the account's credential; null while it does. */
  inDoubtReason(account: AccountRow): string | null {
    const state = this.status(account);
    if (state?.phase === "login_required") return this.loginRequiredMessage(account, state.failure);
    if (state?.phase === "uncertain") return this.outcomeUnknownMessage(account, state.failure);
    return null;
  }
  /** Whether a scheduled retry or a refresh interrupted by a process death is waiting for the next ensure(). */
  retryDue(account: AccountRow): boolean {
    if (this.busy(account)) return false;
    const state = this.status(account);
    if (!state) return false;
    if (state.phase === "refreshing") return true;
    const retryAt = state.failure?.retryAt ?? null;
    // An `uncertain` row written before schema v34 has no retry metadata: it is due.
    if (state.phase === "uncertain") return retryAt === null || retryAt <= this.options.now();
    return state.phase === "ready" && retryAt !== null && retryAt <= this.options.now();
  }
  private assertQuiescent(account: AccountRow): void {
    if (this.options.store.beesOnAccount(account.id).some(bee => {
      const runtime = this.options.store.currentRuntime(bee.id);
      return runtime !== null && runtime.state !== "stopped";
    })) throw new CredentialAuthorityError("Stop this account's local Claude sessions before changing credential ownership; idle sessions still hold credentials.");
    const flow = this.options.store.activeLoginFlow(account.id);
    if (flow) {
      throw new CredentialAuthorityError("Finish or cancel the account's login before changing credential ownership.");
    }
  }
  private lane(account: AccountRow, kind: string, run: () => Promise<AccountCredentialAuthority>): Promise<AccountCredentialAuthority> {
    const existing = this.pending.get(account.id);
    if (existing) {
      if (existing.kind === kind || (kind === "ensure" && existing.kind.startsWith("force:"))) return existing.promise;
      if (kind.startsWith("force:") && (existing.kind === "ensure" || existing.kind.startsWith("force:"))) {
        const retry = () => this.lane(account, kind, run);
        return existing.promise.then(retry, retry);
      }
      return Promise.reject(new CredentialAuthorityError("Another credential operation is in progress; retry when it finishes.", "operation_in_progress"));
    }
    const promise = Promise.resolve().then(run).finally(() => { this.pending.delete(account.id); });
    this.pending.set(account.id, { kind, promise });
    return promise;
  }
  /** The chain enrollment adopted; only meaningful while `enrolling`. */
  adopted(account: AccountRow): AdoptedChain | null {
    try { return this.read(account).adopted ?? null; } catch { return null; }
  }
  rollbackAdopted(account: AccountRow): AdoptedChain | null {
    try { return this.read(account).rollbackAdopted ?? null; } catch { return null; }
  }
  private preserveEnrollmentRollback(account: AccountRow, value: AuthorityDocument): AuthorityDocument {
    if (value.adopted && !value.rollbackAdopted) {
      value = { ...value, rollbackAdopted: value.adopted };
      save(this.path(account), value);
    }
    return value;
  }
  private enrollmentReady(account: AccountRow, value: AuthorityDocument, resolveDoubt = false): AccountCredentialAuthority {
    // Clear before ready: a crash leaves enrolling, which can recover provenance.
    // A later native login must never inherit enrollment's rollback allowance.
    if (value.rollbackAdopted) {
      value = { ...value };
      delete value.rollbackAdopted;
      save(this.path(account), value);
    }
    return this.ready(account, value, resolveDoubt);
  }
  enable(account: AccountRow): Promise<AccountCredentialAuthority> {
    return this.lane(account, "enable", async () => {
      if (account.harness !== "claude") throw new CredentialAuthorityError("Central credential management supports Claude only.");
      this.assertQuiescent(account);
      this.options.beforeEnroll(account);
      const before = this.status(account);
      if (before?.phase === "ready") { this.read(account); return before; }
      if (before?.phase === "login_required") throw new CredentialAuthorityError(this.loginRequiredMessage(account, before.failure), "login_required");
      if (before && !["disabled", "enrolling"].includes(before.phase)) throw new CredentialAuthorityError("Resolve the incomplete refresh before enrolling again.");
      let value: AuthorityDocument;
      if (before?.phase === "enrolling") {
        value = this.read(account);
        if (before.operationKey !== null) {
          // The validating rotation was in flight when enrollment was interrupted.
          if (value.operationKey === before.operationKey && value.generation > before.generation) {
            await this.options.publish(account, value.document, true);
            return this.enrollmentReady(account, value);
          }
          value = this.preserveEnrollmentRollback(account, value);
          this.outcomeUnknown(account, { ...value, operationKey: before.operationKey }, this.interrupted("the daemon stopped during the enrollment refresh", before.failure));
          throw new CredentialAuthorityError("The enrollment refresh was interrupted and its outcome is unknown; it is retried automatically and ends in ready or login_required.");
        }
      } else {
        const document = await this.options.nativeCredential(account);
        const candidate = document ? parseClaudeCredentials(JSON.stringify(document)) : null;
        if (!document || !candidate?.refreshToken) {
          throw new CredentialAuthorityError("This account has no refresh credential; complete a login before enrolling it.");
        }
        if (candidate.expiresAt <= this.options.now()) {
          // Nothing is saved or published: native copies stay exactly as they are.
          throw new CredentialAuthorityError(`This account's credential expired at ${new Date(candidate.expiresAt).toISOString()}; log in natively (hive account login ${account.id}) before enrolling it.`);
        }
        this.assertQuiescent(account); // A spawn/login may have arrived during Keychain I/O.
        this.options.beforeEnroll(account);
        value = { generation: (before?.generation ?? 0) + 1, operationKey: null, document,
          adopted: { refreshTokenDigest: refreshTokenDigest(candidate.refreshToken), expiresAt: candidate.expiresAt } };
        // Save first while no runtime can start in this synchronous section.
        save(this.path(account), value);
        this.put(account, "enrolling", value);
      }
      // Validate the chain with one real rotation before any native copy loses its refresh token.
      const credential = parseClaudeCredentials(JSON.stringify(value.document))!;
      if (!credential.refreshToken) throw new CredentialAuthorityError("The authority has no refresh credential; disable central credentials and log in again.");
      await this.options.beforeRefresh(account, value.document);
      const operationKey = randomUUID();
      this.put(account, "enrolling", { ...value, operationKey });
      const attempt = await this.attempt(account, credential.refreshToken, value.generation, null, "enroll");
      if (attempt.kind === "failed") {
        const detail = describeRefreshFailure(attempt.failure);
        if (attempt.result.kind === "rejected") {
          // A definitive provider refusal consumed nothing: abort with native copies intact.
          this.put(account, "disabled", value);
          this.options.store.setAccountStatus(account.id, "auth_needed", `Central enrollment refused: the provider rejected the refresh token (${detail}); log in again: hive account login ${account.id}`);
          throw new CredentialAuthorityError(`The provider refused this account's refresh credential (${detail}); native copies are unchanged. Log in natively (hive account login ${account.id}) before enrolling it.`);
        }
        if (attempt.result.kind === "retryable") {
          // The provider did not process the request: the native chain is whole, so enrollment simply did not happen.
          this.put(account, "disabled", value);
          throw new CredentialAuthorityError(`The provider did not process the enrollment refresh (${detail}); native copies are unchanged. Retry: hive account credentials enable ${account.id}`);
        }
        value = this.preserveEnrollmentRollback(account, value);
        this.outcomeUnknown(account, { ...value, operationKey }, attempt.failure);
        throw new CredentialAuthorityError(`The enrollment refresh outcome is unknown (${detail}); it is retried automatically and ends in ready or login_required.`);
      }
      const oauth = value.document.claudeAiOauth as Record<string, unknown>;
      value = { ...value, generation: value.generation + 1, operationKey,
        document: { ...value.document, claudeAiOauth: { ...oauth, ...attempt.token } } };
      save(this.path(account), value);
      await this.options.publish(account, value.document, true);
      return this.enrollmentReady(account, value);
    });
  }
  disable(account: AccountRow): Promise<AccountCredentialAuthority> {
    return this.lane(account, "disable", async () => {
      this.assertQuiescent(account);
      const state = this.status(account);
      if (!state) throw new CredentialAuthorityError("This account is not centrally managed.");
      if (state.phase === "disabled") return state;
      let value: AuthorityDocument;
      try { value = this.read(account); }
      catch {
        // A lost authority must have a supported recovery path, without trusting a runtime copy.
        this.options.store.setAccountStatus(account.id, "auth_needed", "Central credential lost; log in again");
        return this.options.store.putAccountCredentialAuthority({ ...state, phase: "disabled", failure: null });
      }
      // Enrollment also crosses the provider boundary. A process death can
      // leave its in-flight fence without ever reaching the uncertainty handler.
      // Only a matching durable rotated result proves that this chain is usable.
      const enrollmentUnknown = state.phase === "enrolling" && state.operationKey !== null
        && !(value.operationKey === state.operationKey && value.generation > state.generation);
      const uncertain = state.phase === "refreshing" || state.phase === "uncertain" || state.phase === "login_required"
        || state.phase === "disabling_uncertain" || enrollmentUnknown;
      if (state.phase === "enrolling") value = this.preserveEnrollmentRollback(account, value);
      this.put(account, uncertain ? "disabling_uncertain" : "disabling", value); // Preserve rollback intent across restart.
      try { await this.options.publish(account, value.document, uncertain); }
      catch (error) {
        if (!(error instanceof CredentialOwnershipConflict)) throw error;
        // A new external login belongs to the operator. Never overwrite it to restore an older chain.
        this.options.store.setAccountStatus(account.id, "auth_needed", "External login changed; capture or log in again after disabling central credentials");
        return this.put(account, "disabled", value);
      }
      if (uncertain) this.options.store.setAccountStatus(account.id, "auth_needed", `Central credentials disabled without a usable refresh token; log in again: hive account login ${account.id}`);
      return this.put(account, "disabled", value);
    });
  }
  assertDisabled(account: AccountRow): void {
    if (this.enabled(account) || this.busy(account)) throw new CredentialAuthorityError("Disable central credentials before removing this account.");
  }
  forgetDisabled(account: AccountRow): void {
    this.assertDisabled(account);
    try { unlinkSync(this.path(account)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  async checkRuntimeCopies(account: AccountRow): Promise<void> {
    await this.options.beforeRefresh(account, this.read(account).document);
  }
  ensure(account: AccountRow, minTtlMs: number, forceKey?: string): Promise<AccountCredentialAuthority> {
    return this.lane(account, forceKey ? `force:${forceKey}` : "ensure", async () => {
      let state = this.status(account);
      if (!state || state.phase === "disabled") throw new CredentialAuthorityError("Enable central credentials for this account first.");
      if (state.phase === "login_required") throw new CredentialAuthorityError(this.loginRequiredMessage(account, state.failure), "login_required");
      let value = this.read(account);
      if (state.phase === "refreshing" || state.phase === "uncertain") {
        // A saved result can settle a crash after provider success, including publication failure.
        if (value.operationKey === state.operationKey && value.generation > state.generation) {
          await this.options.publish(account, value.document, true);
          // The fence of a retry carries the unknown outcome it was retrying.
          return this.enrollmentReady(account, value, state.phase === "uncertain" || state.failure?.outcome === "unknown_outcome");
        }
        if (state.phase === "refreshing") {
          // No operation is in flight (the lane is ours), so a process death interrupted this refresh.
          this.outcomeUnknown(account, { ...value, operationKey: state.operationKey }, this.interrupted("the daemon stopped during the refresh", state.failure));
          state = this.status(account)!;
        }
      } else if (state.phase !== "ready") {
        throw new CredentialAuthorityError(`Central credentials are ${state.phase}; finish it with: hive account credentials ${state.phase === "enrolling" ? "enable" : "disable"} ${account.id}`);
      }
      const tokenStateUnknown = state.phase === "uncertain";
      const credential = parseClaudeCredentials(JSON.stringify(value.document))!;
      if (!tokenStateUnknown && ((forceKey && value.operationKey === forceKey) || (!forceKey && credential.expiresAt - this.options.now() > minTtlMs))) {
        this.options.beforeUse(account, value.document);
        return state;
      }
      if (!credential.refreshToken) {
        throw this.requireLogin(account, value, { outcome: "rejected", httpStatus: null, error: null, description: "the authority holds no refresh token",
          at: this.options.now(), attempts: (state.failure?.attempts ?? 0) + 1, retryAt: null });
      }
      const retryAt = state.failure?.retryAt ?? null;
      if (!forceKey && retryAt !== null && retryAt > this.options.now()) {
        throw new CredentialAuthorityError(`Central refresh for ${account.id} did not succeed (${state.failure!.outcome}: ${describeRefreshFailure(state.failure!)}); next attempt at ${new Date(retryAt).toISOString()}`);
      }
      await this.options.beforeRefresh(account, value.document);
      const operationKey = forceKey ?? randomUUID();
      this.put(account, "refreshing", { ...value, operationKey }, state.failure);
      const attempt = await this.attempt(account, credential.refreshToken, value.generation, state.failure, "refresh");
      if (attempt.kind === "failed") {
        const { result, failure } = attempt;
        if (result.kind === "rejected") throw this.requireLogin(account, { ...value, operationKey }, failure);
        const detail = `${describeRefreshFailure(failure)}; next attempt at ${new Date(failure.retryAt!).toISOString()}`;
        if (result.kind === "retryable" && !tokenStateUnknown) {
          this.put(account, "ready", value, failure);
          throw new CredentialAuthorityError(`The provider did not process the refresh for ${account.id} (${detail}); the refresh token is unused.`);
        }
        this.outcomeUnknown(account, { ...value, operationKey }, failure);
        throw new CredentialAuthorityError(`Central refresh outcome for ${account.id} is unknown (${detail}); it ends in ready or login_required.`);
      }
      const oauth = value.document.claudeAiOauth as Record<string, unknown>;
      // An enrollment whose first rotation had an unknown outcome completes here: its native copies still hold the adopted chain.
      const enrollment = value.rollbackAdopted ? { adopted: value.adopted, rollbackAdopted: value.rollbackAdopted } : {};
      value = { ...enrollment, generation: value.generation + 1, operationKey,
        document: { ...value.document, claudeAiOauth: { ...oauth, ...attempt.token } } };
      save(this.path(account), value);
      await this.options.publish(account, value.document, true);
      return this.enrollmentReady(account, value, tokenStateUnknown);
    });
  }
}
