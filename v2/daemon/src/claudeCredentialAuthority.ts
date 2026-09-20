/** Opt-in, one-account pilot. The private document is the only refresh-chain owner. */
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseClaudeCredentials, type AccountCredentialAuthority, type AccountRow, type CoreStore } from "../../core/src/index.ts";

export interface AuthorityDocument {
  generation: number;
  operationKey: string | null;
  document: Record<string, unknown>;
}
export interface CentralCredentialOptions {
  store: CoreStore;
  root: string;
  beforeEnroll: (account: AccountRow) => void;
  nativeCredential: (account: AccountRow) => Promise<Record<string, unknown> | null>;
  publish: (account: AccountRow, document: Record<string, unknown>, accessOnly: boolean) => Promise<void>;
  beforeUse: (account: AccountRow, document: Record<string, unknown>) => void;
  beforeRefresh: (account: AccountRow, document: Record<string, unknown>) => Promise<unknown>;
  refresh: (refreshToken: string) => Promise<{ accessToken: string; refreshToken: string; expiresAt: number; scopes?: string[] } | null>;
  now: () => number;
}
export class CredentialAuthorityError extends Error {
  readonly code = "account_unavailable";
}
export class CredentialOwnershipConflict extends CredentialAuthorityError {}

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
  private put(account: AccountRow, phase: AccountCredentialAuthority["phase"], value: AuthorityDocument): AccountCredentialAuthority {
    return this.options.store.putAccountCredentialAuthority({ account: account.id, phase,
      generation: value.generation, operationKey: value.operationKey,
      expiresAt: parseClaudeCredentials(JSON.stringify(value.document))?.expiresAt ?? null });
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
      return Promise.reject(new CredentialAuthorityError("Another credential operation is in progress; retry when it finishes."));
    }
    const promise = Promise.resolve().then(run).finally(() => { this.pending.delete(account.id); });
    this.pending.set(account.id, { kind, promise });
    return promise;
  }
  enable(account: AccountRow): Promise<AccountCredentialAuthority> {
    return this.lane(account, "enable", async () => {
      if (account.harness !== "claude") throw new CredentialAuthorityError("The central credential pilot supports Claude only.");
      this.assertQuiescent(account);
      this.options.beforeEnroll(account);
      for (const other of this.options.store.listAccounts()) {
        if (other.id !== account.id && (this.enabled(other) || this.pending.get(other.id)?.kind === "enable")) throw new CredentialAuthorityError("The pilot supports one centrally managed account at a time.");
      }
      const before = this.status(account);
      if (before?.phase === "ready") { this.read(account); return before; }
      if (before && !["disabled", "enrolling"].includes(before.phase)) throw new CredentialAuthorityError("Resolve the incomplete refresh before enrolling again.");
      let value: AuthorityDocument;
      if (before?.phase === "enrolling") {
        value = this.read(account);
      } else {
        const document = await this.options.nativeCredential(account);
        if (!document || !parseClaudeCredentials(JSON.stringify(document))?.refreshToken) {
          throw new CredentialAuthorityError("This account has no refresh credential; complete a login before enrolling it.");
        }
        this.assertQuiescent(account); // A spawn/login may have arrived during Keychain I/O.
        this.options.beforeEnroll(account);
        value = { generation: (before?.generation ?? 0) + 1, operationKey: null, document };
        // Save first while no runtime can start in this synchronous section.
        save(this.path(account), value);
        this.put(account, "enrolling", value);
      }
      await this.options.publish(account, value.document, true);
      return this.put(account, "ready", value);
    });
  }
  disable(account: AccountRow): Promise<AccountCredentialAuthority> {
    return this.lane(account, "disable", async () => {
      this.assertQuiescent(account);
      const state = this.status(account);
      if (!state) throw new CredentialAuthorityError("This account is not enrolled in the pilot.");
      if (state.phase === "disabled") return state;
      const uncertain = state.phase === "refreshing" || state.phase === "uncertain" || state.phase === "disabling_uncertain";
      let value: AuthorityDocument;
      try { value = this.read(account); }
      catch {
        // A lost authority must have a supported recovery path, without trusting a runtime copy.
        this.options.store.setAccountStatus(account.id, "auth_needed", "Central credential lost; log in again");
        return this.options.store.putAccountCredentialAuthority({ ...state, phase: "disabled" });
      }
      this.put(account, uncertain ? "disabling_uncertain" : "disabling", value); // Preserve rollback intent across restart.
      try { await this.options.publish(account, value.document, uncertain); }
      catch (error) {
        if (!(error instanceof CredentialOwnershipConflict)) throw error;
        // A new external login belongs to the operator. Never overwrite it to restore an older chain.
        this.options.store.setAccountStatus(account.id, "auth_needed", "External login changed; capture or log in again after disabling the pilot");
        return this.put(account, "disabled", value);
      }
      if (uncertain) this.options.store.setAccountStatus(account.id, "auth_needed", "Central refresh outcome unknown; log in again");
      return this.put(account, "disabled", value);
    });
  }
  assertDisabled(account: AccountRow): void {
    if (this.enabled(account) || this.busy(account)) throw new CredentialAuthorityError("Disable the central credential pilot before removing this account.");
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
      const state = this.status(account);
      if (!state || state.phase === "disabled") throw new CredentialAuthorityError("Enable central credentials for this account first.");
      let value = this.read(account);
      // A saved result can settle a crash after provider success, including publication failure.
      if ((state.phase === "refreshing" || state.phase === "uncertain") && value.operationKey === state.operationKey && value.generation > state.generation) {
        await this.options.publish(account, value.document, true);
        return this.put(account, "ready", value);
      }
      if (state.phase !== "ready") throw new CredentialAuthorityError(`Central credentials are ${state.phase}; stop this account's local sessions, disable the pilot and log in again; retry enable only for an interrupted enrollment.`);
      const credential = parseClaudeCredentials(JSON.stringify(value.document))!;
      if ((forceKey && value.operationKey === forceKey) || (!forceKey && credential.expiresAt - this.options.now() > minTtlMs)) {
        this.options.beforeUse(account, value.document);
        return state;
      }
      if (!credential.refreshToken) throw new CredentialAuthorityError("The authority has no refresh credential; account recovery is required.");
      await this.options.beforeRefresh(account, value.document);
      const operationKey = forceKey ?? randomUUID();
      this.put(account, "refreshing", { ...value, operationKey });
      let refreshed;
      try { refreshed = await this.options.refresh(credential.refreshToken); }
      catch {
        this.put(account, "uncertain", { ...value, operationKey });
        throw new CredentialAuthorityError("Refresh outcome is uncertain; the pilot will not retry a possibly consumed refresh token automatically.");
      }
      if (!refreshed || !refreshed.accessToken || !refreshed.refreshToken || !Number.isFinite(refreshed.expiresAt) || refreshed.expiresAt <= this.options.now()) {
        this.put(account, "uncertain", { ...value, operationKey });
        throw new CredentialAuthorityError("The provider refused the refresh credential; account recovery is required.");
      }
      const oauth = value.document.claudeAiOauth as Record<string, unknown>;
      value = { generation: value.generation + 1, operationKey,
        document: { ...value.document, claudeAiOauth: { ...oauth, ...refreshed } } };
      save(this.path(account), value);
      await this.options.publish(account, value.document, true);
      return this.put(account, "ready", value);
    });
  }
}
