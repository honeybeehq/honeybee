/**
 * AccountsService — the daemon's account plane (spec 08 CORE): the calibrated
 * `auto` selection over the store (candidates → ported selector → near-tie
 * rotation through the cursor row → one log line), the bounded in-daemon
 * limits refresh (injected provider transports; claude OAuth usage endpoint,
 * codex app-server), credential validation + capture (home → vault; the
 * login FLOW itself — methods, workers, phases — lives in loginFlows.ts as of
 * the tmux-independent login, 2026-08-28), the empty-home activation hook the
 * driver's spawn resolve calls, and the read-only importer of the OLD
 * ~/.hive/vault registry into rows.
 *
 * Everything that talks to a provider or a keychain is injected; the defaults
 * are the real transports. Tests inject fakes.
 */
import { execFile, spawn as spawnChild } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { writeFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, renameSync, rmSync, statSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathStrictlyInside } from "./accountConfigImport.ts";
import { promisify } from "node:util";
import { CredentialHandoffService } from "./credentialHandoff.ts";
import { CredentialAuthority, ClaudeCredentialAuthority, CredentialAuthorityError, CredentialOwnershipConflict, refreshTokenDigest } from "./claudeCredentialAuthority.ts";
import { defaultClaudeRefreshTransport, describeRefreshFailure, sanitizeProviderText, type ClaudeRefreshResult, type ClaudeRefreshTransport, type RefreshedClaudeToken } from "./claudeRefreshTransport.ts";
import { CodexCredentialAuthority, CODEX_CREDENTIAL_CODEC, readCodexCredentialCopy, defaultCodexRefreshTransport } from "./codexCredentialAuthority.ts";
import { MuseCredentialAuthority, MUSE_CREDENTIAL_CODEC, MUSE_DEFAULT_KEY_TTL_MS, museMeta, museWorkingDocument, defaultMuseKeyTransport } from "./museCredentialAuthority.ts";
import { GrokCredentialAuthority, GROK_CREDENTIAL_CODEC, grokAccessOnly, grokCredentialEntry, defaultGrokRefreshTransport } from "./grokCredentialAuthority.ts";
import { liveGateways } from "./gateways.ts";
import { withFileLock } from "../../../src/lock.ts";
import { seedGatewayMcp, type GatewayMcpSeedResult } from "../../../src/accounts/gatewayMcpSeed.ts";
import {
  AUTO_PICK_DEBIT_PERCENT,
  DEFAULT_ACCOUNT_ADMISSION_POLICY,
  accountActiveBees,
  accountIsolationRefusal,
  accountCommitments,
  nativeAccountRecipe,
  accountIdFor,
  isAccountId,
  AUTH_CREDENTIAL_UNREADABLE,
  homeEnvFor,
  isAuthFailureLimitsError,
  limitsFromRow,
  measureWindowVelocity,
  parseClaudeCredentials,
  parseMuseCredentials,
  parseMuseUsage,
  museQuotaLimits,
  pauseLabel,
  pauseOf,
  parseClaudeUsage,
  parseCodexRateLimits,
  pendingPickDebit,
  prunePendingPicks,
  recipeEnvFor,
  recipeFor,
  resolveVendorHome,
  rotateNearTie,
  selectAccountAdmission,
  selectLeastLoadedAccount,
  windowRolledOver,
  isFableModel,
  type AccountLimits,
  type NativeAccountRecipe,
  type AccountAdmissionCandidate,
  type AccountAdmissionDecision,
  type AccountAdmissionOperation,
  type AccountAdmissionReservationRow,
  type AccountLimitsRow,
  type AccountLimitsUnreadableReason,
  type AccountRow,
  type BeeRow,
  type AccountStatus,
  type AutoAccountCandidate,
  type ClaudeUsageResponse,
  type CodexLiveRateLimits,
  type CoreStore,
  type CredentialHealth,
  type MirrorAccountRow,
  loginDueAtOf,
  type PendingPick,
  type PutAccountLimitsInput,
  type RateLimitResetCredits,
  type WindowUsage,
  type WindowVelocities,
} from "../../core/src/index.ts";
import {
  activateHomeIfEmpty,
  captureHomeToVault,
  defaultHomeFor,
  dirHasCredentials,
  primaryCredentialFile,
  seedClaudeKeychainFromVault,
  vaultDirFor,
  type ActivationResult,
} from "./activation.ts";
import type { ResolvedNodeConfig } from "./config.ts";
import { readClaudeKeychain, readClaudeKeychainState, writeClaudeKeychainEntry, claudeKeychainService, removeClaudeKeychainEntry, type KeychainRemover, type KeychainState, type KeychainStateReader, type KeychainReader, type KeychainWriter } from "./keychain.ts";
import { atomicWriteFileSync } from "./homeDefaults.ts";
import { withClaudeRefreshLock } from "./claudeRefreshLock.ts";
import { createLeaseMaterialCodecs, hasRefreshGrant, type LeaseMaterialCodec } from "./leaseMaterial.ts";
import { LEASE_FENCE_FIELDS, RpcError, type AccountLeaseExportResult, type AccountLeaseInstallParams, type AccountLeaseInstallResult, type AccountLeaseRemoveResult, type AccountLeaseRemoveParams } from "./protocol.ts";
import { fetchClaudeIdentity, type ClaudeIdentity } from "./login/transports.ts";
import {
  defaultProviderLimitsHttp,
  fetchSecondaryProviderLimits,
  type ProviderLimitsHttp,
} from "./providerLimits.ts";
import {
  cursorCredentialEnv,
  parseCursorAuth,
  readCursorLiveAuth,
  type CursorAuthReader,
} from "./cursorAuth.ts";

// ---------------------------------------------------------------------------
// injected transports
// ---------------------------------------------------------------------------

export interface LimitsFetchers {
  /** GET api.anthropic.com/api/oauth/usage with a bearer token (default: real fetch). */
  claudeUsage?: (accessToken: string) => Promise<ClaudeUsageResponse>;
  /** Rotate a Claude OAuth refresh token (default: real OAuth endpoint). A throw is an unknown outcome. */
  claudeRefresh?: ClaudeRefreshTransport;
  /** `codex app-server` account/rateLimits/read against a home (default: real child process). */
  codexRateLimits?: (homePath: string) => Promise<CodexRateLimitsFetchResult>;
  /** Consume one earned reset, then return a fresh limits snapshot. */
  codexResetLimits?: (homePath: string, idempotencyKey: string, creditId?: string) => Promise<CodexResetLimitsFetchResult>;
  /** The Anthropic account a Claude access token belongs to (default: the real profile endpoint). */
  claudeIdentity?: (accessToken: string) => Promise<ClaudeIdentity | null>;
}

export type CodexRateLimitsFetchResult =
  | { ok: true; limits: CodexLiveRateLimits }
  | { ok: false; unreadableReason: AccountLimitsUnreadableReason; error: string };

export const CODEX_RESET_OUTCOMES = ["reset", "alreadyRedeemed", "nothingToReset", "noCredit"] as const;
export type CodexResetOutcome = (typeof CODEX_RESET_OUTCOMES)[number];
export type CodexResetLimitsFetchResult =
  | { ok: true; outcome: CodexResetOutcome; limits: CodexLiveRateLimits }
  | { ok: false; code: "provider_outcome_uncertain" | "provider_unsupported" | "provider_refused"; error: string };

export class ResetLimitsRefusal extends Error {
  readonly code: "harness_mismatch" | "provider_outcome_uncertain" | "provider_unsupported" | "provider_refused";

  constructor(code: "harness_mismatch" | "provider_outcome_uncertain" | "provider_unsupported" | "provider_refused", message: string) {
    super(message);
    this.name = "ResetLimitsRefusal";
    this.code = code;
  }
}

export type { ClaudeRefreshResult, ClaudeRefreshTransport, RefreshedClaudeToken };

export interface LeaseOptions {
  /**
   * The remaining access-token lifetime the caller wants. A centrally managed
   * Claude account refreshes first when less remains, unless its token was
   * issued within `accounts.centralRefreshMinIntervalMs`; the 15-minute ship
   * floor still applies.
   */
  minTtlMs?: number;
}

export interface AccountsServiceOptions {
  store: CoreStore;
  cfg: ResolvedNodeConfig;
  log: (op: string) => void;
  now?: () => number;
  /** `process.platform`, injected so tests can stand on another OS. */
  platform?: string;
  /** The machine's own env and home, where a native account's login lives; injected so tests never read the real home. */
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
  keychainReader?: KeychainReader;
  keychainWriter?: KeychainWriter;
  keychainStateReader?: KeychainStateReader;
  keychainRemover?: KeychainRemover;
  /** Cursor's machine-global credential store, injected so tests never touch a real login. */
  cursorAuthReader?: CursorAuthReader;
  fetchers?: LimitsFetchers;
  /** Injectable HTTP boundary for Grok, Kimi, Cursor, and OpenCode limits. */
  providerHttp?: Partial<ProviderLimitsHttp>;
  /**
   * v19 (account.lease): injectable stale-codex-token rotation — a no-op codex
   * turn against the account home (CODEX_HOME); codex rotates auth.json in
   * place at turn start when the access token is near expiry. Tests inject a
   * fake so no real codex runs. Default: the real `codex exec` runner.
   */
  museKeyMint?: import("./claudeRefreshTransport.ts").CredentialRefreshTransport;
  codexLeaseRefresh?: (homePath: string) => Promise<void>;
  /** Common native MCP reconciler; injected so activation tests stay hermetic. */
  gatewayMcpSeeder?: (homePath: string, harness: string) => Promise<GatewayMcpSeedResult>;
  /** The provider just accepted this account's credential: a rotation it issued, or a probe it answered. */
  onCredentialValidated?: (accountId: string, by: "refresh" | "limits_probe") => void;
}

type ClaudeCredential = {
  accessToken: string;
  expiresAt: number;
  subscriptionType?: string;
  refreshToken?: string;
  document: Record<string, unknown>;
  oauth: Record<string, unknown>;
};

/**
 * The outcome of a daemon-owned Claude OAuth refresh. `rejected` and
 * `temporary` split the old `refresh_failed`: a rejected refresh token cannot
 * recover automatically (request login), while a temporary transport error is
 * uncertain (keep last-known-good, retry, never a login prompt). HIVE-2.
 */
type ClaudeRefreshFlight = { takesOverFromRunningClaude: boolean; promise: Promise<ClaudeRefreshOutcome> };

type ClaudeRefreshOutcome =
  | { kind: "ok"; credential: ClaudeCredential }
  | { kind: "live_runtime" }
  | { kind: "no_refresh_token" }
  | { kind: "rejected" }
  | { kind: "temporary"; detail: string };

// ---------------------------------------------------------------------------
// selection results
// ---------------------------------------------------------------------------

export type PickOutcome =
  | { ok: true; account: AccountRow; reason: string; limitsAgeMs: number | null; stale: boolean; candidates: number }
  | { ok: false; code: "no_accounts" | "all_paused" | "no_credentials" | "auth_needed" | "no_untried"; message: string };

/**
 * Whether the credential a NEW runtime would read can authenticate on this
 * node, judged on the source activation hands the harness (the home when it
 * holds the primary credential file, else the vault copy activation installs):
 * `absent` (no primary credential file), `invalid` (a Claude primary file
 * that is not an OAuth document: empty, truncated, foreign), `expired` (a
 * Claude token past expiry with no refresh path: a leased copy whose refresh
 * token was blanked, or a central chain the daemon cannot rotate), `present`
 * (valid now or refreshable).
 */
export type CredentialState = "present" | "absent" | "invalid" | "expired";

/** Typed refusal codes shared by explicit spawn, allocator claims, swap and the runtime-start hold. */
export type AccountRefusalCode = "account_lease_revoked" | "account_paused" | "account_auth_needed" | "account_credential_missing" | "account_credential_invalid" | "account_credential_expired" | "account_unavailable";

export type AccountReadiness =
  | { ready: true }
  | { ready: false; code: AccountRefusalCode; message: string };

export interface WeeklyCeilingBreach {
  window: "weekly" | "fableWeekly";
  usedPercent: number;
  ceiling: number;
}

export function describeWeeklyCeilingBreach(accountId: string, breach: WeeklyCeilingBreach): string {
  const window = breach.window === "weekly" ? "weekly" : "Fable weekly";
  return `account ${accountId} is at ${Math.round(breach.usedPercent)}% ${window} usage, past its ${breach.ceiling}% ceiling`;
}

export interface PickOptions {
  /** Accounts already tried / the current one (rotation). */
  excludeAccountIds?: ReadonlySet<string>;
  /** Allowlist: only these account ids may win (the workstation binding a node-local pick). */
  onlyAccountIds?: ReadonlySet<string>;
  /** Effective model for the new bee (Fable-scoped allowance). */
  model?: string;
  /** Rotation: exclude accounts with exhaustion evidence younger than the cool-off. */
  excludeRecentlyExhausted?: boolean;
}

/** All activity outside the allocator-owner node for one provider account. */
export interface RemoteAccountActivityFact {
  account: string;
  active: number;
  recent: number;
  pending: number;
  ongoingUnits: number;
  /** Owner claims already represented by this remote fact. */
  observedClaimIds?: string[];
}

/**
 * Caller-supplied authoritative fleet observation. In active mode, omission,
 * staleness, a scope mismatch, or `complete:false` is uncertainty and closes
 * automatic admission. An empty `accounts` array is meaningful only when the
 * caller positively sets `complete:true`.
 */
export interface AccountAllocationContext {
  version: 1;
  authority: AccountAllocationAuthority;
  scope: string;
  revision: string;
  observedAt: number;
  complete: boolean;
  accounts: RemoteAccountActivityFact[];
}

export interface AccountAllocationAuthority {
  node: string;
  epoch: string;
}

type LocalAccountActivity = {
  active: number;
  recent: number;
  pending: number;
  ongoingUnits: number;
  observedClaimIds: Set<string>;
};

/** One node's authoritative allocation facts, sampled at one store revision. */
export interface AccountNodeActivity {
  version: 1;
  node: string;
  authority: AccountAllocationAuthority;
  scope: string;
  revision: string;
  observedAt: number;
  freshUntil: number;
  accounts: RemoteAccountActivityFact[];
}

export interface AccountAllocationReceipt {
  version: 1;
  mode: "shadow" | "active";
  scope: string;
  revision: string | null;
  observedAt: number;
  operation: AccountAdmissionOperation;
  outcome: "selected" | "wait";
  account: string | null;
  reason: string;
  retryAt: number | null;
  candidates: AccountAdmissionDecision["candidates"];
}

/** Portable, secret-free grant minted by the one allocator owner for a scope. */
export interface AccountAdmissionClaim {
  version: 1;
  id: string;
  scope: string;
  account: string;
  operation: AccountAdmissionOperation;
  units: number;
  /** Effective provider model used for model-scoped grants/windows. */
  model: string | null;
  sourceAccount: string | null;
  createdAt: number;
  expiresAt: number;
  authority: AccountAllocationAuthority;
  target: { node: string; workId: string; expectedGeneration: number };
  allocation: AccountAllocationReceipt;
}

export type NewWorkAdmission =
  | { ok: true; account: AccountRow; reason: string; receipt: AccountAllocationReceipt; reservation: AccountAdmissionReservationRow | null }
  | { ok: false; code: "account_wait" | "account_unavailable" | AccountRefusalCode; message: string; receipt: AccountAllocationReceipt };

export interface NewWorkAdmissionOptions extends PickOptions {
  operation: AccountAdmissionOperation;
  requestKey: string;
  context?: AccountAllocationContext | null;
  beeId?: string;
  /** Account that owns the fenced pre-transfer runtime generations. */
  sourceAccount?: string | null;
  reconcileAfterGeneration?: number;
  /** Owner RPC pre-mints the portable claim id and persists target metadata. */
  reservationId?: string;
  reservationMetadata?: Record<string, unknown>;
}

export interface CaptureOutcome {
  account: AccountRow;
  captured: string[];
  source: "external" | "home";
  at: number;
}

/** One location `importExistingCredentials` looked at, and what it found. */
export interface ImportCheck {
  path: string;
  state: "present" | "missing" | "invalid";
}

export type ImportOutcome =
  | { ok: true; source: "home" | "vault" | "vendor_home" | "external"; from: string; files: string[]; checked: ImportCheck[] }
  | { ok: false; checked: ImportCheck[] };

export interface VerifyOutcome {
  account: AccountRow;
  outcome: "verified" | "auth_needed" | "unverified" | "absent";
  probe: "limits" | "credential_file" | "none";
  limits: AccountLimitsRow | null;
}

/** Harnesses with either an authenticated limits read or an explicit credential-file probe. */
const PROBE_CAPABLE_HARNESSES: ReadonlySet<string> = new Set(["claude", "codex", "grok", "kimi", "cursor", "opencode", "agy", "muse"]);
/** Harnesses whose probe reads only the required credential file (no provider limits source). */
const CREDENTIAL_FILE_PROBE_HARNESSES: ReadonlySet<string> = new Set(["agy", "muse"]);

// ---------------------------------------------------------------------------
// v19: account.lease — the credential-lease mint (RN7a; a port of v1
// src/hsr/remoteCreds.ts's MINT side per credential-leases.md)
// ---------------------------------------------------------------------------

/** One credential file to write into a satellite's isolated home. */
export interface EphemeralCredentialFile {
  /** Path RELATIVE to the harness home (e.g. "auth.json", ".credentials.json"). */
  homeRelPath: string;
  /** File bytes, base64-encoded. Opaque — NEVER decode into a log/error/audit row. */
  contentB64: string;
  /** POSIX mode for the written file (0600). */
  mode: number;
}

/**
 * The short-lived, refresh-blanked material a satellite receives for ONE
 * account. `files` land in the isolated home; `env` merges into the spawn env;
 * `kindNote` is a secret-free one-liner; `expiresAt` (unix SECONDS) is the
 * NON-SECRET expiry of the shipped material when known, which the RN7b lease
 * service uses to renew before a satellite bee's token dies.
 */
export interface EphemeralCredential {
  authorityInstanceId?: string;
  generation?: number;
  files: EphemeralCredentialFile[];
  env?: Record<string, string>;
  kindNote: string;
  expiresAt?: number;
}

/**
 * Typed lease refusal (rpc.ts maps it onto the closed error list):
 *  - `lease_unsupported`: the harness/account SHAPE cannot lease (no strategy,
 *    OAuth-only kimi, no coding-plan opencode provider). Durable until the
 *    account changes.
 *  - `lease_unavailable`: leasable in principle but not RIGHT NOW (no/stale
 *    credential, refresher mid-rotation, refresh failed). Retryable.
 *  - `credential_login_required`: the provider refused the account's refresh
 *    token. Retrying cannot help; only a new login on the owning node does.
 */
export class LeaseRefusal extends Error {
  readonly code: "lease_unsupported" | "lease_unavailable" | "credential_login_required";

  constructor(code: "lease_unsupported" | "lease_unavailable" | "credential_login_required", message: string) {
    super(message);
    this.name = "LeaseRefusal";
    this.code = code;
  }
}

// Never ship a codex access token with less than this TTL remaining: below it
// the token could die on the satellite before the RN7b rotation re-delivers.
export const CODEX_MIN_SHIP_TTL_MS = 15 * 60_000;

// The same floor for claude: a lease under 15 minutes of access-token TTL is
// refreshed through the daemon's own OAuth refresher before shipping, never
// re-shipped dying.
export const CLAUDE_MIN_SHIP_TTL_MS = 15 * 60_000;

// How long a lease mint keeps deferring to a healthy running Claude: Claude
// Code only refreshes on an API call inside its own 5-minute expiry buffer,
// so an idle one never does. Below this TTL the daemon refreshes itself,
// under Claude Code's refresh lock.
export const CLAUDE_REFRESH_DEFERRAL_DEADLINE_MS = 10 * 60_000;

const CLAUDE_KEYCHAIN_PUBLISH_ATTEMPTS = 3;

export const CLAUDE_KEYCHAIN_REPAIR_RETRY_MS = 15_000;

// OAuth refresh-token field names blanked before a credential file is shipped:
// codex/grok/kimi use `refresh_token`, opencode's oauth entries use `refresh`,
// claude's .credentials.json uses `refreshToken`. Refresh tokens are
// single-use and rotating — the vault must stay their sole holder, so no two
// fleet bees ever present the same one (and a leaked lease cannot take over
// the account's refresh chain).
const REFRESH_TOKEN_KEYS: ReadonlySet<string> = new Set(["refresh_token", "refresh", "refreshToken"]);

/**
 * Deep-clone a parsed credential JSON with EVERY OAuth refresh-token field
 * blanked to "" (field kept — codex serde hard-fails when it is deleted).
 * Blanks only string values under the exact key names; access tokens, api
 * keys, and expiries are preserved untouched. Opaque — callers never log it.
 */
/** How long central publication waits for a Claude process to release the account's credential locks. */
const CENTRAL_PUBLISH_LOCK_WAIT_MS = 30_000;

async function withClaudeRefreshLockWithin<T>(configDir: string, waitMs: number, run: () => Promise<T>): ReturnType<typeof withClaudeRefreshLock<T>> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const locked = await withClaudeRefreshLock(configDir, run);
    if (locked.acquired || Date.now() >= deadline) return locked;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The account Claude Code recorded in the home's `.claude.json` for its last login. */
function claudeHomeIdentity(dir: string): ClaudeIdentity | null {
  const raw = readIfFile(join(dir, ".claude.json"));
  if (raw === null) return null;
  try {
    const account = (JSON.parse(raw) as { oauthAccount?: { accountUuid?: unknown; organizationUuid?: unknown } }).oauthAccount;
    if (typeof account?.accountUuid !== "string" || account.accountUuid.length === 0) return null;
    return { accountUuid: account.accountUuid, organizationUuid: typeof account.organizationUuid === "string" && account.organizationUuid.length > 0 ? account.organizationUuid : null };
  } catch {
    return null;
  }
}


function keychainDocument(state: KeychainState | null): Record<string, unknown> {
  if (state?.status !== "present") return {};
  try {
    const parsed: unknown = JSON.parse(state.raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function blankRefreshTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => blankRefreshTokens(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REFRESH_TOKEN_KEYS.has(key) && typeof inner === "string" ? "" : blankRefreshTokens(inner);
    }
    return out;
  }
  return value;
}

/** JWT `exp` claim (unix SECONDS), decoded not verified (a local freshness fact). */
function expFromJwt(token: string): number | undefined {
  const segment = token.split(".")[1];
  if (!segment) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof claims.exp === "number" && Number.isFinite(claims.exp) ? claims.exp : undefined;
  } catch {
    return undefined;
  }
}

/** The opencode coding-plan providers a lease may carry (the same closed list the limits probe reads). */
const OPENCODE_LEASE_PROVIDERS = ["minimax-coding-plan", "zai-coding-plan"] as const;

/**
 * Default stale-codex rotation: a minimal read-only `codex exec` turn against
 * the home, serialized under the SAME per-home boot lock runner-host and the
 * limits probe take, so the rotation never races a booting codex in this home.
 */
function defaultCodexLeaseRefresh(command: string): (homePath: string) => Promise<void> {
  return async (homePath) => {
    try {
      await withFileLock(
        join(homePath, CODEX_BOOT_LOCK_FILENAME),
        async () => {
          // codex refreshes auth.json in place at turn start when the token is
          // near expiry; the output is discarded. cwd is a throwaway temp dir.
          await execFileP(command, ["exec", "--skip-git-repo-check", "-s", "read-only", "ok"], {
            cwd: tmpdir(),
            env: { ...process.env, CODEX_HOME: homePath },
            timeout: 120_000,
            maxBuffer: 1 << 20,
          });
        },
        { timeoutMs: 10_000, staleMs: CODEX_BOOT_LOCK_STALE_MS, pollMs: 25 },
      );
    } catch {
      // Secret-free: never surface codex stderr (could echo token-adjacent bytes).
      throw new LeaseRefusal("lease_unavailable", "could not run codex to rotate the stale access token (is codex installed and this account logged in?)");
    }
  };
}

// ---------------------------------------------------------------------------
// default transports
// ---------------------------------------------------------------------------

async function claudeOauthGet(accessToken: string, url: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    // Keep the provider's own diagnosis: "HTTP 401" alone cannot distinguish
    // an expired token from a REVOKED chain, and the auth-health mapping keys
    // on that distinction.
    const body = await response.text().catch(() => "");
    const detail = body.replace(/\s+/g, " ").trim().slice(0, 200);
    throw new Error(`${new URL(url).pathname}: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`);
  }
  return response.json();
}

function defaultClaudeUsage(timeoutMs: number): NonNullable<LimitsFetchers["claudeUsage"]> {
  const usageUrl = process.env.HIVE_CLAUDE_USAGE_URL || "https://api.anthropic.com/api/oauth/usage";
  return (accessToken) => claudeOauthGet(accessToken, usageUrl, timeoutMs) as Promise<ClaudeUsageResponse>;
}

const execFileP = promisify(execFile);

const CODEX_BOOT_LOCK_FILENAME = ".hive-app-server-boot.lock";
const CODEX_BOOT_LOCK_STALE_MS = 2 * 60_000;
const CODEX_LIMITS_BOOT_LOCK_MAX_MS = 3_000;

function errorDetail(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const message = (error as { message?: unknown }).message;
    const code = (error as { code?: unknown }).code;
    if (typeof message === "string") return typeof code === "number" || typeof code === "string" ? `${code}: ${message}` : message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function codexFailure(error: unknown, fallback: AccountLimitsUnreadableReason = "provider_error"): CodexRateLimitsFetchResult {
  const detail = errorDetail(error).replace(/\s+/g, " ").trim().slice(0, 500) || "unknown Codex limits probe failure";
  return {
    ok: false,
    unreadableReason: isAuthFailureLimitsError(detail)
      ? "auth_failed"
      : /timed out|timeout/i.test(detail)
        ? "timeout"
        : fallback,
    error: detail,
  };
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseResetCredits(value: unknown): RateLimitResetCredits | null {
  if (value === null || value === undefined) return null;
  const object = recordOf(value);
  if (!object || typeof object.availableCount !== "number" || !Number.isInteger(object.availableCount) || object.availableCount < 0) {
    throw new Error("codex app-server returned invalid rateLimitResetCredits");
  }
  if (object.credits !== null && !Array.isArray(object.credits)) throw new Error("codex app-server returned invalid reset credit details");
  const credits = object.credits === null ? null : object.credits.map((raw) => {
    const credit = recordOf(raw);
    if (!credit || typeof credit.id !== "string" || credit.id.length === 0 || typeof credit.resetType !== "string" || typeof credit.status !== "string"
      || typeof credit.grantedAt !== "number" || !Number.isFinite(credit.grantedAt)
      || (credit.expiresAt !== null && (typeof credit.expiresAt !== "number" || !Number.isFinite(credit.expiresAt)))
      || (credit.title !== null && typeof credit.title !== "string") || (credit.description !== null && typeof credit.description !== "string")) {
      throw new Error("codex app-server returned invalid reset credit detail");
    }
    return {
      id: credit.id,
      resetType: credit.resetType,
      status: credit.status,
      grantedAt: credit.grantedAt,
      expiresAt: credit.expiresAt,
      title: credit.title,
      description: credit.description,
    };
  });
  return { availableCount: object.availableCount, credits };
}

function parseCodexLimitsResult(result: unknown): CodexLiveRateLimits {
  const outer = recordOf(result);
  const limits = recordOf(outer?.rateLimits);
  if (!limits || (!limits.primary && !limits.secondary)) throw new Error("codex app-server returned no rate-limit windows");
  return { ...limits, rateLimitResetCredits: parseResetCredits(outer?.rateLimitResetCredits) } as CodexLiveRateLimits;
}

/**
 * Query `codex app-server` (JSON-RPC over stdio) for the account's live rate
 * limits, with CODEX_HOME pointed at the account's home. The same per-home
 * boot lock used by runner-host serializes this short-lived app-server with
 * real Codex runtimes. Every failure remains typed and the total operation is
 * bounded by `timeoutMs`.
 */
export function defaultCodexRateLimits(timeoutMs: number, command = "codex"): NonNullable<LimitsFetchers["codexRateLimits"]> {
  return async (homePath) => {
    const lockTimeoutMs = Math.min(CODEX_LIMITS_BOOT_LOCK_MAX_MS, Math.max(1, Math.floor(timeoutMs / 5)));
    const settleMarginMs = Math.min(250, Math.max(1, Math.floor(timeoutMs / 20)));
    const rpcTimeoutMs = Math.max(1, timeoutMs - lockTimeoutMs - settleMarginMs);
    return withFileLock(join(homePath, CODEX_BOOT_LOCK_FILENAME), () =>
      new Promise<CodexRateLimitsFetchResult>((resolvePromise) => {
        let child: ReturnType<typeof spawnChild>;
        try {
          child = spawnChild(command, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CODEX_HOME: homePath } });
        } catch (error) {
          resolvePromise(codexFailure(error));
          return;
        }
        let settled = false;
        let stderr = "";
        const finish = (value: CodexRateLimitsFetchResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.kill();
          resolvePromise(value);
        };
        const timer = setTimeout(
          () => finish(codexFailure(`codex app-server limits probe timed out after ${rpcTimeoutMs}ms`, "timeout")),
          rpcTimeoutMs,
        );
        timer.unref();
        child.on("error", (error) => finish(codexFailure(error)));
        child.on("exit", (code, signal) => finish(codexFailure(
          stderr || `codex app-server exited before answering account/rateLimits/read (code=${code ?? "-"}, signal=${signal ?? "-"})`,
        )));
        child.stderr?.on("data", (chunk: Buffer) => {
          if (stderr.length < 500) stderr += chunk.toString().slice(0, 500 - stderr.length);
        });
        let buffer = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (!line.trim()) continue;
            let message: { id?: number; result?: Record<string, unknown>; error?: unknown };
            try {
              message = JSON.parse(line) as typeof message;
            } catch {
              continue;
            }
            if (message.id === 1) {
              if (message.error) {
                finish(codexFailure(message.error));
                return;
              }
              child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} })}\n`);
            }
            if (message.id === 2) {
              if (message.error) {
                finish(codexFailure(message.error));
                return;
              }
              try {
                finish({ ok: true, limits: parseCodexLimitsResult(message.result) });
              } catch (error) {
                finish(codexFailure(error));
              }
              return;
            }
          }
        });
        child.stdin?.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "hive", title: "hive", version: "0.0.1" } } })}\n`,
        );
      }),
    {
      timeoutMs: lockTimeoutMs,
      staleMs: CODEX_BOOT_LOCK_STALE_MS,
      pollMs: 25,
    }).catch((error) => codexFailure(error));
  };
}

/** Consume one earned reset and refresh limits in the same bounded app-server session. */
export function defaultCodexResetLimits(timeoutMs: number, command = "codex"): NonNullable<LimitsFetchers["codexResetLimits"]> {
  return async (homePath, idempotencyKey, creditId) => {
    const lockTimeoutMs = Math.min(CODEX_LIMITS_BOOT_LOCK_MAX_MS, Math.max(1, Math.floor(timeoutMs / 5)));
    const rpcTimeoutMs = Math.max(1, timeoutMs - lockTimeoutMs - Math.min(250, Math.max(1, Math.floor(timeoutMs / 20))));
    return withFileLock(join(homePath, CODEX_BOOT_LOCK_FILENAME), () => new Promise<CodexResetLimitsFetchResult>((resolvePromise) => {
      let child: ReturnType<typeof spawnChild>;
      try {
        child = spawnChild(command, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CODEX_HOME: homePath } });
      } catch (error) {
        resolvePromise({ ok: false, code: "provider_refused", error: errorDetail(error) });
        return;
      }
      let settled = false;
      let outcome: CodexResetOutcome | null = null;
      let consumeSent = false;
      const finish = (value: CodexResetLimitsFetchResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        resolvePromise(value);
      };
      const fail = (error: unknown, code: "provider_outcome_uncertain" | "provider_unsupported" | "provider_refused" = consumeSent ? "provider_outcome_uncertain" : "provider_refused") =>
        finish({ ok: false, code, error: errorDetail(error).slice(0, 500) });
      const timer = setTimeout(() => fail(`codex app-server reset timed out after ${rpcTimeoutMs}ms`), rpcTimeoutMs);
      timer.unref();
      child.on("error", fail);
      child.on("exit", (code, signal) => fail(`codex app-server exited before reset completed (code=${code ?? "-"}, signal=${signal ?? "-"})`));
      child.stdin?.on("error", fail);
      child.stderr?.on("data", () => undefined);
      let buffer = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          let message: Record<string, unknown> | null;
          try { message = recordOf(JSON.parse(line)); } catch { continue; }
          if (!message) { fail("codex app-server returned a non-object JSON-RPC frame"); return; }
          if (message.error) {
            const rpcError = recordOf(message.error);
            if (message.id === 2 && rpcError?.code === -32601) {
              fail("installed Codex does not support earned rate-limit resets; update Codex and retry", "provider_unsupported");
            } else if (message.id === 1) {
              fail(message.error, "provider_refused");
            } else if (message.id === 2 && (
              rpcError?.code === -32602
              || rpcError?.code === 401
              || rpcError?.code === 403
            )) {
              fail(message.error, "provider_refused");
            } else {
              fail(message.error, "provider_outcome_uncertain");
            }
            return;
          }
          if (message.id === 1) {
            child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
            consumeSent = true;
            child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "account/rateLimitResetCredit/consume", params: { idempotencyKey, ...(creditId ? { creditId } : {}) } })}\n`);
          } else if (message.id === 2) {
            const raw = recordOf(message.result)?.outcome;
            if (typeof raw !== "string" || !(CODEX_RESET_OUTCOMES as readonly string[]).includes(raw)) { fail("codex app-server returned unknown reset outcome"); return; }
            outcome = raw as CodexResetOutcome;
            child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "account/rateLimits/read", params: {} })}\n`);
          } else if (message.id === 3) {
            if (!outcome) { fail("codex app-server returned limits before reset outcome"); return; }
            try { finish({ ok: true, outcome, limits: parseCodexLimitsResult(message.result) }); } catch (error) { fail(error); }
          }
        }
      });
      child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "hive", title: "hive", version: "0.0.1" } } })}\n`);
    }), { timeoutMs: lockTimeoutMs, staleMs: CODEX_BOOT_LOCK_STALE_MS, pollMs: 25 })
      .catch((error) => ({ ok: false, code: "provider_refused" as const, error: errorDetail(error).slice(0, 500) }));
  };
}

// ---------------------------------------------------------------------------
// the service
// ---------------------------------------------------------------------------

export class AccountsService {
  readonly centralCredentials: ClaudeCredentialAuthority;
  readonly codexCredentials: CodexCredentialAuthority;
  readonly grokCredentials: GrokCredentialAuthority;
  readonly museCredentials: MuseCredentialAuthority;
  private readonly credentialAuthorities = new Map<string, CredentialAuthority>();

  authorityFor(account: Pick<AccountRow, "harness">): CredentialAuthority | null {
    return this.credentialAuthorities.get(account.harness) ?? null;
  }
  authDeathMaterial(account: AccountRow): import("../../core/src/types.ts").AccountMaterialStamp | null {
    const authority = this.authorityFor(account);
    if (!authority?.supportsAuthDeathRecovery() || this.isNative(account) || account.status === "paused" || this.store.activeCredentialHandoff(account.id)) return null;
    if (account.source === "leased") {
      const origin = account.leasedFrom;
      if (!origin || origin.generation === undefined || origin.materialPublished !== true || origin.revokedAt !== null || origin.expiresAt !== null && origin.expiresAt * 1000 <= this.now() || this.homeCredentialState(account) !== "usable") return null;
      return { ...(origin.authorityInstanceId !== undefined ? { authorityInstanceId: origin.authorityInstanceId } : {}), ...(origin.legacyAuthorityInstanceId ? { legacyAuthorityInstanceId: origin.legacyAuthorityInstanceId, legacyAuthorityGenerationFloor: origin.legacyAuthorityGenerationFloor } : {}), kind: "lease", scope: `${origin.authorityNodeId}:${origin.shareId}`, epoch: origin.epoch, generation: origin.generation };
    }
    const state = authority.status(account);
    if (state?.phase !== "ready" || this.homeCredentialState(account) !== "usable") return null;
    try {
      const primary = recipeFor(account.harness)?.credentialFiles[0];
      const raw = primary ? readIfFile(join(account.homePath, primary)) : null;
      if (raw === null || !authority.publishedMaterialMatches(account, JSON.parse(raw))) return null;
    } catch { return null; }
    return { ...(state.authorityInstanceId !== undefined ? { authorityInstanceId: state.authorityInstanceId } : {}), kind: "central", scope: account.id, epoch: this.store.credentialAuthorityEpoch(account.id), generation: state.generation };
  }

  private readonly store: CoreStore;
  private readonly cfg: ResolvedNodeConfig;
  private readonly log: (op: string) => void;
  private readonly now: () => number;
  readonly platform: string;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly home: string;
  private readonly keychainReader: KeychainReader;
  private readonly keychainWriter: KeychainWriter;
  readonly leaseMaterialCodecs: ReadonlyMap<string, LeaseMaterialCodec>;
  private readonly leaseWrites = new Map<string, Promise<unknown>>();
  private readonly leaseResolutions = new Map<string, Promise<unknown>>();
  private readonly keychainStateReader: KeychainStateReader;
  private readonly cursorAuthReader: CursorAuthReader;
  private readonly fetchers: Required<LimitsFetchers>;
  private readonly providerHttp: ProviderLimitsHttp;
  private lastPeriodicRefreshAt = 0;
  private refreshing: Promise<void> | null = null;
  private readonly queuedRefreshIds = new Set<string>();
  private readonly activeRefreshIds = new Set<string>();
  /** All callers for one Codex home join one bounded app-server probe. */
  private readonly codexFetches = new Map<string, Promise<PutAccountLimitsInput>>();
  /** Refresh tokens rotate on use: at most one refresh may run per account. */
  private readonly claudeRefreshes = new Map<string, ClaudeRefreshFlight>();
  private readonly claudeKeychainRepairs = new Map<string, number>();
  /** Earliest next tick-driven probe per account with a central refresh retry due. */
  private readonly centralRetryProbes = new Map<string, number>();
  /** After an early refresh that failed before or after the provider (Keychain, publication, foreign copy): earliest next try and consecutive failures. */
  private readonly earlyRefreshBackoff = new Map<string, { at: number; failures: number }>();
  private claudeKeychainRepairFlight: Promise<void> | null = null;
  /** Grok/Kimi refresh tokens also rotate; share the whole provider read. */
  private readonly secondaryProviderFetches = new Map<string, Promise<PutAccountLimitsInput>>();
  /** Active-admission freshness probes join per account, including Claude. */
  private readonly admissionRefreshes = new Map<string, Promise<void>>();
  /**
   * Auto picks not yet visible as runtimes (HIVE-80 reservation): each pick
   * debits its account for AUTO_PICK_DEBIT_TTL_MS so back-to-back spawns
   * spread instead of stacking on one snapshot. In-memory: a daemon restart
   * loses at most 15 minutes of reservations.
   */
  readonly credentialHandoff: CredentialHandoffService;
  private readonly pendingPicks = new Map<string, PendingPick[]>();
  /**
   * Measured burn per window (points/hour) from consecutive readable
   * snapshots of the same window; null = the window rolled over between
   * reads (fresh, no velocity yet). Feeds the selector's aging + projection.
   */
  private readonly velocities = new Map<string, WindowVelocities>();
  /** v19: at most one lease mint per account; concurrent callers join it. */
  private readonly leaseMints = new Map<string, Promise<EphemeralCredential>>();
  private readonly nativeKeychainSeeds = new Map<string, Set<Promise<unknown>>>();
  private readonly codexLeaseRefresh: (homePath: string) => Promise<void>;
  private readonly gatewayMcpSeeder: (homePath: string, harness: string) => Promise<GatewayMcpSeedResult>;
  private readonly onCredentialValidated: (accountId: string, by: "refresh" | "limits_probe") => void;

  constructor(opts: AccountsServiceOptions) {
    this.store = opts.store;
    this.cfg = opts.cfg;
    this.log = opts.log;
    this.onCredentialValidated = opts.onCredentialValidated ?? (() => undefined);
    this.now = opts.now ?? Date.now;
    this.platform = opts.platform ?? process.platform;
    this.env = opts.env ?? process.env;
    this.home = opts.home ?? homedir();
    this.keychainReader = opts.keychainReader ?? readClaudeKeychain;
    this.keychainWriter = opts.keychainWriter ?? writeClaudeKeychainEntry;
    this.cursorAuthReader = opts.cursorAuthReader ?? readCursorLiveAuth;
    this.fetchers = {
      claudeUsage: opts.fetchers?.claudeUsage ?? defaultClaudeUsage(this.cfg.accounts.limitsFetchTimeoutMs),
      claudeRefresh: opts.fetchers?.claudeRefresh ?? defaultClaudeRefreshTransport(this.cfg.accounts.limitsFetchTimeoutMs),
      codexRateLimits: opts.fetchers?.codexRateLimits ?? defaultCodexRateLimits(this.cfg.accounts.limitsFetchTimeoutMs, this.cfg.agents.codex?.command ?? "codex"),
      codexResetLimits: opts.fetchers?.codexResetLimits ?? defaultCodexResetLimits(this.cfg.accounts.limitsFetchTimeoutMs, this.cfg.agents.codex?.command ?? "codex"),
      claudeIdentity: opts.fetchers?.claudeIdentity ?? ((accessToken) => fetchClaudeIdentity(accessToken, this.cfg.accounts.limitsFetchTimeoutMs)),
    };
    const centralKeychainReader: KeychainStateReader = opts.keychainStateReader ?? (opts.keychainReader
      ? async home => { const raw = await opts.keychainReader!(home); return raw === null ? { status: "unavailable" } : { status: "present", raw }; }
      : readClaudeKeychainState);
    this.keychainStateReader = centralKeychainReader;
    const checkCentralCopy = (account: AccountRow, document: Record<string, unknown>, raw: string): void => {
      const owned = parseClaudeCredentials(JSON.stringify(document))!;
      const credential = parseClaudeCredentials(raw);
      if (!credential?.refreshToken || credential.refreshToken === owned.refreshToken) return;
      // While enrolling, native copies still hold the adopted chain (or older ones) until publication replaces them.
      // An enrollment whose first rotation had an unknown outcome keeps that allowance through its retries.
      const phase = this.centralCredentials.status(account)?.phase;
      const adopted = phase === "enrolling" ? this.centralCredentials.adopted(account)
        : phase === "disabling" || phase === "disabling_uncertain" || phase === "refreshing" || phase === "uncertain" || phase === "login_required" ? this.centralCredentials.rollbackAdopted(account) : null;
      if (adopted && (refreshTokenDigest(credential.refreshToken) === adopted.refreshTokenDigest || credential.expiresAt < adopted.expiresAt)) return;
      throw new CredentialOwnershipConflict("An external Claude login or refresh changed this account; stop that process and recover the account before continuing.");
    };
    const inspectCentralFiles = (account: AccountRow, document: Record<string, unknown>): void => {
      for (const path of [join(account.homePath, ".credentials.json"), join(this.vaultDirOf(account), ".credentials.json")]) {
        if (existsSync(path)) checkCentralCopy(account, document, readFileSync(path, "utf8"));
      }
    };
    const inspectCentralCopies = async (account: AccountRow, document: Record<string, unknown>) => {
      const state = await centralKeychainReader(account.homePath);
      if (state.status === "unreadable") throw new CredentialAuthorityError("Account Keychain is unreadable; unlock it before changing credential ownership.");
      if (state.status === "present") checkCentralCopy(account, document, state.raw);
      inspectCentralFiles(account, document);
      return state;
    };
    this.leaseMaterialCodecs = createLeaseMaterialCodecs({
      assertHome: home => { if (claudeKeychainService(home) === "Claude Code-credentials" || existsSync(home) && existsSync(resolve(homedir(), ".claude")) && realpathSync(home) === realpathSync(resolve(homedir(), ".claude"))) throw new RpcError("account_lease_conflict", "Native backup and lease operations require a per-home Keychain item; the default/global item is excluded."); },
      read: centralKeychainReader,
      publish: (account, raw, state) => this.publishClaudeMaterial(account, JSON.parse(raw) as Record<string, unknown>, state),
      remove: opts.keychainRemover ?? removeClaudeKeychainEntry,
      matchesMaterial: (stored, installed) => {
        const actual = parseClaudeCredentials(stored);
        const expected = parseClaudeCredentials(installed);
        return actual !== null && expected !== null && !hasRefreshToken(actual) && actual.accessToken === expected.accessToken;
      },
      withLock: async (home, run) => {
        const locked = await withClaudeRefreshLockWithin(home, CENTRAL_PUBLISH_LOCK_WAIT_MS, run);
        if (!locked.acquired) throw new RpcError("lease_unavailable", "A harness process holds the account credential lock; retry the lease operation.");
        return locked.value;
      },
    });
    this.centralCredentials = new ClaudeCredentialAuthority({
      store: this.store, root: join(this.cfg.accounts.vaultDir, ".credential-authorities"), now: this.now,
      log: this.log, retryBaseMs: this.cfg.accounts.centralRefreshRetryBaseMs, earlyRefreshMinIntervalMs: this.cfg.accounts.centralRefreshMinIntervalMs,
      beforeEnroll: account => {
        this.assertLocalAccount(account);
        this.assertOwnedHome(account, "publishes credentials into");
        this.store.assertNoUpdateReservation();
        if (this.refreshBusy(account) || this.leaseMints.has(account.id) || this.nativeKeychainSeeds.has(account.id)) throw new CredentialAuthorityError("A native credential refresh is in progress; retry enrollment shortly.");
      },
      nativeCredential: async account => (await this.freshestClaudeCredential(account))?.document ?? null,
      beforeUse: inspectCentralFiles,
      beforeRefresh: inspectCentralCopies,
      refresh: token => this.fetchers.claudeRefresh(token),
      onRefreshed: account => this.onCredentialValidated(account.id, "refresh"),
      identify: accessToken => this.fetchers.claudeIdentity(accessToken),
      homeIdentity: account => claudeHomeIdentity(account.homePath) ?? claudeHomeIdentity(this.vaultDirOf(account)),
      // Native rotation's protocol: under Claude Code's credential locks, the vault and the Keychain item
      // (merged into, never replaced) before the home file whose mtime tells a running Claude to re-read.
      publish: async (account, document, accessOnly) => {
        this.assertOwnedHome(account, "publishes credentials into");
        const locked = await withClaudeRefreshLockWithin(account.homePath, CENTRAL_PUBLISH_LOCK_WAIT_MS, async () => {
          const state = await inspectCentralCopies(account, document);
          const published = (accessOnly ? blankRefreshTokens(document) : document) as Record<string, unknown>;
          await this.publishClaudeMaterial(account, published, state);
        });
        if (!locked.acquired) {
          throw new CredentialAuthorityError("A Claude process held the account's credential lock throughout publication; it is retried.", "operation_in_progress");
        }
      },
    });
    const inspectCodexCopies = (account: AccountRow, document: Record<string, unknown>): void => {
      const owned = CODEX_CREDENTIAL_CODEC.parse(JSON.stringify(document))!;
      const phase = this.codexCredentials.status(account)?.phase;
      const adopted = phase === "enrolling" ? this.codexCredentials.adopted(account)
        : this.codexCredentials.rollbackAdopted(account);
      for (const path of [join(account.homePath, "auth.json"), join(account.homePath, ".codex", "auth.json"), join(this.vaultDirOf(account), "auth.json")]) {
        const credential = readCodexCredentialCopy(() => readIfFile(path), account.id);
        if (!credential?.refreshToken || credential.refreshToken === owned.refreshToken) continue;
        if (adopted && (refreshTokenDigest(credential.refreshToken) === adopted.refreshTokenDigest || credential.expiresAt < adopted.expiresAt)) continue;
        throw new CredentialOwnershipConflict("An external Codex login or refresh changed this account; stop that process and recover the account before continuing.");
      }
    };
    this.codexCredentials = new CodexCredentialAuthority({
      store: this.store, root: join(this.cfg.accounts.vaultDir, ".credential-authorities"), now: this.now,
      log: this.log, retryBaseMs: this.cfg.accounts.centralRefreshRetryBaseMs, earlyRefreshMinIntervalMs: this.cfg.accounts.centralRefreshMinIntervalMs,
      beforeEnroll: account => {
        this.assertLocalAccount(account);
        this.assertOwnedHome(account, "publishes credentials into");
        this.store.assertNoUpdateReservation();
        if (this.refreshBusy(account) || this.leaseMints.has(account.id)) throw new CredentialAuthorityError("A native credential refresh is in progress; retry enrollment shortly.");
      },
      nativeCredential: async account => this.freshestCodexAuth(account, true)?.parsed ?? null,
      beforeUse: inspectCodexCopies,
      beforeRefresh: async (account, document) => inspectCodexCopies(account, document),
      refresh: defaultCodexRefreshTransport(this.cfg.accounts.limitsFetchTimeoutMs, this.now),
      onRefreshed: account => this.onCredentialValidated(account.id, "refresh"),
      identify: async () => null,
      homeIdentity: () => null,
      publish: async (account, document, accessOnly) => {
        this.assertOwnedHome(account, "publishes credentials into");
        inspectCodexCopies(account, document);
        const published = (accessOnly ? blankRefreshTokens(document) : document) as Record<string, unknown>;
        const raw = JSON.stringify({ ...published, OPENAI_API_KEY: null });
        mkdirSync(account.homePath, { recursive: true, mode: 0o700 });
        mkdirSync(this.vaultDirOf(account), { recursive: true, mode: 0o700 });
        atomicWriteFileSync(join(this.vaultDirOf(account), "auth.json"), raw, 0o600);
        atomicWriteFileSync(join(account.homePath, "auth.json"), raw, 0o600);
        mkdirSync(join(account.homePath, ".codex"), { recursive: true, mode: 0o700 });
        const mirrorRaw = JSON.stringify({ ...(blankRefreshTokens(document) as Record<string, unknown>), OPENAI_API_KEY: null });
        atomicWriteFileSync(join(account.homePath, ".codex", "auth.json"), mirrorRaw, 0o600);
        for (const path of [account.homePath, this.vaultDirOf(account), join(account.homePath, ".codex")]) chmodSync(path, 0o700);
      },
    });
    const inspectGrokCopies = (account: AccountRow, document: Record<string, unknown>): void => {
      const owned = GROK_CREDENTIAL_CODEC.parse(JSON.stringify(document))!;
      const phase = this.grokCredentials.status(account)?.phase;
      const adopted = phase === "enrolling" ? this.grokCredentials.adopted(account)
        : this.grokCredentials.rollbackAdopted(account);
      for (const path of [join(account.homePath, "auth.json"), join(this.vaultDirOf(account), "auth.json")]) {
        const raw = readIfFile(path);
        const credential = raw === null ? null : GROK_CREDENTIAL_CODEC.parse(raw);
        if (raw !== null && (!credential || grokCredentialEntry(JSON.parse(raw))?.scope !== grokCredentialEntry(document)?.scope)) {
          throw new CredentialOwnershipConflict("A Grok credential copy is corrupt, has multiple entries, or has a conflicting OIDC scope; recover that copy before changing credential ownership.");
        }
        if (raw !== null) {
          const copy = grokCredentialEntry(JSON.parse(raw))!;
          const owner = grokCredentialEntry(document)!;
          if (["user_id", "principal_type", "principal_id", "team_id"].some(field => copy.entry[field] !== owner.entry[field])) {
            throw new CredentialOwnershipConflict("An external Grok login changed this account or principal; recover before continuing.");
          }
        }
        if (!credential?.refreshToken || credential.refreshToken === owned.refreshToken) continue;
        if (adopted && (refreshTokenDigest(credential.refreshToken) === adopted.refreshTokenDigest || credential.expiresAt < adopted.expiresAt)) continue;
        throw new CredentialOwnershipConflict("An external Grok login or refresh changed this account; stop that process and recover the account before continuing.");
      }
    };
    this.grokCredentials = new GrokCredentialAuthority({
      store: this.store, root: join(this.cfg.accounts.vaultDir, ".credential-authorities"), now: this.now,
      log: this.log, retryBaseMs: this.cfg.accounts.centralRefreshRetryBaseMs, earlyRefreshMinIntervalMs: this.cfg.accounts.centralRefreshMinIntervalMs,
      beforeEnroll: account => {
        this.assertLocalAccount(account);
        this.assertOwnedHome(account, "publishes credentials into");
        this.store.assertNoUpdateReservation();
        if (this.refreshBusy(account) || this.leaseMints.has(account.id)) throw new CredentialAuthorityError("A native credential refresh is in progress; retry enrollment shortly.");
      },
      nativeCredential: async account => this.freshestGrokAuth(account),
      beforeUse: inspectGrokCopies,
      beforeRefresh: async (account, document) => inspectGrokCopies(account, document),
      refresh: defaultGrokRefreshTransport(this.cfg.accounts.limitsFetchTimeoutMs, this.now),
      onRefreshed: account => this.onCredentialValidated(account.id, "refresh"),
      identify: async () => null,
      homeIdentity: () => null,
      publish: async (account, document, accessOnly) => {
        this.assertOwnedHome(account, "publishes credentials into");
        inspectGrokCopies(account, document);
        const published = accessOnly ? grokAccessOnly(document) : document;
        const raw = JSON.stringify(published);
        mkdirSync(account.homePath, { recursive: true, mode: 0o700 });
        mkdirSync(this.vaultDirOf(account), { recursive: true, mode: 0o700 });
        atomicWriteFileSync(join(this.vaultDirOf(account), "auth.json"), raw, 0o600);
        atomicWriteFileSync(join(account.homePath, "auth.json"), raw, 0o600);
      },
    });
    const inspectMuseCopies = (account: AccountRow, document: Record<string, unknown>): void => {
      const owned = museMeta(document);
      const snapshot = this.museCredentials?.rollbackSnapshot(account);
      const previous = this.museCredentials?.previousDocument(account);
      const previousKey = previous ? museMeta(previous)?.api_key : undefined;
      for (const root of this.isolationRefusal("muse") ? [this.vaultDirOf(account)] : [account.homePath, this.vaultDirOf(account)]) {
        for (const copy of this.leaseCopyPaths(root, "muse/auth.json")) {
          const raw = readIfFile(this.leaseFilePath(root, copy));
          if (raw === null) continue;
          if (snapshot?.[root === account.homePath ? "home" : "vault"] === raw) continue;
          let meta: Record<string, unknown> | null;
          try { meta = museMeta(JSON.parse(raw)); } catch { meta = null; }
          if (!meta || !MUSE_CREDENTIAL_CODEC.parse(raw) || meta.storage === "keychain" || meta.access_token
            || JSON.stringify(JSON.parse(raw)) !== JSON.stringify(museWorkingDocument(JSON.parse(raw)))
            || (meta.api_key && meta.api_key !== owned?.api_key && meta.api_key !== owned?.previous_api_key && meta.api_key !== previousKey)) {
            throw new CredentialOwnershipConflict("An external Muse login or key changed this account; preserve it before publishing authority material.");
          }
        }
      }
    };
    this.museCredentials = new MuseCredentialAuthority({
      store: this.store, root: join(this.cfg.accounts.vaultDir, ".credential-authorities"), now: this.now,
      log: this.log, retryBaseMs: this.cfg.accounts.centralRefreshRetryBaseMs, earlyRefreshMinIntervalMs: this.cfg.accounts.centralRefreshMinIntervalMs,
      beforeEnroll: account => {
        this.assertLocalAccount(account);
        const native = this.nativeRefusal(account);
        if (native) throw new CredentialAuthorityError(native);
        this.assertOwnedHome(account, "holds credentials for");
        this.store.assertNoUpdateReservation();
        if (this.refreshBusy(account) || this.leaseMints.has(account.id)) throw new CredentialAuthorityError("Another credential operation is active.");
      },
      beforeRelogin: account => {
        this.assertLocalAccount(account);
        const refusal = this.nativeRefusal(account);
        if (refusal) throw new CredentialAuthorityError(refusal);
        this.assertOwnedHome(account, "holds credentials for");
      },
      nativeSnapshot: (account, raw) => Object.fromEntries((this.isolationRefusal("muse") ? [["vault", this.vaultDirOf(account)]] : [["home", account.homePath], ["vault", this.vaultDirOf(account)]]).map(([key, root]) => [key!, raw ?? readIfFile(this.leaseFilePath(root!, "muse/auth.json"))])),
      nativeCredential: async account => {
        for (const root of this.isolationRefusal("muse") ? [this.vaultDirOf(account)] : [account.homePath, this.vaultDirOf(account)]) {
          const raw = readIfFile(this.leaseFilePath(root, "muse/auth.json"));
          if (raw !== null) return JSON.parse(raw) as Record<string, unknown>;
        }
        return null;
      },
      beforeUse: inspectMuseCopies,
      beforeRefresh: async (account, document) => inspectMuseCopies(account, document),
      refresh: opts.museKeyMint ?? defaultMuseKeyTransport(this.cfg.accounts.limitsFetchTimeoutMs, this.now),
      onRefreshed: account => this.onCredentialValidated(account.id, "refresh"),
      identify: async () => null, homeIdentity: () => null,
      publish: async (account, document, accessOnly, snapshot) => {
        const native = this.nativeRefusal(account);
        if (native) throw new CredentialAuthorityError(native);
        this.assertOwnedHome(account, "holds credentials for");
        inspectMuseCopies(account, document);
        const published = accessOnly ? JSON.stringify(museWorkingDocument(document)) : null;
        for (const root of this.isolationRefusal("muse") ? [this.vaultDirOf(account)] : [this.vaultDirOf(account), account.homePath]) {
          mkdirSync(join(root, "muse"), { recursive: true, mode: 0o700 });
          const path = this.leaseFilePath(root, "muse/auth.json");
          const raw = accessOnly ? published : snapshot?.[root === account.homePath ? "home" : "vault"];
          if (raw === undefined) throw new CredentialAuthorityError("Native Muse snapshot is unavailable; sign in again after disabling.");
          if (raw === null) rmSync(path, { force: true });
          else atomicWriteFileSync(path, raw, 0o600);
        }
      },
    });
    this.credentialAuthorities.set("muse", this.museCredentials);
    this.credentialAuthorities.set("claude", this.centralCredentials);
    this.credentialAuthorities.set("codex", this.codexCredentials);
    this.credentialHandoff = new CredentialHandoffService(this.store, this, join(this.cfg.accounts.vaultDir, ".credential-authorities"), this.now, this.log);
    this.credentialAuthorities.set("grok", this.grokCredentials);
    this.providerHttp = {
      ...defaultProviderLimitsHttp(this.cfg.accounts.limitsFetchTimeoutMs),
      ...opts.providerHttp,
    };
    this.codexLeaseRefresh = opts.codexLeaseRefresh ?? defaultCodexLeaseRefresh(this.cfg.agents.codex?.command ?? "codex");
    this.gatewayMcpSeeder = opts.gatewayMcpSeeder
      ?? ((homePath, harness) => seedGatewayMcp(homePath, harness, { gateways: liveGateways(), disabled: process.env.HIVE_GATEWAYS_DISABLE === "1", failOnError: true }));
  }

  // -------------------------------------------------------------------------
  // paths + predicates
  // -------------------------------------------------------------------------

  assertLeaseWriteIdle(id: string): void {
    if (this.leaseWrites.has(id)) throw new RpcError("lease_unavailable", "Account credential ownership is changing; retry after the lease operation.");
  }

  assertLocalAccount(account: AccountRow): void {
    const current = this.store.getAccount(account.id) ?? account;
    if (this.store.activeCredentialHandoff(account.id)) throw new RpcError("credential_handoff_fenced", "Credential handoff holds this account; finish the committed takeover or abort an unprepared export.");
    if (current.source !== "leased" && this.leaseWrites.has(current.id)) throw new RpcError("lease_unavailable", "Account credential ownership is changing; retry after lease installation.");
    if (current.source === "leased") throw new RpcError("account_leased", `Account ${current.id} is leased from ${current.leasedFrom?.authorityNodeId}; request renewal from its authority.`);
  }

  private async publishClaudeMaterial(account: AccountRow, published: Record<string, unknown>, state: KeychainState): Promise<boolean> {
    this.leaseMaterialCodecs.get(account.harness)?.keychain?.assertHome(account.homePath);
    const raw = JSON.stringify(published);
    mkdirSync(account.homePath, { recursive: true, mode: 0o700 });
    mkdirSync(this.vaultDirOf(account), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(join(this.vaultDirOf(account), ".credentials.json"), raw, 0o600);
    const keychainRaw = JSON.stringify({ ...published, ...keychainDocument(state), claudeAiOauth: published.claudeAiOauth });
    let written = false;
    const attempts = state.status === "present" ? CLAUDE_KEYCHAIN_PUBLISH_ATTEMPTS : 1;
    for (let attempt = 0; attempt < attempts && !written; attempt += 1) written = await this.keychainWriter(account.homePath, keychainRaw).catch(() => false);
    if (state.status !== "unavailable" && !written) throw new CredentialAuthorityError("Could not replace the account Keychain entry; runtime starts remain blocked until publication succeeds.");
    atomicWriteFileSync(join(account.homePath, ".credentials.json"), raw, 0o600);
    return written;
  }

  private async withLeaseWrite<T>(id: string, run: () => Promise<T>): Promise<T> {
    return this.withLeaseQueue(this.leaseWrites, id, run);
  }

  private async withLeaseQueue<T>(queue: Map<string, Promise<unknown>>, id: string, run: () => Promise<T>): Promise<T> {
    const previous = queue.get(id);
    const pending = (async () => {
      await previous?.catch(() => {});
      try { return await run(); }
      catch (error) {
        if (error instanceof RpcError) throw error;
        throw new RpcError("lease_unavailable", "Lease material could not be installed or removed; retry after resolving account storage access.");
      }
    })();
    queue.set(id, pending);
    try { return await pending; }
    finally { if (queue.get(id) === pending) queue.delete(id); }
  }

  private credentialPaths(account: AccountRow): string[] {
    const codec = this.leaseMaterialCodecs.get(account.harness)!;
    return [...new Set([...codec.files, ...Object.values(codec.mirrors)])];
  }

  private leaseFilePath(root: string, rel: string): string {
    let current = root;
    try { if (lstatSync(root).isSymbolicLink()) throw new RpcError("invalid_request", "Lease storage must not contain symbolic links."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    for (const part of rel.split("/")) {
      current = join(current, part);
      try { if (lstatSync(current).isSymbolicLink()) throw new RpcError("invalid_request", "Lease storage must not contain symbolic links."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return current;
  }

  assertHandoffAdoptable(account: AccountRow): void {
    if (this.store.activeLoginFlow(account.id) || this.refreshBusy(account) || this.leaseMints.has(account.id) || this.nativeKeychainSeeds.has(account.id)) throw new RpcError("credential_handoff_unavailable", "The destination has an active credential operation.");
    if (this.authorityFor(account)?.enabled(account)) throw new RpcError("credential_handoff_conflict", "The destination already owns a central refresh chain.");
    if (account.source !== "leased" && ((account.status === "paused" && account.pausedBy === "operator") || this.credentialHealthOf(account) !== "absent")) throw new RpcError("account_adopt_refused", "Handoff cannot overwrite native credentials; use an empty or leased destination account.");
  }

  assertNoNewNativeTakeover(account: AccountRow): void {
    const codec = this.leaseMaterialCodecs.get(account.harness);
    if (!codec) throw new RpcError("credential_handoff_unsupported", "No takeover codec is registered.");
    for (const { raw, rel } of this.leaseCredentialCopies(account)) {
      if (rel !== codec.primaryFile && !Object.values(codec.mirrors).includes(rel)) continue;
      const native = this.providerNativeGrant(account, raw);
      if (native === null) throw new RpcError("credential_handoff_unavailable", "Provider credential material cannot be identified; preserve it for operator review.");
      if (native) throw new RpcError("credential_handoff_decided", "A new native login superseded the abandoned destination; preserve its credentials.");
    }
  }

  async scrubHandoff(account: AccountRow): Promise<void> {
    const authority = this.authorityFor(account)!;
    const authorityRoot = join(this.cfg.accounts.vaultDir, ".credential-authorities");
    const authorityName = encodeURIComponent(account.id);
    const codec = this.leaseMaterialCodecs.get(account.harness);
    if (!codec) throw new RpcError("credential_handoff_unsupported", "No credential scrub codec is registered for this harness.");
    codec.keychain?.assertHome(account.homePath);
    const credentialPaths = [codec.primaryFile, ...Object.entries(codec.mirrors).filter(([canonical]) => canonical === codec.primaryFile).map(([, mirror]) => mirror)];
    for (const rel of credentialPaths) for (const root of [account.homePath, this.vaultDirOf(account)]) {
      const raw = readIfFile(this.leaseFilePath(root, rel));
      if (raw !== null) JSON.parse(raw);
    }
    if (codec.keychain && (await codec.keychain.read(account.homePath)).status === "unreadable") throw new RpcError("credential_handoff_unavailable", "Unlock the credential Keychain before finishing takeover.");
    if (existsSync(join(authorityRoot, `${authorityName}.json`))) await authority.scrubHandoff(account);
    const scrub = async () => {
      if (codec.keychain) {
        const state = await codec.keychain.read(account.homePath);
        if (state.status === "unreadable") throw new RpcError("credential_handoff_unavailable", "Unlock the credential Keychain before finishing takeover.");
        if (state.status === "present") await codec.keychain.publish(account, JSON.stringify(blankRefreshTokens(JSON.parse(state.raw))), state);
      }
      for (const rel of credentialPaths) for (const root of [account.homePath, this.vaultDirOf(account)]) {
        const path = this.leaseFilePath(root, rel), raw = readIfFile(path);
        if (raw === null) continue;
        const document = JSON.parse(raw);
        atomicWriteFileSync(path, JSON.stringify(codec.accessOnly ? codec.accessOnly(document) : blankRefreshTokens(document)), 0o600);
      }
      if (existsSync(authorityRoot)) authority.forgetHandoffAdoption(account);
    };
    if (codec.keychain) await codec.keychain.withLock(account.homePath, scrub); else await scrub();
  }

  private providerNativeGrant(account: AccountRow, raw: string): boolean | null {
    try {
      const document = JSON.parse(raw);
      const authority = this.credentialAuthorities.get(account.harness);
      if (!authority) return hasRefreshGrant(document);
      const parsed = authority.parseDocument(document);
      return parsed ? Boolean(parsed.refreshToken || parsed.bootstrapToken) : this.staticLeaseMaterial(document, account.harness) ? false : null;
    } catch { return null; }
  }

  private nativeMaterialKind(harness: string, raw: string): "native" | "access_only" | "unknown" {
    let document: unknown;
    try { document = JSON.parse(raw); } catch { return "unknown"; }
    if (document && typeof document === "object" && !Array.isArray(document)) {
      const credential = this.credentialAuthorities.get(harness)?.parseDocument(document as Record<string, unknown>);
      if (credential) return credential.refreshToken || credential.bootstrapToken ? "native" : "access_only";
    }
    if (harness === "claude") {
      const parsed = parseClaudeCredentials(raw);
      return parsed ? hasRefreshToken(parsed) ? "native" : "access_only" : "unknown";
    }
    let refresh = false;
    let access = false;
    const walk = (value: unknown) => {
      if (value === null || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (["refreshToken", "refresh_token", "refresh"].includes(key) && typeof child === "string" && child.length > 0) refresh = true;
        if (["accessToken", "access_token", "access"].includes(key) && typeof child === "string" && child.length > 0) access = true;
        walk(child);
      }
    };
    walk(document);
    return refresh ? "native" : access ? "access_only" : "unknown";
  }

  private latestNativeBackup(account: AccountRow): { path: string; at: number } | null {
    const root = join(this.cfg.accounts.vaultDir, ".native-backup", account.id);
    if (!existsSync(root)) return null;
    this.leaseFilePath(root, "metadata.json");
    const codec = this.leaseMaterialCodecs.get(account.harness);
    if (!codec) return null;
    const entries = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => {
      const at = Number(entry.name.split("-")[0]);
      if (!Number.isSafeInteger(at) || at < 0) throw new RpcError("native_backup_invalid", "Native backup directory has an invalid timestamp.");
      const path = join(root, entry.name);
      const kinds = [join("home", codec.primaryFile), join("vault", codec.primaryFile), "keychain.json"].map(rel => {
        const raw = readIfFile(this.leaseFilePath(path, rel));
        return raw === null ? null : this.nativeMaterialKind(account.harness, raw);
      });
      if (kinds.includes("unknown")) throw new RpcError("native_backup_invalid", "Native backup provenance cannot be established; preserve it for operator review.");
      const genuine = kinds.includes("native");
      return { path, at, genuine };
    }).filter(entry => entry.genuine).sort((a, b) => b.at - a.at || b.path.localeCompare(a.path));
    return entries[0] ?? null;
  }

  nativeBackupStatus(account: AccountRow): { exists: boolean; backedUpAt: number | null } {
    const backup = this.latestNativeBackup(account);
    return { exists: backup !== null, backedUpAt: backup?.at ?? null };
  }

  private pruneNativeBackups(account: AccountRow, keep: string | null): void {
    const root = join(this.cfg.accounts.vaultDir, ".native-backup", account.id);
    if (!existsSync(root)) return;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && join(root, entry.name) !== keep) rmSync(join(root, entry.name), { recursive: true });
    }
  }

  private backupNativeMaterial(account: AccountRow, state: KeychainState): string | null {
    const codec = this.leaseMaterialCodecs.get(account.harness)!;
    const sources: { name: string; root: string }[] = [];
    for (const [name, root] of [["home", account.homePath], ["vault", this.vaultDirOf(account)]] as const) {
      const raw = readIfFile(this.leaseFilePath(root, codec.primaryFile));
      if (raw === null) continue;
      const kind = this.nativeMaterialKind(account.harness, raw);
      if (kind === "unknown") throw new RpcError("account_adopt_refused", "Native credential provenance cannot be established; preserve it and resolve ownership before adopting.");
      if (kind === "native") sources.push({ name, root });
    }
    const keychainNative = state.status === "present" && this.nativeMaterialKind(account.harness, state.raw) === "native";
    if (state.status === "present" && this.nativeMaterialKind(account.harness, state.raw) === "unknown") throw new RpcError("account_adopt_refused", "Keychain credential provenance cannot be established; preserve it before adopting.");
    if (sources.length === 0 && !keychainNative) {
      this.pruneNativeBackups(account, this.latestNativeBackup(account)?.path ?? null);
      return null;
    }
    const root = join(this.cfg.accounts.vaultDir, ".native-backup", account.id);
    const path = join(root, `${this.now()}-${randomUUID()}`);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(dirname(root), 0o700);
    chmodSync(root, 0o700);
    chmodSync(path, 0o700);
    if (keychainNative && state.status === "present") atomicWriteFileSync(join(path, "keychain.json"), state.raw, 0o600);
    for (const source of sources) {
      for (const rel of this.credentialPaths(account)) {
        const from = this.leaseFilePath(source.root, rel);
        if (!existsSync(from)) continue;
        const raw = readIfFile(from);
        if (raw !== null && this.nativeMaterialKind(account.harness, raw) === "access_only") continue;
        const to = join(path, source.name, rel);
        mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
        renameSync(from, to);
        chmodSync(to, 0o600);
      }
    }
    this.pruneNativeBackups(account, path);
    return path;
  }

  restoreNativeBackup(id: string, localIngress = true): Promise<{ account: AccountRow; backupAt: number; restoredAt: number; files: string[]; keychainRestored: boolean }> {
    return this.withLeaseWrite(id, async () => {
      const account = this.store.getAccount(id);
      if (!account) throw new RpcError("account_not_found", "Account not found.");
      const assertLocalRestore = (current: AccountRow) => {
        if (current.leasedFrom?.fencesForwarded && !localIngress) throw new RpcError("account_lease_conflict", "Restoring native ownership of an account with lease fences requires a direct local Unix-socket call.", { account: id, reason: "local_required" });
      };
      assertLocalRestore(account);
      const foreign = this.foreignHomeRefusal(account, "restores a backup into");
      if (foreign) throw new RpcError("native_backup_restore_refused", foreign);
      const codec = this.leaseMaterialCodecs.get(account.harness);
      const backup = this.latestNativeBackup(account);
      if (account.source !== "local" && (account.leasedFrom?.revokedAt == null || account.leasedFrom.adoptedAt === null)) throw new RpcError("account_leased", "Revoke the adopted lease before explicitly restoring its native backup.");
      if (!codec || !backup) throw new RpcError("native_backup_absent", "No genuine native backup exists for this account.");
      const assertAllowed = () => {
        const current = this.store.getAccount(id)!;
        assertLocalRestore(current);
        if (current.source !== "local" && (current.leasedFrom?.revokedAt == null || current.leasedFrom.adoptedAt === null)) throw new RpcError("account_leased", "Revoke the adopted lease before explicitly restoring its native backup.");
        if (this.store.beesOnAccount(id).some(bee => { const runtime = this.store.currentRuntime(bee.id); return runtime !== null && runtime.state !== "stopped"; }) || this.store.listUnreconciledAccountAdmissions(this.now(), { account: id }).length > 0 || this.authorityFor(current)?.enabled(current) || this.authorityFor(current)?.busy(current) || this.refreshBusy(current) || this.nativeKeychainSeeds.has(id) || this.store.activeLoginFlow(id)) throw new RpcError("native_backup_restore_refused", "Stop every bee and finish account credential operations before restoring a native backup.");
        if (this.credentialed(current)) throw new RpcError("native_backup_restore_refused", "The account already has credentials; a native backup will not overwrite them.");
      };
      assertAllowed();
      const restore = async () => {
        codec.keychain?.assertHome(account.homePath);
        const state = codec.keychain ? await codec.keychain.read(account.homePath) : { status: "unavailable" } as const;
        assertAllowed();
        if (state.status !== "absent" && state.status !== "unavailable") throw new RpcError("native_backup_restore_refused", "The per-home Keychain is present or unreadable; preserve it before restoring.");
        let keychainRestored = false;
        const files: string[] = [];
        for (const [name, root] of [["vault", this.vaultDirOf(account)], ["home", account.homePath]] as const) {
          for (const rel of this.credentialPaths(account)) {
            const raw = readIfFile(this.leaseFilePath(backup.path, join(name, rel)));
            if (raw === null || this.nativeMaterialKind(account.harness, raw) === "access_only") continue;
            const target = this.leaseFilePath(root, rel);
            mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
            atomicWriteFileSync(target, raw, 0o600);
            files.push(`${name}/${rel}`);
          }
        }
        if (codec.keychain) {
          const raw = ["keychain.json", join("home", codec.primaryFile), join("vault", codec.primaryFile)].map(rel => readIfFile(this.leaseFilePath(backup.path, rel))).find(value => value !== null && this.nativeMaterialKind(account.harness, value) === "native") ?? null;
          if (raw === null || this.nativeMaterialKind(account.harness, raw) !== "native") throw new RpcError("native_backup_invalid", "The backup has no genuine native Keychain credential.");
          keychainRestored = await codec.keychain.publish(account, raw, state);
        }
        if (account.source === "leased") this.store.returnAdoptedAccountToLocal(id);
        this.store.setAccountStatus(id, "auth_needed", "Native backup explicitly restored; validate or log in before placing work.");
        return { account: this.store.getAccount(id)!, backupAt: backup.at, restoredAt: this.now(), files, keychainRestored };
      };
      codec.keychain?.assertHome(account.homePath);
      return codec.keychain ? codec.keychain.withLock(account.homePath, restore) : restore();
    });
  }

  private assertAdoptable(account: AccountRow, explicit = false): void {
    if (account.harness === "muse") throw new RpcError("lease_unsupported", "Muse lease adoption is not supported; enrol an access-only row instead.");
    if (!explicit) {
      if ((account.status === "paused" && account.pausedBy === "operator") || (account.status !== "auth_needed" && this.credentialHealthOf(account) !== "absent") || this.authorityFor(account)?.enabled(account) || this.authorityFor(account)?.busy(account) || this.refreshBusy(account) || this.nativeKeychainSeeds.has(account.id) || this.store.activeLoginFlow(account.id)) throw new RpcError("account_adopt_refused", "The native account is working, operator-paused, or changing credentials; it cannot be adopted.");
      return;
    }
    if (this.authorityFor(account)?.enabled(account) || this.authorityFor(account)?.busy(account)) throw new RpcError("account_adopt_central", "A central credential authority cannot become a lessee by adoption; use take-over instead.");
    if ((account.status === "paused" && account.pausedBy === "operator") || this.refreshBusy(account) || this.nativeKeychainSeeds.has(account.id) || this.store.activeLoginFlow(account.id) || this.leaseMints.has(account.id)) throw new RpcError("account_adopt_refused", "The native account is operator-paused or changing credentials; it cannot be adopted.");
    if (this.store.beesOnAccount(account.id).some(bee => { const runtime = this.store.currentRuntime(bee.id); return runtime !== null && runtime.state !== "stopped"; }) || this.store.listUnreconciledAccountAdmissions(this.now(), { account: account.id }).length > 0) throw new RpcError("account_adopt_running", "Stop every bee and finish pending admissions before explicitly replacing a native login.");
  }

  private assertEnrolmentQuiescent(account: AccountRow): void {
    const unisolated = this.isolationRefusal(account.harness);
    if (unisolated) throw new RpcError("lease_unsupported", unisolated);
    if (this.isNative(account) || this.foreignHomeRefusal(account, "enrols credentials into")) throw new RpcError("account_lease_enrol_refused", "Enrolment requires an existing isolated Honeybee account home.", { reason: "native_account" });
    if (this.store.activeLoginFlow(account.id) || this.refreshBusy(account) || this.leaseMints.has(account.id) || this.nativeKeychainSeeds.has(account.id)) throw new RpcError("account_lease_enrol_refused", "Another credential operation is active; retry enrolment after it finishes.", { reason: "busy" });
    if (this.store.activeCredentialHandoff(account.id)) throw new RpcError("credential_handoff_fenced", "Credential ownership is changing; enrolment cannot replace its material.");
    const root = join(this.cfg.accounts.vaultDir, ".credential-authorities");
    if (this.authorityFor(account)?.enabled(account) || [".json", ".previous.json"].some(suffix => existsSync(this.leaseFilePath(root, `${encodeURIComponent(account.id)}${suffix}`)))) throw new RpcError("account_lease_enrol_refused", "A private credential authority exists; enrolment cannot replace its refresh chain.", { reason: "refresh_chain" });
  }

  private leaseCopyPaths(root: string, rel: string): string[] {
    const path = this.leaseFilePath(root, rel);
    let entries: string[];
    try { entries = readdirSync(dirname(path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return [rel]; throw error; }
    const prefix = `${basename(rel)}.tmp.`;
    return [rel, ...entries.filter(entry => entry.startsWith(prefix) && /^[0-9a-f-]{36}$/.test(entry.slice(prefix.length))).map(entry => join(dirname(rel), entry))];
  }

  private assertEnrolmentMaterial(account: AccountRow, codec: LeaseMaterialCodec, state: KeychainState): void {
    if (!codec.provesAccessOnly) throw new RpcError("lease_unsupported", "This harness has no access-only enrolment proof codec.");
    if (state.status === "unreadable") throw new RpcError("account_lease_enrol_refused", "Unlock the account Keychain before enrolling its credentials.", { reason: "unknown_material" });
    let primary = false;
    const check = (raw: string, isPrimary: boolean, copy: string, canonical = true) => {
      let document: unknown;
      try { document = JSON.parse(raw); } catch { throw new RpcError("account_lease_enrol_refused", `Credential or profile copy ${copy} is invalid JSON; repair or preserve it before enrolling.`, { reason: "unknown_material", copy }); }
      if (!document || typeof document !== "object" || Array.isArray(document)) throw new RpcError("account_lease_enrol_refused", "Credential provenance cannot be established; preserve the existing material.", { reason: "unknown_material" });
      if (hasRefreshGrant(document)) throw new RpcError("account_lease_enrol_refused", `Credential copy ${copy} holds a refresh grant; enrolment leaves the account untouched.`, { reason: "refresh_chain", copy });
      if (isPrimary) {
        if (!codec.provesAccessOnly!(document as Record<string, unknown>)) throw new RpcError("account_lease_enrol_refused", "The existing primary credential is not a recognised access-only login.", { reason: "unknown_material" });
        if (canonical) primary = true;
      }
    };
    for (const rel of this.credentialPaths(account)) for (const root of [account.homePath, this.vaultDirOf(account)]) for (const copy of this.leaseCopyPaths(root, rel)) {
      const path = this.leaseFilePath(root, copy);
      let raw: string;
      try { raw = readFileSync(path, "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new RpcError("account_lease_enrol_refused", "An existing credential copy cannot be read; resolve its storage access before enrolling.", { reason: "unknown_material" });
      }
      check(raw, rel === codec.primaryFile || codec.mirrors[codec.primaryFile] === rel, `${root === account.homePath ? "home" : "vault"}/${copy}`, copy === rel);
    }
    if (state.status === "present") check(state.raw, true, "per-home Keychain");
    if (!primary) throw new RpcError("account_lease_enrol_refused", "No existing access-only primary credential can be proved; enrolment does not create a native account.", { reason: "unknown_material" });
  }

  exportLeasedMaterial(id: string): Promise<AccountLeaseExportResult> {
    return this.withLeaseWrite(id, async () => {
      const account = this.store.getAccount(id);
      if (!account) throw new RpcError("account_not_found", "Account was not found.");
      const refuse = (reason: string, state?: string, handoffId?: string): never => {
        throw new RpcError("account_lease_export_refused", `Leased material export refused: ${reason}${state ? ` (${state})` : ""}; retry only after its owner settles the account.`, { reason, ...(state ? { state } : {}), ...(handoffId ? { handoffId } : {}) });
      };
      if (account.source !== "leased" || account.native || !account.leasedFrom) refuse("not_leased", account.source);
      const origin = account.leasedFrom!;
      if (origin.fencesForwarded) refuse("forwarding_depth_exceeded");
      const authority = this.authorityFor(account);
      const handoff = this.store.activeCredentialHandoff(id);
      if (handoff) refuse("handoff", handoff.adoptionRecovery?.retainedGeneration !== undefined ? "retained_unusable" : handoff.releasePeer?.outcome ?? handoff.state, handoff.handoffId);
      const phase = authority?.status(account)?.phase;
      if (phase === "handing_off" || phase === "adopting") refuse("handoff", phase);
      if (authority?.busy(account) || this.refreshBusy(account) || this.leaseMints.has(id) || this.store.activeLoginFlow(id) || this.nativeKeychainSeeds.has(id)) refuse("authority_busy", authority?.activeHandoffLane(account)?.kind ?? "active_lane");
      const interruptions = this.store.listLiveAuthInterruptions().filter(row => row.account === id);
      const recovery = interruptions.find(row => row.deathRecovery?.claimedAt === null);
      if (recovery) refuse("auth_recovery", recovery.deathRecovery?.deadline === null ? "waiting_for_exit" : "waiting_for_material");
      if (origin.revokedAt !== null) refuse("revoked");
      if (origin.expiresAt === null) refuse("unsupported", "unbounded_expiry");
      if (!Number.isSafeInteger(origin.expiresAt)) refuse("material_unavailable", "invalid_expiry");
      if (origin.expiresAt! * 1000 <= this.now()) refuse("expired");
      if (typeof origin.authorityInstanceId !== "string" || !origin.authorityInstanceId) refuse("instance_missing");
      if (!Number.isSafeInteger(origin.generation) || origin.generation! < 0) refuse("generation_missing");
      if (origin.materialPublished !== true) refuse("publication_pending");
      if (account.status === "paused") refuse("paused");
      if (account.status !== "ok") refuse("account_auth_needed", account.status);
      const codec = this.leaseMaterialCodecs.get(account.harness);
      if (!codec || !authority || account.harness === "muse" || this.isolationRefusal(account.harness)) refuse("unsupported");
      let document: Record<string, unknown>;
      let revision = "";
      try {
        const homeRaw = readFileSync(this.leaseFilePath(account.homePath, codec!.primaryFile), "utf8");
        revision = createHash("sha256").update(homeRaw).digest("hex").slice(0, 16);
        const home = JSON.parse(homeRaw);
        const vault = JSON.parse(readFileSync(this.leaseFilePath(this.vaultDirOf(account), codec!.primaryFile), "utf8"));
        const current = authority!.parseDocument(home);
        const privateCopy = authority!.parseDocument(vault);
        if (!current || !privateCopy || current.accessToken !== privateCopy.accessToken || current.expiresAt !== privateCopy.expiresAt || current.expiresAt < origin.expiresAt! * 1000 || hasRefreshGrant(home) || hasRefreshGrant(vault)) refuse("material_unavailable");
        document = (codec!.accessOnly ? codec!.accessOnly(home) : blankRefreshTokens(home)) as Record<string, unknown>;
        if (!codec!.provesAccessOnly?.(document) || hasRefreshGrant(document)) refuse("material_unavailable");
      } catch { return refuse("material_unavailable"); }
      if (interruptions.some(row => row.state === "open" && !row.deathRecovery && row.blockedRevision !== null && row.blockedRevision === revision)) refuse("account_auth_needed", "blocked_revision");
      const result: AccountLeaseExportResult = { fencesForwarded: origin.fencesForwarded === true,
        ...(origin.retiredAuthorityInstanceIds !== undefined ? { retiredAuthorityInstanceIds: [...origin.retiredAuthorityInstanceIds].slice(-8) } : {}),
        ...(origin.authorityGenerationFloor !== undefined ? { authorityGenerationFloor: origin.authorityGenerationFloor } : {}),
        ...(origin.legacyAuthorityInstanceId !== undefined ? { legacyAuthorityInstanceId: origin.legacyAuthorityInstanceId } : {}),
        ...(origin.legacyAuthorityGenerationFloor !== undefined ? { legacyAuthorityGenerationFloor: origin.legacyAuthorityGenerationFloor } : {}), authorityInstanceId: origin.authorityInstanceId!, account: id, harness: account.harness, authorityNodeId: origin.authorityNodeId, shareId: origin.shareId,
        epoch: origin.epoch, generation: origin.generation!, expiresAt: origin.expiresAt!, files: [{ homeRelPath: codec!.primaryFile, contentB64: Buffer.from(JSON.stringify(document)).toString("base64"), mode: 0o600 }], kindNote: "Leased access-only material; original authority retained" };
      this.store.recordAccountLeaseExport(id, result.files.length);
      return result;
    });
  }

  installLease(input: AccountLeaseInstallParams, onInstalled: (account: AccountRow) => void = () => {}, localIngress = true): Promise<Omit<AccountLeaseInstallResult, "account" | "restored"> & { account: AccountRow }> {
    const explicit = input.adopt === "explicit";
    const forwarded = LEASE_FENCE_FIELDS.some(key => input[key] !== undefined);
    if (forwarded) {
      const safeId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(value);
      const floor = (value: unknown) => value === undefined || typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
      if (!safeId(input.authorityInstanceId) || !safeId(input.viaNodeId) || input.generation === undefined || !floor(input.generation) || !floor(input.authorityGenerationFloor) || !floor(input.legacyAuthorityGenerationFloor) || input.legacyAuthorityInstanceId !== undefined && !safeId(input.legacyAuthorityInstanceId) || input.legacyAuthorityGenerationFloor !== undefined && input.legacyAuthorityInstanceId === undefined || input.fencesForwarded !== undefined && typeof input.fencesForwarded !== "boolean" || input.retiredAuthorityInstanceIds !== undefined && (!Array.isArray(input.retiredAuthorityInstanceIds) || input.retiredAuthorityInstanceIds.length > 8 || !input.retiredAuthorityInstanceIds.every(safeId) || new Set(input.retiredAuthorityInstanceIds).size !== input.retiredAuthorityInstanceIds.length)) throw new RpcError("invalid_request", "Forwarded fences require a scoped material generation, issuer and bounded valid history.");
      if (input.retiredAuthorityInstanceIds?.includes(input.authorityInstanceId)) throw new RpcError("invalid_request", "A forwarded fence cannot retire the material it carries.");
      if (input.fencesForwarded) throw new RpcError("account_lease_conflict", "Lease fences cannot be forwarded beyond one export hop.", { reason: "forwarding_depth_exceeded" });
    }
    if (input.enrol && input.adopt !== undefined || input.enrol && !input.viaNodeId) throw new RpcError("invalid_request", "Enrolment requires viaNodeId and cannot be combined with adoption.");
    return this.withLeaseQueue(this.leaseResolutions, input.id, async () => {
      const retainedEnrolment = this.store.getAccount(input.id)?.leasedFrom?.enrolment;
      const id = input.adopt || input.enrol || retainedEnrolment ? input.id : `${input.id}@${input.shareId.slice(0, 8)}`;
      if (!isAccountId(id)) throw new RpcError("invalid_request", "Account id must be a bounded safe account identity.");
      const companion = this.store.getAccount(`${input.id}@${input.shareId.slice(0, 8)}`);
      if (input.enrol && !retainedEnrolment && companion?.source === "leased" && companion.leasedFrom?.shareId === input.shareId) throw new RpcError("account_lease_conflict", "A companion lease already exists for this share; remove its account row with account.remove before enrolling the original row. lease.remove only revokes its material.");
      return this.withLeaseWrite(id, async () => {
        let account = this.store.getAccount(id);
        if (account && (this.store.activeCredentialHandoff(id) || ["handing_off", "adopting"].includes(this.authorityFor(account)?.status(account)?.phase ?? ""))) throw new RpcError("credential_handoff_fenced", "Credential ownership is changing; lease installation cannot overwrite an authority.");
        if (input.adopt && !account) throw new RpcError("account_adopt_refused", "Adoption requires an existing same-id native account.");
        if (input.enrol && (!account || account.source === "leased" && !account.leasedFrom?.enrolment)) throw new RpcError("account_lease_enrol_refused", "Enrolment requires an existing local access-only row or its own pending enrolment.", { reason: "native_account" });
        if (input.enrol && account) this.assertEnrolmentQuiescent(account);
        const adopted = account?.source === "local" && !input.enrol;
        const previous = account?.leasedFrom;
        const originChanged = previous && (previous.shareId !== input.shareId || previous.authorityNodeId !== input.authorityNodeId || previous.epoch !== input.epoch);
        if (originChanged && previous.fencesForwarded && !localIngress) throw new RpcError("account_lease_conflict", "Changing the origin of an account with lease fences requires a direct local Unix-socket call.", { account: id, reason: "local_required" });
        const enrolment = previous?.enrolment ?? (input.enrol && account ? { id: randomUUID(), at: this.now(), liveRuntimeCoveragePending: this.store.beesOnAccount(id).filter(bee => { const runtime = this.store.currentRuntime(bee.id); return runtime !== null && runtime.state !== "stopped"; }).length } : undefined);
        const viaNodeId = input.viaNodeId ?? previous?.viaNodeId;
        const sameOrigin = previous?.shareId === input.shareId && previous.authorityNodeId === input.authorityNodeId;
        if (previous?.fencesForwarded && input.viaNodeId !== undefined && input.viaNodeId !== previous.viaNodeId) throw new RpcError("account_lease_conflict", "A forwarded lease's issuer is fixed until its account row is removed locally.", { reason: "issuer_conflict" });
        if (forwarded && sameOrigin && input.viaNodeId !== (previous.viaNodeId ?? previous.authorityNodeId)) throw new RpcError("account_lease_conflict", "Forwarded fences must come from this lease's authenticated issuer.", { reason: "issuer_conflict" });
        const localRetired = previous?.retiredAuthorityInstanceIds ?? [];
        const retiredAuthorityInstanceIds = [...new Set([...localRetired, ...(forwarded ? input.retiredAuthorityInstanceIds ?? [] : [])])];
        if (input.authorityInstanceId !== undefined && retiredAuthorityInstanceIds.includes(input.authorityInstanceId)) throw new RpcError("account_lease_conflict", "Lease material belongs to a retired authority instance.", { reason: "retired_instance" });
        const rememberedInstance = previous?.authorityInstanceId ?? previous?.legacyAuthorityInstanceId;
        const rememberedFloor = previous ? Math.max(previous.generation ?? 0, previous.authorityGenerationFloor ?? 0, previous.legacyAuthorityGenerationFloor ?? 0) : 0;
        if (input.authorityInstanceId !== undefined && input.authorityInstanceId === previous?.legacyAuthorityInstanceId && (input.generation === undefined || input.generation <= rememberedFloor)) throw new RpcError("account_lease_conflict", "Returning authority instance must exceed the intervening legacy generation floor.");
        const localHistory = input.authorityInstanceId !== undefined && rememberedInstance !== undefined && rememberedInstance !== input.authorityInstanceId
          ? [...new Set([...localRetired, rememberedInstance])] : localRetired;
        const keptLocal = localHistory.slice(-8);
        const capacity = 8 - keptLocal.length;
        const incomingHistory = forwarded ? (input.retiredAuthorityInstanceIds ?? []).filter(instance => !localHistory.includes(instance)) : [];
        const retiredInstances = [...keptLocal, ...(capacity ? incomingHistory.slice(-capacity) : [])];
        const forwardedFloor = forwarded ? Math.min(input.generation!, Math.max(input.authorityGenerationFloor ?? 0, input.legacyAuthorityInstanceId === input.authorityInstanceId ? input.legacyAuthorityGenerationFloor ?? 0 : 0)) : 0;
        const currentInstanceFloor = input.authorityInstanceId !== undefined ? Math.max(input.generation ?? 0, forwardedFloor,
          previous?.authorityInstanceId === input.authorityInstanceId ? previous.authorityGenerationFloor ?? previous.generation ?? 0 : 0) : undefined;
        if (input.authorityInstanceId !== undefined && input.authorityInstanceId === previous?.authorityInstanceId && input.generation !== undefined && input.generation < (previous.authorityGenerationFloor ?? previous.generation ?? 0)) throw new RpcError("account_lease_conflict", "Lease credential generation regressed within its authority instance.", { reason: "generation_floor" });
        const legacyInstance = input.authorityInstanceId === undefined && rememberedInstance !== undefined
          ? { legacyAuthorityInstanceId: rememberedInstance, legacyAuthorityGenerationFloor: Math.max(rememberedFloor, input.generation ?? 0) } : {};
        const codec = this.leaseMaterialCodecs.get(input.harness);
        if (!codec) throw new RpcError("lease_unsupported", "This harness has no lease material codec.");
        if (enrolment && (input.files.length !== 1 || input.files[0]?.homeRelPath !== codec.primaryFile)) throw new RpcError("account_lease_enrol_refused", "Enrolled leases publish primary credential material only; profile files remain local.", { reason: "unknown_material" });
        if (enrolment && input.files.some(file => { try { const document = JSON.parse(Buffer.from(file.contentB64, "base64").toString("utf8")); return hasRefreshGrant(document) || !codec.provesAccessOnly?.(document); } catch { return true; } })) throw new RpcError("account_lease_enrol_refused", "Enrolment requires recognised access-only incoming material.", { reason: "unknown_material" });
        const origin = { ...(forwarded || previous?.fencesForwarded ? { fencesForwarded: true } : {}), ...(currentInstanceFloor !== undefined ? { authorityGenerationFloor: currentInstanceFloor } : {}), ...legacyInstance, ...(retiredInstances.length ? { retiredAuthorityInstanceIds: retiredInstances } : {}), ...(input.authorityInstanceId !== undefined ? { authorityInstanceId: input.authorityInstanceId } : {}), shareId: input.shareId, authorityNodeId: input.authorityNodeId, epoch: input.epoch, ...(input.generation !== undefined ? { generation: input.generation } : {}), ...(input.generation !== undefined || enrolment ? { materialPublished: true } : {}), ...(viaNodeId !== undefined ? { viaNodeId } : {}), ...(enrolment ? { enrolment, installedFiles: previous?.installedFiles ?? [codec.primaryFile, ...Object.values(codec.mirrors)] } : {}), expiresAt: input.expiresAt, adoptedAt: adopted ? this.now() : previous?.adoptedAt ?? null, revokedAt: null };
        if (account && account.harness !== input.harness) throw new RpcError("harness_mismatch", "Lease harness differs from the existing account.");
        if (account?.source === "leased" && (account.leasedFrom?.shareId !== input.shareId || account.leasedFrom.epoch > input.epoch || account.leasedFrom.epoch === input.epoch && (account.leasedFrom.authorityNodeId !== input.authorityNodeId || account.leasedFrom.expiresAt !== null && (input.expiresAt === null || input.expiresAt < account.leasedFrom.expiresAt)))) throw new RpcError("account_lease_conflict", "Lease origin conflicts with the installed lease.");
        if (account?.source === "leased" && input.generation !== undefined && account.leasedFrom?.generation !== undefined && input.generation < account.leasedFrom.generation && (input.authorityInstanceId !== undefined ? input.authorityInstanceId === account.leasedFrom.authorityInstanceId : account.leasedFrom.epoch === input.epoch)) throw new RpcError("account_lease_conflict", "Lease credential generation regressed.");
        if (adopted) {
          if (!input.adopt) throw new RpcError("account_adopt_refused", "An isolated lease cannot overwrite a native account.");
          const foreign = this.foreignHomeRefusal(account!, "moves credentials out of");
          if (foreign) throw new RpcError("account_adopt_refused", foreign);
          this.assertAdoptable(account!, explicit);
        }
        if (!account && this.credentialed({ id, harness: input.harness, homePath: this.defaultHomeOf(id) })) throw new RpcError("account_lease_conflict", "The isolated lease home already contains unregistered credentials; preserve them and resolve ownership before installing.");
        if (!account) account = this.store.createAccount({ id, harness: input.harness, label: input.label, homePath: this.defaultHomeOf(id), status: "auth_needed" });
        const target = account;
        const initialLease = target.source === "local" && !adopted && !input.enrol;
        let backupPath: string | null = null;
        let backupAt: number | null = null;
        let replacedWorkingLogin = false;
        const write = async () => {
          codec.keychain?.assertHome(target.homePath);
          const state = codec.keychain ? await codec.keychain.read(target.homePath) : { status: "unavailable" } as const;
          if (initialLease && state.status === "present") throw new RpcError("account_lease_conflict", "The isolated lease home already has an unregistered Keychain item; preserve it and resolve ownership before installing.");
          if (adopted) this.assertAdoptable(this.store.getAccount(id)!, explicit);
          if (input.enrol || enrolment && previous?.materialPublished !== true) {
            const current = this.store.getAccount(id)!;
            if (current.homePath !== target.homePath || current.harness !== target.harness || current.source !== target.source) throw new RpcError("account_lease_conflict", "Account storage changed while enrolment waited.");
            this.assertEnrolmentQuiescent(current);
            this.assertEnrolmentMaterial(current, codec, state);
          }
          if (state.status === "unreadable") throw new RpcError("lease_unavailable", "Account Keychain is unreadable; unlock it before installing a lease.");
          if (adopted && !explicit && target.status !== "auth_needed" && state.status === "present" && this.validPrimaryCredential(target.harness, codec.primaryFile, state.raw)) throw new RpcError("account_adopt_refused", "The native account has a Keychain credential; it cannot be adopted.");
          const unchanged = target.source === "leased" && JSON.stringify(target.leasedFrom) === JSON.stringify(origin)
            && input.files.every(file => {
              const raw = JSON.stringify(JSON.parse(Buffer.from(file.contentB64, "base64").toString("utf8")));
              return readIfFile(this.leaseFilePath(target.homePath, file.homeRelPath)) === raw
                && readIfFile(this.leaseFilePath(this.vaultDirOf(target), file.homeRelPath)) === raw;
            })
            && (!codec.keychain || state.status === "unavailable" || state.status === "present" && codec.keychain.matchesMaterial(state.raw, readIfFile(this.leaseFilePath(this.vaultDirOf(target), codec.primaryFile))!));
          if (unchanged) {
            this.recordLeasePublication(id, input.files, codec);
            this.store.transact(() => {
              if (input.generation === undefined) this.store.releaseAuthDeathRecoveryToLegacy(id);
              onInstalled(this.store.getAccount(id)!);
            });
            return { account: this.store.getAccount(id)!, ...(enrolment ? { enrolment } : {}), adopted: false, backupPath: null, backupAt: null, replacedWorkingLogin: false, keychainPublished: state.status === "present" };
          }
          for (const rel of this.credentialPaths(target)) {
            this.leaseFilePath(target.homePath, rel);
            this.leaseFilePath(this.vaultDirOf(target), rel);
          }
          if (adopted) {
            const current = this.store.getAccount(id)!;
            replacedWorkingLogin = explicit && current.status !== "auth_needed" && (this.credentialHealthOf(current) !== "absent" || state.status === "present" && this.validPrimaryCredential(current.harness, codec.primaryFile, state.raw));
            if (replacedWorkingLogin) {
              const native = [account.homePath, this.vaultDirOf(account)].some(root => {
                const raw = readIfFile(this.leaseFilePath(root, codec.primaryFile));
                return raw !== null && this.nativeMaterialKind(account.harness, raw) === "native";
              }) || state.status === "present" && this.nativeMaterialKind(account.harness, state.raw) === "native";
              if (!native) throw new RpcError("account_adopt_refused", "A working login requires a genuine native backup before explicit replacement; access-only or unknown material cannot be backed up.");
            }
            backupPath = this.backupNativeMaterial(target, state);
            backupAt = backupPath === null ? null : this.latestNativeBackup(target)!.at;
          }
          if (enrolment && !previous?.enrolment) {
            enrolment.at = this.now();
            enrolment.liveRuntimeCoveragePending = this.store.beesOnAccount(id).filter(bee => { const runtime = this.store.currentRuntime(bee.id); return runtime !== null && runtime.state !== "stopped"; }).length;
          }
          this.recordLeasePublication(id, input.files, codec);
          this.store.setAccountLease(id, input.generation === undefined && !enrolment ? origin : { ...origin, materialPublished: false });
          if (!input.enrol || this.homeCredentialState(target) !== "usable") this.store.setAccountStatus(id, "auth_needed", "Lease installation in progress");
          let keychainPublished = false;
          for (const file of input.files) {
            const raw = JSON.stringify(JSON.parse(Buffer.from(file.contentB64, "base64").toString("utf8")));
            if (codec.keychain && file.homeRelPath === codec.primaryFile) {
              keychainPublished = await codec.keychain.publish(target, raw, state);
            } else {
              for (const root of [this.vaultDirOf(target), target.homePath]) {
                const path = this.leaseFilePath(root, file.homeRelPath);
                mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
                atomicWriteFileSync(path, raw, 0o600);
              }
            }
          }
          for (const [canonical, mirror] of Object.entries(codec.mirrors)) {
            const raw = readFileSync(this.leaseFilePath(target.homePath, canonical), "utf8");
            const path = this.leaseFilePath(target.homePath, mirror);
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
            atomicWriteFileSync(path, raw, 0o600);
          }
          if (enrolment) for (const rel of origin.installedFiles!) for (const root of [target.homePath, this.vaultDirOf(target)]) for (const copy of this.leaseCopyPaths(root, rel).slice(1)) rmSync(this.leaseFilePath(root, copy), { force: true });
          this.store.transact(() => {
            if (input.generation !== undefined || enrolment) this.store.setAccountLease(id, origin);
            if (input.generation === undefined) this.store.releaseAuthDeathRecoveryToLegacy(id);
            onInstalled(this.store.getAccount(id)!);
          });
          return { account: this.store.getAccount(id)!, ...(enrolment ? { enrolment } : {}), adopted, backupPath, backupAt, replacedWorkingLogin, keychainPublished };
        };
        codec.keychain?.assertHome(target.homePath);
        return codec.keychain ? codec.keychain.withLock(target.homePath, write) : write();

      });
    });
  }

  private leaseCredentialCopies(account: AccountRow): { name: string; rel: string; raw: string }[] {
    const copies: { name: string; rel: string; raw: string }[] = [];
    for (const rel of [...new Set([...this.credentialPaths(account), ...(account.leasedFrom?.enrolment ? account.leasedFrom.installedFiles ?? [] : [])])]) for (const [name, root] of [["home", account.homePath], ["vault", this.vaultDirOf(account)]] as const) for (const copy of this.leaseCopyPaths(root, rel)) {
      let raw: string;
      try { raw = readFileSync(this.leaseFilePath(root, copy), "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      copies.push({ name: `${name}/${copy}`, rel, raw });
    }
    return copies;
  }

  private leaseProofKey(account: string, create = false): Buffer {
    const path = this.leaseFilePath(this.cfg.accounts.vaultDir, ".lease-material-provenance.key");
    try {
      if (!existsSync(path)) {
        if (!create) throw new Error("missing key");
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        chmodSync(dirname(path), 0o700);
        try { writeFileSync(path, randomBytes(32), { flag: "wx", mode: 0o600 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      let key: Buffer;
      try { key = readFileSync(path); }
      catch (error) {
        if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        key = randomBytes(32); atomicWriteFileSync(path, key, 0o600);
      }
      if (key.length !== 32) throw new Error("invalid key");
      return key;
    } catch { throw new RpcError("account_lease_remove_unavailable", `Credential proof key for ${account} is unavailable; preserve its material and restore the daemon key.`, { account, reason: "fingerprint_key_unavailable" }); }
  }

  private staticLeaseMaterial(value: unknown, harness: string): boolean {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    if (harness === "muse") { const meta = museMeta(record); return typeof meta?.api_key === "string" && meta.api_key !== "" && !meta.access_token; }
    if (harness === "codex") return typeof record.OPENAI_API_KEY === "string" && record.OPENAI_API_KEY !== "";
    if (harness === "grok") return Object.values(record).some(child => child !== null && typeof child === "object" && (child as Record<string, unknown>).auth_mode === "api_key" && typeof (child as Record<string, unknown>).key === "string" && (child as Record<string, unknown>).key !== "");
    return false;
  }

  private recordLeasePublication(id: string, files: { homeRelPath: string; contentB64: string }[], codec: LeaseMaterialCodec): void {
    let key: Buffer;
    try { key = this.leaseProofKey(id, true); }
    catch { throw new RpcError("lease_unavailable", `Cannot record lease publication proof for ${id}; resolve daemon storage access.`); }
    const issued: Record<string, string> = {};
    for (const file of files) {
      const raw = JSON.stringify(JSON.parse(Buffer.from(file.contentB64, "base64").toString("utf8")));
      issued[file.homeRelPath] = createHmac("sha256", key).update(raw).digest("hex");
      const mirror = codec.mirrors[file.homeRelPath];
      if (mirror) issued[mirror] = issued[file.homeRelPath]!;
    }
    this.store.putLeaseMaterialProof(id, createHash("sha256").update(key).digest("hex"), issued);
  }

  removeLease(id: string, options: Omit<AccountLeaseRemoveParams, "id"> = {}): Promise<AccountLeaseRemoveResult> {
    if (options.discardNative && (!options.confirm || options.checkOnly)) throw new RpcError("invalid_request", "Native discard requires confirmation and cannot be combined with checkOnly.");
    return this.withLeaseWrite(id, async () => {
      const account = this.store.getAccount(id);
      const base = { id, removed: false, revokedAt: account?.leasedFrom?.revokedAt ?? null, keychainRemoved: false, nativeBackupKept: existsSync(join(this.cfg.accounts.vaultDir, ".native-backup", id)) };
      if (!account) return { ...base, disposition: "absent", nativeChain: { account: id, present: false, discarded: false }, message: `Account ${id} is absent.` };
      if (account.source !== "leased") throw new RpcError("account_lease_conflict", "Only leased accounts may be removed through lease.remove.");
      const codec = this.leaseMaterialCodecs.get(account.harness);
      if (!codec) throw new RpcError("account_lease_remove_unavailable", `Cannot inspect credential copies for ${id}.`, { account: id, reason: "unsupported" });
      const unavailable = (reason: string): never => { throw new RpcError("account_lease_remove_unavailable", `Cannot establish credential ownership for ${id}; sign the account out or back it up first.`, { account: id, reason }); };
      const inspect = (state: KeychainState) => {
        if (state.status === "unreadable") unavailable("keychain_unreadable");
        const copies = this.leaseCredentialCopies(account);
        if (state.status === "present") copies.push({ name: "per-home Keychain", rel: codec.primaryFile, raw: state.raw });
        const native: { name: string; rel: string; raw: string }[] = [];
        let staticUnverified = false;
        const proof = this.store.getLeaseMaterialProof(id);
        let key: Buffer | undefined;
        for (const copy of copies) {
          if (copy.rel !== codec.primaryFile && !Object.values(codec.mirrors).includes(copy.rel)) continue;
          let document: unknown;
          try { document = JSON.parse(copy.raw); } catch {
            if (!options.discardNative) return unavailable("invalid_material");
            native.push(copy); continue;
          }
          const providerNative = this.providerNativeGrant(account, copy.raw);
          if (providerNative === null) {
            if (!options.discardNative) return unavailable("invalid_material");
            native.push(copy); continue;
          }
          if (providerNative) { native.push(copy); continue; }
          if (!this.credentialAuthorities.has(account.harness) || this.staticLeaseMaterial(document, account.harness)) {
            if (!proof || !Object.keys(proof.issued).length) { staticUnverified = true; continue; }
            try {
              key ??= this.leaseProofKey(id);
              if (proof.keyId !== createHash("sha256").update(key).digest("hex")) throw new Error("proof key mismatch");
            } catch (error) {
              if (!options.discardNative) return unavailable("fingerprint_key_unavailable");
              native.push(copy); continue;
            }
            if (proof.issued[copy.rel] !== createHmac("sha256", key).update(copy.raw).digest("hex")) native.push(copy);
          }
        }
        return { native, staticUnverified };
      };
      const remove = async () => {
        codec.keychain?.assertHome(account.homePath);
        const state: KeychainState = codec.keychain ? await codec.keychain.read(account.homePath) : { status: "unavailable" };
        let facts = inspect(state);
        let keychainRemoved = false;
        const warning = facts.staticUnverified ? ` Static material for ${id} is unverified; a user-replaced static key on a legacy row is removed.` : "";
        const result = (disposition: AccountLeaseRemoveResult["disposition"], present: boolean, discarded: boolean, message: string): AccountLeaseRemoveResult => ({ ...base, keychainRemoved, disposition, nativeChain: { account: id, present, discarded }, ...(facts.staticUnverified ? { staticUnverified: true as const } : {}), message: message + warning + (account.harness === "muse" ? " Removing or expiring this lease does not revoke its key at Meta; it may remain valid until Meta revokes it." : "") });
        const preserved = () => result("native_preserved", true, false, `Native credentials are present for ${id}. Sign the account out or back it up first.${keychainRemoved ? " The leased Keychain copy is already gone; native file copies remain preserved." : ""}`);
        if (options.checkOnly) return facts.native.length ? preserved() : result("remove_allowed", false, false, `Lease material for ${id} may be removed.`);
        const authorise = () => {
          if (!facts.native.length) return;
          if (!options.discardNative) throw new RpcError("account_lease_native_present", preserved().message, { account: id, nativeChainPresent: true, result: preserved() });
          const owned = account.leasedFrom?.enrolment ? account.leasedFrom.installedFiles ?? [codec.primaryFile, ...Object.values(codec.mirrors)] : this.credentialPaths(account);
          if (facts.native.some(copy => !owned.includes(copy.rel))) unavailable("native_outside_lease_files");
          const key = this.leaseProofKey(id, true);
          const copies = facts.native.map(copy => createHmac("sha256", key).update(copy.name).update("\0").update(copy.raw).digest("hex")).sort();
          this.store.authoriseLeaseNativeDiscard(id, createHash("sha256").update(key).digest("hex"), copies);
        };
        authorise();
        let nativeDiscarded = facts.native.length > 0;
        if (codec.keychain) {
          if (state.status === "present" && !options.discardNative) {
            const installed = readIfFile(this.leaseFilePath(this.vaultDirOf(account), codec.primaryFile));
            if (installed === null || !codec.keychain.matchesMaterial(state.raw, installed)) throw new RpcError("account_lease_conflict", `The Keychain item for ${id} no longer contains this lease; preserve it and resolve ownership.`);
          }
          if (state.status !== "unavailable") {
            keychainRemoved = await codec.keychain.remove(account.homePath);
            if (!keychainRemoved) throw new RpcError("lease_unavailable", "Could not remove the leased Keychain entry.");
          }
          facts = inspect({ status: "absent" });
          authorise();
          nativeDiscarded ||= facts.native.length > 0;
        }
        for (const rel of account.leasedFrom?.enrolment ? account.leasedFrom.installedFiles ?? [codec.primaryFile, ...Object.values(codec.mirrors)] : this.credentialPaths(account)) {
          for (const root of [account.homePath, this.vaultDirOf(account)]) for (const copy of this.leaseCopyPaths(root, rel)) rmSync(this.leaseFilePath(root, copy), { force: true });
        }
        const revoked = this.store.transact(() => {
          const revoked = this.store.revokeAccountLease(id);
          this.store.clearLeaseNativeDiscard(id);
          return revoked;
        });
        return { ...result("revoked", false, nativeDiscarded, nativeDiscarded ? `Native credentials for ${id} were discarded. The provider session behind the discarded chain for ${id} stays valid until signed out at the provider.` : `Lease material for ${id} was revoked.`), revokedAt: revoked.leasedFrom!.revokedAt, keychainRemoved };
      };
      codec.keychain?.assertHome(account.homePath);
      try { return codec.keychain ? await codec.keychain.withLock(account.homePath, remove) : await remove(); }
      catch (error) { if (error instanceof RpcError) throw error; return unavailable("storage_unreadable"); }
    });
  }

  vaultDirOf(account: Pick<AccountRow, "harness" | "id">): string {
    return vaultDirFor(this.cfg.accounts.vaultDir, account.harness, account.id);
  }

  defaultHomeOf(accountId: string): string {
    return defaultHomeFor(this.cfg.accounts.homesDir, accountId);
  }

  /** The env the account binding derives: HOME_ENV[harness] = home_path (+ recipe extras). */
  homeEnvOf(account: AccountRow): Record<string, string> {
    if (this.isNative(account)) return {};
    const key = homeEnvFor(account.harness);
    return {
      ...(account.harness === "claude" ? CLAUDE_COMPETING_AUTH_ENV_SCRUB : {}),
      ...(key ? { [key]: account.homePath } : {}),
      ...recipeEnvFor(account.harness, account.homePath),
    };
  }

  /**
   * Runtime-only credential overrides that must never be persisted in bee.env.
   * Cursor's config dir does not relocate its secret store, so the account
   * home's captured auth.json is lifted into the process environment here.
   */
  credentialEnvOf(account: AccountRow): Record<string, string> {
    return account.harness === "cursor" ? cursorCredentialEnv(account.homePath) : {};
  }

  /**
   * "Vault credentials present" (spec 08 candidate rule 1) — in the
   * home-authoritative world the HOME counts too: an account whose home is
   * already logged in is usable even before a capture; an account whose vault
   * is seeded can activate an empty home. Unknown harness (no recipe) = the
   * home is the account (singleton harnesses without a recipe are always
   * candidates).
   */
  credentialed(account: Pick<AccountRow, "harness" | "id" | "homePath">): boolean {
    const recipe = recipeFor(account.harness);
    if (!recipe) return true;
    return dirHasCredentials(this.vaultDirOf(account), recipe) || dirHasCredentials(account.homePath, recipe);
  }

  /** Why this node cannot hold `harness` accounts at all (the recipe's `unisolatedOn` reason for this platform), else null. */
  isolationRefusal(harness: string): string | null {
    return accountIsolationRefusal(harness, this.platform);
  }

  nativeHomeOf(harness: string): string | null {
    if (!this.nativeRecipe(harness)) return null;
    const vendor = resolveVendorHome(harness, this.env, this.home);
    return vendor ? resolve(vendor.vendorHome) : null;
  }

  /** The native account `harness` offers on this node (the recipe's `nativeOn`), else null. */
  nativeRecipe(harness: string): NativeAccountRecipe | null {
    return nativeAccountRecipe(harness, this.platform);
  }

  isNative(account: Pick<AccountRow, "native">): boolean {
    return account.native === true;
  }

  nativeAccount(harness: string): AccountRow | null {
    return this.store.nativeAccount(harness);
  }

  nativeHomeRefusal(account: AccountRow): string | null {
    if (!this.isNative(account)) return null;
    const home = this.nativeHomeOf(account.harness);
    if (home !== null && home === account.homePath) return null;
    const now = home === null ? `has no native ${account.harness} sign-in on this computer` : `resolves this computer's ${account.harness} home to ${home}`;
    return `account ${account.id} is this computer's own ${account.harness} sign-in at ${account.homePath}, but the Honeybee daemon now ${now}; Honeybee will not run it as an ordinary account. Restart the Honeybee daemon with the HOME and XDG_CONFIG_HOME it had when ${account.label} was added.`;
  }

  nativeDescription(account: AccountRow): string | null {
    if (!this.isNative(account)) return null;
    return this.nativeRecipe(account.harness)?.description ?? this.nativeHomeRefusal(account);
  }

  nativeRefusal(account: AccountRow): string | null {
    if (!this.isNative(account)) return null;
    const signIn = this.nativeRecipe(account.harness)?.signIn;
    return `${account.label} is this computer's own ${account.harness} sign-in; Honeybee never signs it in, copies, leases or changes it.${signIn ? ` ${signIn}` : ""}`;
  }

  nativeBeeEnv(account: AccountRow, env: Readonly<Record<string, string>>): Record<string, string> {
    if (!this.isNative(account)) return { ...env };
    const redirect = new Set(nativeAccountRecipe(account.harness, this.platform)?.redirectEnv ?? []);
    return Object.fromEntries(Object.entries(env).filter(([key]) => !redirect.has(key)));
  }

  foreignHomeRefusal(account: AccountRow, what: string): string | null {
    const native = this.nativeRefusal(account);
    if (native) return native;
    if (pathStrictlyInside(this.cfg.accounts.homesDir, account.homePath)) return null;
    return `account ${account.id}'s home ${account.homePath} is outside Honeybee's account homes (${this.cfg.accounts.homesDir}); Honeybee never ${what} a home it does not own.`;
  }

  ownedHomeRefusal(account: AccountRow, what: string): string | null {
    return this.isNative(account) ? null : this.foreignHomeRefusal(account, what);
  }

  assertOwnedHome(account: AccountRow, what: string): void {
    const foreign = this.ownedHomeRefusal(account, what);
    if (foreign) throw new RpcError("login_method_unsupported", foreign);
  }

  private nativeSignInMessage(account: AccountRow, what: string): string {
    const signIn = this.nativeRecipe(account.harness)?.signIn;
    return `account ${account.id} ${what}.${signIn ? ` ${signIn}` : ""}`;
  }

  /**
   * The credential a new runtime would read. Activation copies the vault into
   * the home only while the home holds no primary credential file, so a
   * populated home is judged on its own: a valid vault copy cannot rescue an
   * expired home the harness will actually use.
   */
  credentialState(account: AccountRow): CredentialState {
    const recipe = recipeFor(account.harness);
    if (account.source === "leased" && account.leasedFrom?.revokedAt != null) return "absent";
    if (account.source === "leased" && account.leasedFrom?.expiresAt != null && account.leasedFrom.expiresAt * 1000 <= this.now()) return "expired";
    if (!recipe) return "present";
    if (this.authorityFor(account)?.enabled(account)) return this.centralCredentialState(account);
    const primary = primaryCredentialFile(recipe);
    const source = dirHasCredentials(account.homePath, recipe)
      ? account.homePath
      : dirHasCredentials(this.vaultDirOf(account), recipe) ? this.vaultDirOf(account) : null;
    if (source === null) return "absent";
    if (account.harness === "muse") return this.museDocumentState(readIfFile(join(source, primary)), this.isNative(account));
    if (account.harness !== "claude") return "present";
    return this.claudeDocumentState(readIfFile(join(source, primary)));
  }

  /**
   * A Muse API key never expires here; an OAuth login is usable until
   * expires_at, or after it while Muse holds a refresh token and can run
   * here to use it. Where Muse cannot run (`unisolatedOn`) nothing on this
   * node refreshes the login, so it is expired once expires_at passes —
   * except the native login, which the user's own Muse refreshes.
   */
  private museDocumentState(raw: string | null, native = false): CredentialState {
    if (raw === null) return "absent";
    const parsed = parseMuseCredentials(raw);
    if (!parsed) return "invalid";
    if (parsed.mechanism !== "oauth" || parsed.expiresAt === null || parsed.expiresAt > this.now()) return "present";
    return parsed.refreshable && (native || !this.isolationRefusal("muse")) ? "present" : "expired";
  }

  private centralCredentialState(account: AccountRow): CredentialState {
    let document: Record<string, unknown>;
    try {
      document = this.authorityFor(account)!.document(account);
    } catch {
      return "invalid";
    }
    const parsed = this.authorityFor(account)!.parseDocument(document);
    if (!parsed) return "invalid";
    // A refused or possibly consumed refresh token has no refresh path, however long the last access token still lives.
    if (this.centralCredentialInDoubt(account)) return "expired";
    if (parsed.expiresAt > this.now()) return "present";
    return this.authorityFor(account)!.status(account)?.phase === "ready" && Boolean(parsed.refreshToken || parsed.bootstrapToken) ? "present" : "expired";
  }

  private claudeDocumentState(raw: string | null): CredentialState {
    if (raw === null) return "absent";
    const parsed = parseClaudeCredentials(raw);
    if (!parsed) return "invalid";
    return parsed.expiresAt > this.now() || hasRefreshToken(parsed) ? "present" : "expired";
  }

  /**
   * Whether the account's credential can authenticate a NEW runtime on this
   * node: the auth_needed verdict, then the credential a runtime would read
   * (presence, Claude document validity, expiry / refresh path). Synchronous
   * and file-backed; no provider call. A pause is not an auth fact and is
   * judged separately by `readiness`.
   */
  credentialReadiness(account: AccountRow): AccountReadiness {
    const native = this.isNative(account);
    const moved = this.nativeHomeRefusal(account);
    if (moved) return { ready: false, code: "account_unavailable", message: moved };
    if (this.store.credentialRecoveryPending(account.id)) return { ready: false, code: "account_auth_needed", message: "Signed ownership recovery holds this account; complete peer cleanup before starting another bee." };
    const unisolated = this.isolationRefusal(account.harness);
    if (unisolated && !native) return { ready: false, code: "account_unavailable", message: unisolated };
    if (this.leaseWrites.has(account.id)) return { ready: false, code: "account_auth_needed", message: "Account credential material is changing; retry after the operation completes." };
    if (account.source === "leased" && account.leasedFrom?.revokedAt != null) return { ready: false, code: "account_lease_revoked", message: `Lease ${account.leasedFrom.shareId} from ${account.leasedFrom.authorityNodeId} was revoked; request renewal from its authority.` };
    if (account.status === "auth_needed") {
      if (native) return { ready: false, code: "account_auth_needed", message: this.nativeSignInMessage(account, "needs its sign-in") };
      return { ready: false, code: "account_auth_needed", message: this.authNeededReason(account) ?? `account ${account.id} needs login; log in with: hive account login ${account.id}` };
    }
    switch (this.credentialState(account)) {
      case "absent":
        if (native) return { ready: false, code: "account_credential_missing", message: this.nativeSignInMessage(account, "has no sign-in on this computer") };
        return { ready: false, code: "account_credential_missing", message: `account ${account.id} has no credential; log in with: hive account login ${account.id}` };
      case "invalid":
        return { ready: false, code: "account_credential_invalid", message: `account ${account.id} has a credential file that is not a usable ${account.harness} credential; re-lease or log in with: hive account login ${account.id}` };
      case "expired":
        return { ready: false, code: "account_credential_expired", message: `account ${account.id} has an expired credential with no refresh path on this node; re-lease or log in with: hive account login ${account.id}` };
      case "present":
        return { ready: true };
    }
  }

  /** Node-local admission readiness for PLACING work on the account: the pause policy, then `credentialReadiness`. */
  readiness(account: AccountRow): AccountReadiness {
    if (account.source === "leased" && account.leasedFrom?.revokedAt != null) return this.credentialReadiness(account);
    if (account.status === "paused") {
      const pause = pauseOf(account);
      return { ready: false, code: "account_paused", message: `account ${account.id} is paused by ${pause ? pauseLabel(pause) : "operator"}` };
    }
    return this.credentialReadiness(account);
  }

  /** Usable for automatic selection: not paused, not auth_needed, credential present and not expired. */
  private usableForSelection(account: AccountRow): boolean {
    return account.status === "ok" && (!this.isolationRefusal(account.harness) || this.isNative(account)) && !this.nativeHomeRefusal(account) && !this.ownedHomeRefusal(account, "writes into") && this.credentialState(account) === "present";
  }

  /**
   * A name for the account's current primary credential file (home, else
   * vault): it changes exactly when those bytes do, and reveals none of them.
   */
  credentialRevision(account: Pick<AccountRow, "harness" | "id" | "homePath">): string {
    const primary = recipeFor(account.harness)?.credentialFiles[0];
    if (!primary) return AUTH_CREDENTIAL_UNREADABLE;
    for (const dir of [account.homePath, this.vaultDirOf(account)]) {
      const raw = readIfFile(join(dir, primary));
      if (raw !== null) return createHash("sha256").update(raw).digest("hex").slice(0, 16);
    }
    return AUTH_CREDENTIAL_UNREADABLE;
  }

  /**
   * Whether the account HOME — the only copy a runtime reads — holds a
   * primary credential a runtime could use right now. The vault is a backup:
   * a good vault copy does not make a stale home work.
   */
  homeCredentialState(account: AccountRow): "usable" | "absent" | "expired" {
    if (account.source === "leased" && account.leasedFrom?.revokedAt != null) return "absent";
    if (account.source === "leased" && (account.leasedFrom?.expiresAt != null && account.leasedFrom.expiresAt * 1000 <= this.now())) return "expired";
    const primary = recipeFor(account.harness)?.credentialFiles[0];
    if (!primary) return "usable";
    const raw = readIfFile(join(account.homePath, primary));
    if (raw === null) return "absent";
    if (account.harness === "muse") {
      const state = this.museDocumentState(raw, this.isNative(account));
      return state === "present" ? "usable" : state === "expired" ? "expired" : "absent";
    }
    if (account.harness !== "claude") return "usable";
    const parsed = parseClaudeCredentials(raw);
    if (!parsed) return "absent";
    return parsed.expiresAt > this.now() ? "usable" : "expired";
  }

  /**
   * F2 honesty: "a credential file exists" is not account health. Derived,
   * never stored — `absent` (no primary credential anywhere), `unverified`
   * (file present, zero validation evidence: the shape an importExisting
   * add or an adopted pre-existing home starts in), `verified` (a recorded
   * login/capture or a readable limits probe once proved the credential).
   * A later auth failure lives on `status` (`auth_needed`), which clients
   * must render over a historical `verified`.
   */
  credentialHealthOf(account: AccountRow): CredentialHealth {
    if (!this.credentialed(account)) return "absent";
    if (this.centralCredentialInDoubt(account)) return "unverified";
    if (account.lastLoginAt != null) return "verified";
    if (this.store.getAccountLimits(account.id)?.readable === true) return "verified";
    return "unverified";
  }

  weeklyCeilingBreaches(account: AccountRow): WeeklyCeilingBreach[] {
    const ceiling = account.weeklyCeiling;
    if (ceiling == null) return [];
    const row = this.store.getAccountLimits(account.id);
    if (!row?.readable) return [];
    const now = this.now();
    const windows: Array<[WeeklyCeilingBreach["window"], number | null, number | null]> = [
      ["weekly", row.weeklyPct, row.weeklyResetsAt],
      ["fableWeekly", row.fableWeeklyPct, row.fableResetsAt],
    ];
    return windows.flatMap(([window, usedPercent, resetsAt]) =>
      usedPercent != null && usedPercent >= ceiling && (resetsAt == null || resetsAt > now) ? [{ window, usedPercent, ceiling }] : []);
  }

  weeklyCeilingBreach(account: AccountRow, model?: string): WeeklyCeilingBreach | null {
    return this.weeklyCeilingBreaches(account).find((breach) => breach.window === "weekly" || isFableModel(model)) ?? null;
  }

  /** The mirror shape of an account row: the store row plus the derived health (never stored). */
  mirrorRow(account: AccountRow): MirrorAccountRow {
    const { native: _native, ...row } = account;
    return { ...row, credentialHealth: this.credentialHealthOf(account), loginDueAt: loginDueAtOf(account), nativeLogin: this.nativeDescription(account) };
  }

  /**
   * v18 status honesty: `ok` may only be claimed for an account that HAS a
   * credential — with none anywhere the truthful status is `auth_needed`
   * (the closed vocabulary's "log in" state). `paused` / `auth_needed`
   * requests pass through. Harnesses without a recipe (the home is the
   * account) are always credentialed.
   */
  honestStatus(account: Pick<AccountRow, "harness" | "id" | "homePath">, requested: AccountStatus): AccountStatus {
    if (requested !== "ok") return requested;
    if (this.centralCredentialInDoubt(account)) return "auth_needed";
    return this.credentialed(account) ? "ok" : "auth_needed";
  }

  /**
   * The credential authority refused to vouch for this account's credential:
   * the provider rejected its refresh token (`login_required`) or the last
   * refresh has an unknown outcome (`uncertain`). The authority then owns the
   * account's `auth_needed` status and its reason.
   */
  centralCredentialInDoubt(account: Pick<AccountRow, "id">): boolean {
    const phase = this.store.getAccountCredentialAuthority(account.id)?.phase;
    return phase === "login_required" || phase === "uncertain";
  }

  /** Why `honestStatus` answered auth_needed, for the account's status reason. */
  authNeededReason(account: AccountRow): string | null {
    return this.authorityFor(account)?.inDoubtReason(account) ?? null;
  }

  /** Whether `verifyCredentials` can probe provider authentication or a required credential file. */
  hasCredentialProbe(harness: string): boolean {
    return this.credentialProbeOf(harness) !== "none";
  }

  /** The evidence a harness's credential verification lane can collect. */
  credentialProbeOf(harness: string): VerifyOutcome["probe"] {
    if (!PROBE_CAPABLE_HARNESSES.has(harness)) return "none";
    return CREDENTIAL_FILE_PROBE_HARNESSES.has(harness) ? "credential_file" : "limits";
  }

  // -------------------------------------------------------------------------
  // selection — the calibrated model over the store
  // -------------------------------------------------------------------------

  allocationScope(harness: string): string {
    return `${harness}:provider-accounts`;
  }

  allocationMode(): "shadow" | "active" {
    return this.cfg.accounts.allocationMode;
  }

  /**
   * Read-only per-node activity for Apiary aggregation. These facts come from
   * the same store reads used by admission, including queued starts,
   * undelivered mail and bound claim identities; Apiary need not infer them.
   */
  nodeActivity(harness: string): AccountNodeActivity {
    const node = this.cfg.accounts.allocationNodeId;
    const authority = this.cfg.accounts.allocationOwner;
    if (!node || !authority) throw new Error("account allocation identity is not configured");
    const observedAt = this.now();
    const registered = this.store.listAccounts({ harness });
    const activityByAccount = this.localActivities(registered.map((account) => account.id), observedAt);
    const accounts = registered.map((account) => {
      const activity = activityByAccount.get(account.id)!;
      return {
        account: account.id,
        active: activity.active,
        recent: activity.recent,
        pending: activity.pending,
        ongoingUnits: activity.ongoingUnits,
        observedClaimIds: [...activity.observedClaimIds].sort(),
      };
    });
    return {
      version: 1,
      node,
      authority,
      scope: this.allocationScope(harness),
      revision: `${node}:${this.store.lastAuditSeq()}`,
      observedAt,
      freshUntil: observedAt + this.cfg.accounts.allocationActivityFreshMs,
      accounts,
    };
  }

  /**
   * Admission requires a provider observation fresh enough for the decision,
   * including the singleton case. Provider I/O happens before the store
   * transaction; selection then uses the resulting immutable rows.
   */
  async ensureFreshAdmissionLimits(harness: string, opts: PickOptions = {}): Promise<void> {
    if (this.cfg.accounts.allocationMode === "shadow") {
      this.scheduleFreshLimits(harness, opts);
      return;
    }
    const now = this.now();
    const stale = this.candidateIdsFor(harness, opts).filter((id) => {
      const row = this.store.getAccountLimits(id);
      return !row || !row.readable || now - row.fetchedAt > this.cfg.accounts.allocationQuotaFreshMs;
    });
    if (stale.length > 0) await Promise.all(stale.map(async (id) => {
      const joined = this.admissionRefreshes.get(id);
      if (joined) return joined;
      const pending = this.refreshLimits([id]).then(() => undefined);
      this.admissionRefreshes.set(id, pending);
      try {
        await pending;
      } finally {
        if (this.admissionRefreshes.get(id) === pending) this.admissionRefreshes.delete(id);
      }
    }));
  }

  private contextIsFresh(context: AccountAllocationContext | null | undefined, scope: string, now: number): context is AccountAllocationContext {
    if (!context || context.version !== 1 || context.scope !== scope || !context.complete) return false;
    const owner = this.cfg.accounts.allocationOwner;
    if (!owner || !context.authority || typeof context.authority !== "object"
      || context.authority.node !== owner.node || context.authority.epoch !== owner.epoch) return false;
    if (!Number.isFinite(context.observedAt) || context.observedAt > now + 60_000) return false;
    if (now - context.observedAt > this.cfg.accounts.allocationActivityFreshMs) return false;
    if (typeof context.revision !== "string" || context.revision.length === 0 || context.revision.length > 128) return false;
    if (!Array.isArray(context.accounts) || context.accounts.length > 256) return false;
    const accountIds = new Set(context.accounts.map((fact) => fact.account));
    if (accountIds.size !== context.accounts.length) return false;
    const claims = new Set<string>();
    return context.accounts.every((fact) => {
      if (typeof fact.account !== "string" || fact.account.length === 0
        || ![fact.active, fact.recent, fact.pending].every((value) => Number.isSafeInteger(value) && value >= 0)
        || !Number.isFinite(fact.ongoingUnits) || fact.ongoingUnits < 0
        || (fact.observedClaimIds !== undefined && (!Array.isArray(fact.observedClaimIds) || fact.observedClaimIds.length > 256))) return false;
      for (const claimId of fact.observedClaimIds ?? []) {
        if (typeof claimId !== "string" || claimId.length === 0 || claimId.length > 128 || claims.has(claimId)) return false;
        claims.add(claimId);
      }
      return true;
    });
  }

  private localActivities(accountIds: readonly string[], now: number): Map<string, LocalAccountActivity> {
    const activities = new Map(accountIds.map((id) => [id, {
      active: 0, recent: 0, pending: 0, ongoingUnits: 0, observedClaimIds: new Set<string>(),
    }]));
    if (activities.size === 0) return activities;
    const grace = this.cfg.accounts.allocationRecentGraceMs;
    const reservationsByBee = new Map<string, AccountAdmissionReservationRow[]>();
    for (const reservation of this.store.listAccountAdmissions()) {
      const beeId = reservation.beeId;
      if (beeId === null || reservation.releasedAt !== null || !(reservation.expiresAt > now)) continue;
      const reservations = reservationsByBee.get(beeId);
      if (reservations) reservations.push(reservation);
      else reservationsByBee.set(beeId, [reservation]);
    }
    for (const bee of this.store.listBees()) {
      const runtime = this.store.currentRuntime(bee.id);
      const reservations = reservationsByBee.get(bee.id) ?? [];
      const transfer = reservations.find((reservation) => reservation.sourceAccount !== null && reservation.sourceAccount !== reservation.account
        && (runtime?.generation ?? 0) <= reservation.reconcileAfterGeneration);
      const runtimeAccount = transfer?.sourceAccount ?? bee.account;
      const activity = runtimeAccount == null ? undefined : activities.get(runtimeAccount);
      if (!activity) continue;
      const isActive = runtime?.state === "booting" || runtime?.state === "running";
      // Active runtimes are represented regardless of their pending work.
      const hasPending = !isActive && (this.store.undeliveredMessages(bee.id).length > 0
        || this.store.listCommands({ beeId: bee.id }).some((command) =>
          (command.status === "queued" || command.status === "running")
          && (command.verb === "spawn" || command.verb === "revive" || command.verb === "send_wake")));
      let represented = false;
      if (isActive && runtime) {
        activity.active += 1;
        represented = true;
        // One accepted start is one fair-share unit immediately; sessions
        // then continue accruing instead of receiving capped elapsed credit.
        activity.ongoingUnits += Math.max(1, (now - runtime.startedAt) / 3_600_000);
      } else if (hasPending) {
        activity.pending += 1;
        represented = true;
        activity.ongoingUnits += 1;
      } else {
        const latest = Math.max(runtime?.updatedAt ?? 0, bee.lastOutputAt ?? 0);
        if (latest > 0 && now - latest <= grace) {
          activity.recent += 1;
          represented = true;
          activity.ongoingUnits += Math.max(0, (grace - (now - latest)) / Math.max(1, grace));
        }
      }
      if (represented) {
        for (const reservation of reservations) {
          if (reservation.account === runtimeAccount) activity.observedClaimIds.add(reservation.id);
        }
      }
    }
    return activities;
  }

  private admissionCandidate(
    account: AccountRow,
    options: NewWorkAdmissionOptions,
    context: AccountAllocationContext | null,
    contextFresh: boolean,
    now: number,
    local: LocalAccountActivity,
  ): AccountAdmissionCandidate {
    const remote = contextFresh ? context?.accounts.find((fact) => fact.account === account.id) : undefined;
    const activity = {
      coverage: contextFresh ? "complete" as const : "unknown" as const,
      active: local.active + (remote?.active ?? 0),
      recent: local.recent + (remote?.recent ?? 0),
      pending: local.pending + (remote?.pending ?? 0),
      ongoingUnits: local.ongoingUnits + (remote?.ongoingUnits ?? 0),
    };
    const row = this.store.getAccountLimits(account.id);
    const applicableObserved = row?.readable
      ? [row.fiveHourPct, row.weeklyPct, ...(isFableModel(options.model) ? [row.fableWeeklyPct] : [])]
          .filter((value): value is number => value !== null)
      : [];
    const verifiedRestoredHeadroom = account.exhaustedAt != null
      && row?.readable === true
      && row.fetchedAt > account.exhaustedAt
      && applicableObserved.length > 0
      && applicableObserved.every((value) => value < DEFAULT_ACCOUNT_ADMISSION_POLICY.completionReservePercent);
    let eligibility: AccountAdmissionCandidate["eligibility"] = { state: "eligible" };
    if (account.status === "paused") eligibility = { state: "ineligible", reason: "paused" };
    else if (this.weeklyCeilingBreach(account, options.model)) eligibility = { state: "ineligible", reason: "ceiling" };
    else if (!this.usableForSelection(account)) eligibility = { state: "ineligible", reason: "auth" };
    else if (this.credentialHealthOf(account) !== "verified") eligibility = { state: "unknown", reason: "auth" };
    else if (account.exhaustedAt != null && now - account.exhaustedAt < this.cfg.accounts.exhaustionCoolOffMs && !verifiedRestoredHeadroom) {
      eligibility = { state: "ineligible", reason: "exhausted" };
    } else if (isFableModel(options.model) && row?.fableWeeklyPct == null) {
      eligibility = { state: "unknown", reason: "grants" };
    }
    const windows: NonNullable<AccountAdmissionCandidate["quota"]>["windows"] = [];
    const addWindow = (
      kind: "fiveHour" | "weekly" | "fableWeekly",
      usedPercent: number | null,
      resetsAt: number | null,
      measuredVelocity: number | null | undefined,
      admissionCostPercent: number,
    ) => {
      if (usedPercent == null || resetsAt == null) return;
      windows.push({
        kind,
        usedPercent,
        resetsAt,
        velocityPerHour: Math.max(measuredVelocity ?? 0, activity.active * admissionCostPercent),
        admissionCostPercent,
      });
    };
    if (row?.readable) {
      const velocities = this.velocities.get(account.id);
      addWindow("fiveHour", row.fiveHourPct, row.fiveHourResetsAt, velocities?.fiveHour, 4);
      addWindow("weekly", row.weeklyPct, row.weeklyResetsAt, velocities?.weekly, 1);
      addWindow("fableWeekly", row.fableWeeklyPct, row.fableResetsAt, velocities?.fableWeekly, 1);
    }
    const plan = row?.plan?.toLowerCase() ?? "";
    const capacityUnits = this.cfg.accounts.allocationPlanCapacityUnits[plan] ?? 1;
    const observedClaims = new Set([...local.observedClaimIds, ...(remote?.observedClaimIds ?? [])]);
    const reservations = this.store.listUnreconciledAccountAdmissions(now, {
      scope: this.allocationScope(account.harness),
      account: account.id,
    }).filter((reservation) => !observedClaims.has(reservation.id))
      .reduce((sum, reservation) => sum + reservation.units, 0);
    return {
      accountId: account.id,
      capacityUnits,
      eligibility,
      quota: row?.readable ? { fetchedAt: row.fetchedAt, windows } : null,
      activity,
      reservations,
    };
  }

  /**
   * Select and reserve NEW automatic work. Call inside the mutation's store
   * transaction: the quota/activity snapshot, weighted-fair decision, durable
   * hold, and caller's bee mutation then commit or roll back together.
   */
  admitNewWork(harness: string, options: NewWorkAdmissionOptions): NewWorkAdmission {
    const now = this.now();
    const scope = this.allocationScope(harness);
    const context = options.context ?? null;
    const contextFresh = this.contextIsFresh(context, scope, now);
    const excluded = new Set(options.excludeAccountIds ?? []);
    if (options.operation === "swap" && options.sourceAccount) excluded.add(options.sourceAccount);
    const accounts = this.store.listAccounts({ harness }).filter((account) =>
      !excluded.has(account.id) && (!options.onlyAccountIds || options.onlyAccountIds.has(account.id)));
    const activityByAccount = this.localActivities(accounts.map((account) => account.id), now);
    const candidates = accounts.map((account) => this.admissionCandidate(account, options, context, contextFresh, now, activityByAccount.get(account.id)!));
    const decision = selectAccountAdmission(candidates, {
      ...DEFAULT_ACCOUNT_ADMISSION_POLICY,
      now,
      model: options.model,
      quotaFreshMs: this.cfg.accounts.allocationQuotaFreshMs,
    });

    if (this.cfg.accounts.allocationMode === "shadow") {
      const inherited = options.onlyAccountIds?.size === 1 && (options.operation === "fork" || options.operation === "handoff")
        ? this.store.getAccount([...options.onlyAccountIds][0]!)
        : null;
      const inheritedReadiness = inherited ? this.readiness(inherited) : null;
      const legacy: PickOutcome = inherited
        ? inheritedReadiness!.ready
          ? { ok: true, account: inherited, reason: "automatic inheritance", limitsAgeMs: null, stale: false, candidates: 1 }
          : { ok: false, code: inheritedReadiness!.code === "account_paused" ? "all_paused" : inheritedReadiness!.code === "account_credential_missing" ? "no_credentials" : "auth_needed", message: inheritedReadiness!.message }
        : this.pick(harness, options);
      if (!legacy.ok) {
        const receipt: AccountAllocationReceipt = {
          version: 1, mode: "shadow", scope, revision: contextFresh ? context!.revision : null,
          observedAt: now, operation: options.operation, outcome: "wait", account: null,
          reason: `shadow:${decision.kind === "wait" ? decision.reason : "selected"}; legacy:${legacy.code}`,
          retryAt: decision.kind === "wait" ? decision.retryAt : null, candidates: decision.candidates,
        };
        const code = inheritedReadiness && !inheritedReadiness.ready
          ? inheritedReadiness.code
          : legacy.code === "auth_needed" ? "account_auth_needed" : "account_unavailable";
        return { ok: false, code, message: legacy.message, receipt };
      }
      const receipt: AccountAllocationReceipt = {
        version: 1, mode: "shadow", scope, revision: contextFresh ? context!.revision : null,
        observedAt: now, operation: options.operation, outcome: "selected", account: legacy.account.id,
        reason: `shadow:${decision.kind === "selected" ? `would_select:${decision.accountId}` : `would_wait:${decision.reason}`}; legacy:${legacy.reason}`,
        retryAt: decision.kind === "wait" ? decision.retryAt : null, candidates: decision.candidates,
      };
      this.log(`account.admission.shadow operation=${options.operation} selected=${legacy.account.id} policy=${decision.kind}${decision.kind === "wait" ? `:${decision.reason}` : `:${decision.accountId}`}`);
      return { ok: true, account: legacy.account, reason: legacy.reason, receipt, reservation: null };
    }

    if (decision.kind === "wait") {
      const receipt: AccountAllocationReceipt = {
        version: 1, mode: "active", scope, revision: contextFresh ? context!.revision : null,
        observedAt: now, operation: options.operation, outcome: "wait", account: null,
        reason: decision.reason, retryAt: decision.retryAt, candidates: decision.candidates,
      };
      this.log(`account.admission.wait operation=${options.operation} scope=${scope} reason=${decision.reason} retry_at=${decision.retryAt ?? "-"}`);
      return { ok: false, code: "account_wait", message: `Automatic account allocation is waiting: ${decision.reason}`, receipt };
    }
    const account = this.store.getAccount(decision.accountId);
    if (!account) throw new Error(`selected account disappeared: ${decision.accountId}`);
    const receipt: AccountAllocationReceipt = {
      version: 1, mode: "active", scope, revision: contextFresh ? context!.revision : null,
      observedAt: now, operation: options.operation, outcome: "selected", account: account.id,
      reason: decision.reason, retryAt: null, candidates: decision.candidates,
    };
    const reservation = this.store.reserveAccountAdmission({
      id: options.reservationId ?? randomUUID(),
      requestKey: `account-admission:${options.operation}:${options.requestKey}`,
      scope,
      account: account.id,
      sourceAccount: options.sourceAccount ?? null,
      operation: options.operation,
      units: 1,
      expiresAt: now + this.cfg.accounts.allocationReservationTtlMs,
      reconcileAfterGeneration: options.reconcileAfterGeneration ?? 0,
      receipt: options.reservationMetadata
        ? { allocation: receipt as unknown as Record<string, unknown>, ...options.reservationMetadata }
        : receipt as unknown as Record<string, unknown>,
    });
    this.log(`account.admission.selected operation=${options.operation} scope=${scope} account=${account.id} reservation=${reservation.id}`);
    return { ok: true, account, reason: decision.reason, receipt, reservation };
  }

  /** Account that owned the specific generation, even after a swap rebind. */
  accountForGeneration(bee: Pick<BeeRow, "id" | "account">, generation: number): AccountRow | null {
    const sourceAccount = this.store.getSourceAccountForGeneration(bee.id, generation);
    return this.store.getAccount(sourceAccount ?? bee.account ?? "");
  }

  /**
   * Resolve `auto` for a harness (spec 08 §Selection). Candidates: this
   * harness's accounts, not paused, credentialed, minus `excludeAccountIds`
   * (and minus recently-exhausted for rotation); accounts with an
   * auth_needed status are skipped while a healthy one exists (last resort
   * otherwise). One candidate short-circuits (no limits read). Otherwise the
   * ported selector ranks limits rows + live-bee commitments + penalty, and a
   * near-tie rotates through the per-harness cursor row. Synchronous: callers
   * may schedule stale sampling, but selection always reads the current row.
   */
  pick(harness: string, opts: PickOptions = {}): PickOutcome {
    const now = this.now();
    const registered = this.runnableAccounts(harness).filter((a) => !opts.onlyAccountIds || opts.onlyAccountIds.has(a.id));
    const unrunnable = this.unrunnableRefusal(harness, registered);
    if (unrunnable) return unrunnable;
    if (registered.length === 0) {
      return opts.onlyAccountIds
        ? { ok: false, code: "no_accounts", message: `No ${harness} account matches the allowed ids on this node` }
        : { ok: false, code: "no_accounts", message: `No ${harness} accounts registered; add one with: hive v2 account add ${harness} <label>` };
    }
    const unpaused = registered.filter((a) => a.status !== "paused");
    const pool = unpaused.filter((a) => !this.weeklyCeilingBreach(a, opts.model));
    if (pool.length === 0) {
      return {
        ok: false,
        code: "all_paused",
        message: unpaused.length === 0
          ? `Every ${harness} account is paused; unpause one with: hive v2 account unpause <account>`
          : `Every ${harness} account is paused or past its weekly ceiling; raise one with: hive account ceiling <account> <percent|off>`,
      };
    }
    // A credential FILE existing is not health: an account whose last real
    // authentication attempt failed, or whose token is expired with no
    // refresh path, must never win the pick — every bee placed on it strands
    // at /login. There is no last resort: with no usable account the pick
    // refuses with a typed code and the caller places the work elsewhere.
    const unusable: Array<{ account: AccountRow; why: string }> = [];
    let usable = 0;
    const candidates: AccountRow[] = [];
    for (const account of pool) {
      const credential = this.credentialState(account);
      if (credential === "absent") continue;
      if (this.ownedHomeRefusal(account, "writes into")) { unusable.push({ account, why: "home outside Honeybee's account homes" }); continue; }
      if (account.status === "auth_needed") { unusable.push({ account, why: "recent auth failure" }); continue; }
      if (credential !== "present") { unusable.push({ account, why: `${credential} credential` }); continue; }
      usable += 1;
      if (opts.excludeAccountIds?.has(account.id)) continue;
      if (
        opts.excludeRecentlyExhausted &&
        account.exhaustedAt != null &&
        now - account.exhaustedAt < this.cfg.accounts.exhaustionCoolOffMs
      ) continue;
      candidates.push(account);
    }
    if (candidates.length === 0) {
      if (usable > 0 && ((opts.excludeAccountIds?.size ?? 0) > 0 || opts.excludeRecentlyExhausted)) {
        return { ok: false, code: "no_untried", message: `No untried ${harness} account remains` };
      }
      if (unusable.length > 0) {
        return {
          ok: false,
          code: "auth_needed",
          message: `No ${harness} account can authenticate on this node (${unusable.map(({ account, why }) => `${account.id}: ${why}`).join(", ")}); log in with: hive account login <account>`,
        };
      }
      return { ok: false, code: "no_credentials", message: `No ${harness} account has credentials; log in with: hive v2 account login <account>` };
    }
    const eligible = candidates;
    const healthReason = unusable.length > 0
      ? `; skipped ${unusable.map(({ account, why }) => `${account.id} for ${why}`).join(", ")}`
      : "";
    // A single candidate wins regardless of usage — skip the limits read and
    // the pick bookkeeping (there is no herd to steer with one account).
    if (eligible.length === 1) {
      const only = eligible[0] as AccountRow;
      const reason = `only ${unusable.length > 0 ? "healthy " : ""}${harness} account with credentials${healthReason}`;
      this.log(`account auto → ${only.id} — ${reason}`);
      return { ok: true, account: only, reason, limitsAgeMs: null, stale: false, candidates: 1 };
    }
    // Commitments: live bees on each account (this harness only) + pending
    // pick debits; busy bees + fresh picks also drive the velocity fallback.
    const bees = this.store.listBees().filter((b) => b.agent === harness && b.account);
    const runtimes = bees.map((b) => ({ account: b.account, runtimeState: this.store.currentRuntime(b.id)?.state ?? null }));
    const commitments = accountCommitments(runtimes);
    const activeBees = accountActiveBees(runtimes);
    const rowsById = new Map<string, AccountLimitsRow>();
    for (const a of eligible) {
      const row = this.store.getAccountLimits(a.id);
      if (row) rowsById.set(a.id, row);
    }
    const scored: AutoAccountCandidate[] = eligible.map((a) => {
      const row = rowsById.get(a.id);
      const pending = prunePendingPicks(this.pendingPicks.get(a.id) ?? [], now);
      if (pending.length > 0) this.pendingPicks.set(a.id, pending);
      else this.pendingPicks.delete(a.id);
      return {
        account: { id: a.id, addedAt: a.addedAt, penalty: a.penalty },
        ...(row ? { limits: limitsFromRow(row, this.velocities.get(a.id) ?? {}) } : {}),
        commitment: (commitments.get(a.id) ?? 0) + pendingPickDebit(pending, now),
        activeBees: (activeBees.get(a.id) ?? 0) + pending.length,
        exhausted: a.exhaustedAt != null && now - a.exhaustedAt < this.cfg.accounts.exhaustionCoolOffMs,
      };
    });
    const choice = selectLeastLoadedAccount(scored, now, opts.model ? { model: opts.model } : {});
    if (!choice) return { ok: false, code: "no_credentials", message: `No ${harness} account is selectable` };
    const cursor = this.store.getSelectionCursor(harness);
    const rotated = rotateNearTie(choice, scored, cursor?.lastAccountId ?? null);
    if (rotated.cursor !== null) this.store.setSelectionCursor(harness, rotated.cursor);
    const winner = eligible.find((a) => a.id === rotated.choice.account.id) as AccountRow;
    // The HIVE-80 reservation: the next concurrent pick sees this one.
    this.pendingPicks.set(winner.id, [...(this.pendingPicks.get(winner.id) ?? []), { at: now, percent: AUTO_PICK_DEBIT_PERCENT }]);
    const reason = `${rotated.choice.reason}${healthReason}`;
    const row = rowsById.get(winner.id);
    const limitsAgeMs = row ? Math.max(0, now - row.fetchedAt) : null;
    const stale = limitsAgeMs !== null && limitsAgeMs > this.cfg.accounts.limitsStaleMs;
    const usage = autoPickUsage(rotated.choice.limits, opts.model, now);
    const freshness = limitsAgeMs === null ? "" : `, limits ${Math.round(limitsAgeMs / 60_000)} min old${stale ? " (stale)" : ""}`;
    this.log(`account auto → ${winner.id}${usage ? ` (${usage}${freshness})` : freshness ? ` (${freshness.slice(2)})` : ""} — ${reason}`);
    return { ok: true, account: winner, reason, limitsAgeMs, stale, candidates: eligible.length };
  }

  /**
   * Resolve `rr` for a harness. This deliberately ignores provider limits and
   * commitments: it walks credentialed accounts in stable registration order,
   * skipping paused/auth-failed accounts while a healthy candidate exists.
   * Its durable cursor is namespaced away from auto's near-tie cursor.
   */
  pickRoundRobin(harness: string, opts: Pick<PickOptions, "onlyAccountIds"> = {}): PickOutcome {
    const registered = this.runnableAccounts(harness).filter((a) => !opts.onlyAccountIds || opts.onlyAccountIds.has(a.id));
    const unrunnable = this.unrunnableRefusal(harness, registered);
    if (unrunnable) return unrunnable;
    if (registered.length === 0) {
      return { ok: false, code: "no_accounts", message: `No ${harness} accounts registered; add one with: hive account add ${harness} <label>` };
    }
    const unpaused = registered.filter((account) => account.status !== "paused");
    const pool = unpaused.filter((account) => !this.weeklyCeilingBreach(account));
    if (pool.length === 0) {
      return {
        ok: false,
        code: "all_paused",
        message: unpaused.length === 0
          ? `Every ${harness} account is paused; unpause one with: hive account unpause <account>`
          : `Every ${harness} account is paused or past its weekly ceiling; raise one with: hive account ceiling <account> <percent|off>`,
      };
    }
    const candidates = pool.filter((account) => this.credentialState(account) !== "absent");
    if (candidates.length === 0) {
      return { ok: false, code: "no_credentials", message: `No ${harness} account has credentials; log in with: hive account login <account>` };
    }
    const eligible = candidates.filter((account) => this.usableForSelection(account));
    const skipped = candidates.filter((account) => !this.usableForSelection(account));
    if (eligible.length === 0) {
      return {
        ok: false,
        code: "auth_needed",
        message: `No ${harness} account can authenticate on this node (${skipped.map((account) => account.id).join(", ")}); log in with: hive account login <account>`,
      };
    }
    const cursorKey = `rr:${harness}`;
    const previous = this.store.getSelectionCursor(cursorKey)?.lastAccountId ?? null;
    const previousIndex = previous == null ? -1 : eligible.findIndex((account) => account.id === previous);
    const winner = eligible[(previousIndex + 1) % eligible.length] as AccountRow;
    this.store.setSelectionCursor(cursorKey, winner.id);
    const reason = [
      previousIndex >= 0
        ? `round-robin: next after ${previous}`
        : eligible.length === 1
          ? `only ${harness} account with credentials`
          : "round-robin: first pick",
      ...(skipped.length > 0 ? [`skipped ${skipped.map((account) => account.id).join(", ")} for recent auth failure or an unusable credential`] : []),
    ].join("; ");
    this.log(`account rr → ${winner.id} — ${reason}`);
    return { ok: true, account: winner, reason, limitsAgeMs: null, stale: false, candidates: eligible.length };
  }

  /** The accounts this node can run `harness` under: all of them, or only the native one where accounts are unisolated. */
  private runnableAccounts(harness: string): AccountRow[] {
    const accounts = this.store.listAccounts({ harness }).filter((account) => !this.nativeHomeRefusal(account));
    return this.isolationRefusal(harness) ? accounts.filter((account) => this.isNative(account)) : accounts;
  }

  /** The refusal for an unisolated harness with no runnable (native) account among `runnable`, else null. */
  private unrunnableRefusal(harness: string, runnable: AccountRow[]): PickOutcome | null {
    const unisolated = this.isolationRefusal(harness);
    if (!unisolated || runnable.length > 0) return null;
    const stranded = this.nativeAccount(harness);
    const moved = stranded ? this.nativeHomeRefusal(stranded) : null;
    if (moved) return { ok: false, code: "no_accounts", message: moved };
    const native = nativeAccountRecipe(harness, this.platform);
    return { ok: false, code: "no_accounts", message: native ? `${unisolated}. Add ${native.label} with: hive account add ${harness} --native` : unisolated };
  }

  /** The candidate ids a pick would consider (for "refresh stale before pick"). */
  private candidateIdsFor(harness: string, opts: PickOptions): string[] {
    return this.store
      .listAccounts({ harness })
      .filter((a) => this.usableForSelection(a) && !this.weeklyCeilingBreach(a, opts.model) && !opts.excludeAccountIds?.has(a.id)
        && (!opts.onlyAccountIds || opts.onlyAccountIds.has(a.id)))
      .map((a) => a.id);
  }

  /**
   * Freshness policy (spec 08 "Limits"): enqueue rows older than
   * limitsStaleMs (or missing) for the harness's candidates. The spawn path
   * reads the current snapshot immediately; provider sampling stays in the
   * shared background lane and only runs when more than one candidate exists.
   */
  scheduleFreshLimits(harness: string, opts: PickOptions = {}): { scheduled: string[] } {
    const ids = this.candidateIdsFor(harness, opts);
    if (ids.length < 2) return { scheduled: [] };
    const now = this.now();
    const stale = ids.filter((id) => {
      const row = this.store.getAccountLimits(id);
      return !row || now - row.fetchedAt > this.cfg.accounts.limitsStaleMs;
    });
    if (stale.length === 0) return { scheduled: [] };
    this.enqueueLimitsRefresh(stale);
    return { scheduled: stale };
  }

  // -------------------------------------------------------------------------
  // limits — bounded in-daemon fetch
  // -------------------------------------------------------------------------

  /** Refresh limits for the given accounts (all when omitted). */
  async refreshLimits(accountIds?: string[]): Promise<AccountLimitsRow[]> {
    const ids = accountIds ?? this.store.listAccounts().map((a) => a.id);
    const out: AccountLimitsRow[] = [];
    for (const id of ids) {
      const account = this.store.getAccount(id);
      if (!account) continue;
      const healthBefore = this.credentialHealthOf(account);
      const fetched = await this.fetchOne(account);
      if (!this.store.getAccount(id)) continue; // removed mid-fetch
      const previous = this.store.getAccountLimits(id);
      // The authority's typed phase, not the probe's error text, says whether the credential is in doubt.
      const centralInDoubt = this.centralCredentialInDoubt(account);
      // A harness with no probe source (`unsupported`) can still hold a
      // readable row a runtime observed (Muse usage/changed): the probe has
      // nothing newer to say about it, so the observation stays, dated.
      const keepLastGood = previous?.readable === true
        && !fetched.readable
        && !centralInDoubt
        && (fetched.unreadableReason === "provider_error" || fetched.unreadableReason === "timeout"
          || fetched.unreadableReason === "refresh_deferred" || fetched.unreadableReason === "unsupported");
      const credentialProbePassed = CREDENTIAL_FILE_PROBE_HARNESSES.has(account.harness)
        && !fetched.readable
        && fetched.unreadableReason === "unsupported";
      // A transient sampling failure is not evidence that the provider's last
      // readable snapshot became false, and neither is a refresh stood down to
      // a live runtime that owns the rotating chain. Keep its fetchedAt and
      // windows so the mirror and selector honestly expose stale,
      // last-known-good data. Real auth failures still replace the row and
      // drive auth_needed below.
      if (!keepLastGood && previous?.readable === true && fetched.readable) {
        this.velocities.set(id, this.measureVelocities(previous, fetched));
      }
      const row = keepLastGood ? previous! : this.store.putAccountLimits(id, fetched);
      // The probe is the authentication check account health keys on: a REAL
      // auth failure sets auth_needed; a readable answer or agy's successful
      // token-file probe is contrary evidence. The agy limits row stays
      // unsupported and its credential health stays unverified.
      // The probe awaited the provider: judge the account as it is NOW (an
      // operator or lease may have paused it meanwhile; the store keeps a pause
      // through auth-health updates either way).
      const current = this.store.getAccount(id) ?? account;
      if (centralInDoubt && current.status === "auth_needed") {
        // The authority already recorded why; a probe must not replace that reason with its own wording.
      } else if (!fetched.readable && fetched.error && fetched.unreadableReason === "auth_failed") {
        const reason = centralInDoubt ? fetched.error : `limits probe: ${fetched.error.slice(0, 200)}`;
        if (this.store.setAccountStatus(id, current.status === "paused" ? "paused" : "auth_needed", reason).applied) {
          this.log(`account.auth_needed account=${id} by=limits_probe`);
        }
      } else if ((fetched.readable || credentialProbePassed) && current.status === "auth_needed") {
        const probe = credentialProbePassed ? "credential_probe" : "limits_probe";
        this.store.setAccountStatus(id, "ok", `${probe} authenticated`);
        this.log(`account.auth_ok account=${id} by=${probe}`);
      }
      if (fetched.readable || credentialProbePassed) this.onCredentialValidated(id, "limits_probe");
      // v18: the probe is validation evidence the MIRROR must see. A status
      // flip above already re-published the row; otherwise (an `ok`
      // unverified import that just proved itself) re-publish it explicitly
      // so `credentialHealth` is re-derived at emit — no stored health field.
      const after = this.store.getAccount(id);
      if (after) {
        const healthAfter = this.credentialHealthOf(after);
        if (healthAfter !== healthBefore && after.updatedAt === account.updatedAt && after.status === account.status) {
          this.store.touchAccount(id, `credential health ${healthBefore} → ${healthAfter} by limits probe`);
          this.log(`account.credential_health account=${id} ${healthBefore}→${healthAfter} by=limits_probe`);
        }
      }
      if (keepLastGood) {
        this.log(`account.limits.transient_failure account=${id} reason=${fetched.unreadableReason} kept_fetched_at=${row.fetchedAt} error=${JSON.stringify(fetched.error ?? null)}`);
      }
      this.log(`account.limits account=${id} readable=${row.readable}${row.readable ? ` weekly=${row.weeklyPct ?? "-"} 5h=${row.fiveHourPct ?? "-"}` : ` error=${JSON.stringify(row.error)}`}`);
      out.push(row);
    }
    return out;
  }

  /**
   * Subscription usage a runtime observed on its own provider responses
   * (Muse MSP usage/changed or a quota-exhausted turn) → the account's limits
   * row, dated when it was observed. An observation never replaces a newer
   * row, except the `unsupported` placeholder a probe writes when it has no
   * source; a duplicate (journal replay) is a quiet no-op.
   */
  observeLimits(account: AccountRow, ev: { observedAt: number; usage?: Record<string, unknown>; quota?: Record<string, unknown> }): AccountLimitsRow | null {
    if (account.harness !== "muse") return null;
    const previous = this.store.getAccountLimits(account.id);
    const input = ev.usage ? parseMuseUsage(ev.usage) : ev.quota ? museQuotaLimits(previous, ev.quota, ev.observedAt) : null;
    if (!input) {
      this.log(`account.limits.observed_skip account=${account.id} reason=${ev.usage ? "no_window" : "no_matching_window"}`);
      return null;
    }
    const observedAt = input.fetchedAt!;
    if (previous && previous.fetchedAt >= observedAt && previous.unreadableReason !== "unsupported") return null;
    if (previous?.readable) this.velocities.set(account.id, this.measureVelocities(previous, input, observedAt));
    const row = this.store.putAccountLimits(account.id, input);
    this.log(`account.limits account=${account.id} readable=true observed=${ev.usage ? "usage" : "quota"} plan=${JSON.stringify(row.plan)} weekly=${row.weeklyPct ?? "-"} 5h=${row.fiveHourPct ?? "-"} at=${observedAt}`);
    return row;
  }

  async resetLimits(account: AccountRow, idempotencyKey: string, creditId?: string): Promise<{ outcome: CodexResetOutcome; limits: AccountLimitsRow }> {
    this.assertLocalAccount(account);
    if (account.harness !== "codex") throw new ResetLimitsRefusal("harness_mismatch", "account.resetLimits is only supported for Codex accounts");
    const activated = activateHomeIfEmpty(account.harness, account.homePath, this.vaultDirOf(account), { yolo: true });
    if (activated.activated) this.log(`account.activate account=${account.id} home=${account.homePath} copied=${activated.copied.join(",")} by=limits_reset`);
    const result = await this.fetchers.codexResetLimits(account.homePath, idempotencyKey, creditId);
    if (!result.ok) throw new ResetLimitsRefusal(result.code, result.error);
    const input = parseCodexRateLimits(result.limits);
    if (!input.readable) throw new ResetLimitsRefusal("provider_outcome_uncertain", input.error ?? "refreshed Codex limits are unreadable");
    return { outcome: result.outcome, limits: this.store.putAccountLimits(account.id, input) };
  }

  /** Per-window velocity between the stored row and the snapshot about to replace it. */
  private measureVelocities(previous: AccountLimitsRow, fetched: PutAccountLimitsInput, now: number = this.now()): WindowVelocities {
    const measure = (prevPct: number | null, prevReset: number | null, next: PutAccountLimitsInput["weekly"]): number | null => {
      if (prevPct === null || !next) return null;
      return measureWindowVelocity(
        { usedPercent: prevPct, resetsAt: prevReset, fetchedAt: previous.fetchedAt },
        { usedPercent: next.usedPercent, resetsAt: next.resetsAt ?? null, fetchedAt: now },
      );
    };
    return {
      fiveHour: measure(previous.fiveHourPct, previous.fiveHourResetsAt, fetched.fiveHour),
      weekly: measure(previous.weeklyPct, previous.weeklyResetsAt, fetched.weekly),
      fableWeekly: measure(previous.fableWeeklyPct, previous.fableResetsAt, fetched.fableWeekly),
    };
  }

  /** Measured window velocities for an account (tests + the mirror), if any. */
  velocitiesOf(accountId: string): WindowVelocities | undefined {
    return this.velocities.get(accountId);
  }

  /** One account's limits via its harness's transport; never throws (an unreadable row instead). */
  private async fetchOne(account: AccountRow): Promise<PutAccountLimitsInput> {
    if (account.harness === "codex") {
      const joined = this.codexFetches.get(account.homePath);
      if (joined) return joined;
      const pending = this.fetchOneBounded(account);
      this.codexFetches.set(account.homePath, pending);
      try {
        return await pending;
      } finally {
        if (this.codexFetches.get(account.homePath) === pending) this.codexFetches.delete(account.homePath);
      }
    }
    return this.fetchOneBounded(account);
  }

  private async fetchOneBounded(account: AccountRow): Promise<PutAccountLimitsInput> {
    const timeout = this.cfg.accounts.limitsFetchTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    try {
      const attempt = this.fetchByHarness(account);
      const bounded = new Promise<PutAccountLimitsInput>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`limits fetch timed out after ${timeout}ms`)), timeout);
        timer.unref();
      });
      return await Promise.race([attempt, bounded]);
    } catch (err) {
      const error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      return {
        readable: false,
        unreadableReason: /timed out|timeout/i.test(error)
          ? "timeout"
          : isAuthFailureLimitsError(error)
            ? "auth_failed"
            : "provider_error",
        error,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async fetchByHarness(account: AccountRow): Promise<PutAccountLimitsInput> {
    const authorityPhase = this.authorityFor(account)?.status(account)?.phase;
    if (authorityPhase === "handing_off" || authorityPhase === "adopting") return { readable: false, unreadableReason: "provider_error", error: "Credential ownership is changing; existing access remains usable." };
    if (account.source !== "leased" && this.store.credentialAuthorityIsDemoted(account.id) && !this.authorityFor(account)?.enabled(account)) return { readable: false, unreadableReason: "auth_failed", error: "Authority transferred; request an access-only lease from the new authority." };
    switch (account.harness) {
      case "claude": {
        if (this.authorityFor(account)?.enabled(account)) {
          try { await this.authorityFor(account)!.ensure(account, CLAUDE_MIN_SHIP_TTL_MS); }
          catch (error) {
            if (!(error instanceof CredentialAuthorityError)) throw error;
            // The authority's typed phase decides: only `ready` may keep last-good limits.
            const settled = error.reason !== "operation_in_progress";
            const usable = this.authorityFor(account)!.status(account)?.phase === "ready";
            return { readable: false, unreadableReason: settled && !usable ? "auth_failed" : "provider_error", error: error.message };
          }
        }
        let credential = await this.freshestClaudeCredential(account);
        if (!credential) {
          return { readable: false, unreadableReason: "auth_expired", error: "no OAuth token found in home, keychain, or vault" };
        }
        if (credential.expiresAt <= this.now()) {
          if (account.source === "leased") return { readable: false, unreadableReason: "auth_expired", error: "Leased access expired; request renewal from its authority." };
          const refreshed = await this.refreshClaudeCredential(account);
          if (refreshed.kind === "ok") credential = refreshed.credential;
          else if (refreshed.kind === "live_runtime") {
            return { readable: false, unreadableReason: "refresh_deferred", error: "OAuth token expired; a healthy running Claude owns refresh for this account" };
          } else if (refreshed.kind === "no_refresh_token") {
            return { readable: false, unreadableReason: "auth_expired", error: "OAuth token expired and has no refresh token; log in: hive v2 account login " + account.id };
          } else if (refreshed.kind === "temporary") {
            // Uncertain: the refresh token may still be valid. Keep last-good
            // (provider_error is a transient reason) and retry; never a login.
            return { readable: false, unreadableReason: "provider_error", error: "OAuth refresh temporarily failed (" + refreshed.detail + "); will retry" };
          } else {
            return { readable: false, unreadableReason: "auth_failed", error: "OAuth refresh failed; log in: hive v2 account login " + account.id };
          }
        }
        const usage = await this.fetchers.claudeUsage(credential.accessToken);
        return parseClaudeUsage(usage, credential.subscriptionType ?? null);
      }
      case "codex": {
        if (this.codexCredentials.enabled(account)) {
          try { await this.codexCredentials.ensure(account, CODEX_MIN_SHIP_TTL_MS); }
          catch (error) {
            if (!(error instanceof CredentialAuthorityError)) throw error;
            const settled = error.reason !== "operation_in_progress";
            const usable = this.codexCredentials.status(account)?.phase === "ready";
            return { readable: false, unreadableReason: settled && !usable ? "auth_failed" : "provider_error", error: error.message };
          }
        }
        // `codex app-server` reads CODEX_HOME only: an imported credential
        // still sits in the vault until the first spawn activates the home.
        // Activate the EMPTY home now (the identical rule the spawn path
        // applies; a populated home is untouched) so the probe sees it.
        const activated = activateHomeIfEmpty(account.harness, account.homePath, this.vaultDirOf(account), { yolo: true });
        if (activated.activated) this.log(`account.activate account=${account.id} home=${account.homePath} copied=${activated.copied.join(",")} by=limits_probe`);
        const result = await this.fetchers.codexRateLimits(account.homePath);
        if (!result.ok) return { readable: false, unreadableReason: result.unreadableReason, error: result.error };
        return parseCodexRateLimits(result.limits);
      }
      case "grok":
      case "kimi":
      case "cursor":
      case "opencode":
        return this.fetchSecondaryProvider(account);
      case "agy":
        return this.credentialed(account)
          ? { readable: false, unreadableReason: "unsupported", error: "agy has no limits source" }
          : { readable: false, unreadableReason: "auth_failed", error: "agy OAuth token file is missing from the account home and vault" };
      case "muse": {
        // Muse has no usage probe: MSP usage/read reports only what one
        // process observed on its own model calls.
        const state = this.credentialState(account);
        return state === "present"
          ? { readable: false, unreadableReason: "unsupported", error: "muse has no limits source" }
          : { readable: false, unreadableReason: "auth_failed", error: `muse credential is ${state} in the account home and vault` };
      }
      default:
        return { readable: false, unreadableReason: "unsupported", error: `${account.harness} has no limits source` };
    }
  }

  private async fetchSecondaryProvider(account: AccountRow): Promise<PutAccountLimitsInput> {
    if (this.authorityFor(account)?.enabled(account)) {
      try { await this.authorityFor(account)!.ensure(account, CLAUDE_MIN_SHIP_TTL_MS); }
      catch (error) {
        if (!(error instanceof CredentialAuthorityError)) throw error;
        const settled = error.reason !== "operation_in_progress";
        const usable = this.authorityFor(account)!.status(account)?.phase === "ready";
        return { readable: false, unreadableReason: settled && !usable ? "auth_failed" : "provider_error", error: error.message };
      }
    }
    const joined = this.secondaryProviderFetches.get(account.id);
    if (joined) return joined;
    const pending = fetchSecondaryProviderLimits({
      account,
      vaultDir: this.vaultDirOf(account),
      now: this.now(),
      allowCredentialRefresh: account.source !== "leased" && !this.authorityFor(account)?.enabled(account) && !this.hasLiveRuntime(account.id),
      http: this.providerHttp,
    });
    this.secondaryProviderFetches.set(account.id, pending);
    try {
      return await pending;
    } finally {
      if (this.secondaryProviderFetches.get(account.id) === pending) this.secondaryProviderFetches.delete(account.id);
    }
  }

  /**
   * The freshest claude OAuth credential for the account: the HOME's
   * .credentials.json and Keychain item (the live chain, refreshed on use)
   * and the vault snapshot, by expiresAt. Location is the account's own home
   * — no cross-home candidate pool, no identity arbitration (one account =
   * one home in v2).
   */
  private async freshestClaudeCredential(account: AccountRow, strictKeychain?: KeychainState): Promise<ClaudeCredential | null> {
    if (this.authorityFor(account)?.enabled(account)) {
      const document = this.authorityFor(account)!.document(account);
      const credential = parseClaudeCredentials(JSON.stringify(document));
      if (!credential) return null;
      return { ...credential, document, oauth: document.claudeAiOauth as Record<string, unknown> };
    }
    const candidates: ClaudeCredential[] = [];
    const push = (raw: string | null) => {
      const parsed = parseClaudeCredentials(raw);
      if (!parsed || !raw) return;
      try {
        const document = JSON.parse(raw) as Record<string, unknown>;
        const oauth = document.claudeAiOauth;
        if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) return;
        candidates.push({ ...parsed, document, oauth: oauth as Record<string, unknown> });
      } catch {
        // parseClaudeCredentials already rejects malformed documents; defensive only.
      }
    };
    push(readIfFile(join(account.homePath, ".credentials.json")));
    push(strictKeychain
      ? strictKeychain.status === "present" ? strictKeychain.raw : null
      : await this.keychainReader(account.homePath).catch(() => null));
    push(readIfFile(join(this.vaultDirOf(account), ".credentials.json")));
    candidates.sort((a, b) => b.expiresAt - a.expiresAt);
    return candidates[0] ?? null;
  }

  private hasLiveRuntime(accountId: string): boolean {
    return this.store.listBees().some((bee) => {
      if (bee.account !== accountId) return false;
      const runtime = this.store.currentRuntime(bee.id);
      return runtime !== null && runtime.state !== "stopped";
    });
  }

  /**
   * A live runtime owns the rotating refresh chain only while it can still
   * authenticate. A session that has itself raised `auth_needed` (its access
   * token died server-side and it cannot refresh) is NOT a refresh owner:
   * deferring to it strands the whole account. HIVE-2 field incident: two
   * sessions on one account both failed auth, stayed alive, and the daemon
   * deferred refresh to them indefinitely. Excluding unhealthy sessions here
   * lets the daemon take over the refresh itself when no healthy session
   * remains.
   */
  private hasHealthyLiveRuntime(accountId: string): boolean {
    return this.store.listBees().some((bee) => {
      if (bee.account !== accountId) return false;
      const runtime = this.store.currentRuntime(bee.id);
      if (runtime === null || runtime.state === "stopped") return false;
      return !this.store.activeFlags(bee.id).some((flag) => flag.flag === "auth_needed");
    });
  }

  /**
   * Coordinated per-account Claude OAuth recovery (HIVE-2). Enqueues the
   * account into the single-flight background limits lane, which: re-reads the
   * freshest credential, refreshes it through the daemon's own OAuth refresher
   * when expired (no longer deferred to a session that has itself failed
   * auth), probes the result, and transitions status `ok` / `auth_needed` from
   * the probe's verdict. Idempotent — a caller joins an in-flight recovery for
   * the same account; competing refreshes cannot race (the per-account
   * single-flight in refreshClaudeCredential). Requesting login is left to the
   * probe: only a rejected/absent refresh drives `auth_needed`.
   */
  scheduleClaudeRecovery(accountId: string): void {
    const account = this.store.getAccount(accountId);
    if (!account || account.harness !== "claude") return;
    this.log(`account.recover account=${accountId} lane=limits`);
    this.enqueueLimitsRefresh([accountId]);
  }

  /**
   * Boot/restart: re-attempt coordinated recovery for every Claude account
   * left `auth_needed`, so a daemon restart mid-incident does not leave an
   * account stranded until the next periodic sweep.
   */
  scheduleRecoveryForAuthNeededClaude(): void {
    const ids = this.store
      .listAccounts({ harness: "claude" })
      .filter((account) => account.status === "auth_needed")
      .map((account) => account.id);
    if (ids.length === 0) return;
    this.log(`account.recover.boot count=${ids.length}`);
    this.enqueueLimitsRefresh(ids);
  }

  /**
   * Sync freshness of the account's on-disk Claude credential (home then
   * vault; the keychain is async and deliberately skipped here). The daemon's
   * flag policy uses this to preserve a freshly-refreshed credential against a
   * DELAYED `auth_needed` from an older session: a still-valid token means the
   * failure is likely stale, so the account is verified via a coordinated
   * recovery probe rather than blindly flipped to `auth_needed`.
   */
  claudeCredentialFresh(account: Pick<AccountRow, "harness" | "homePath" | "id">): boolean {
    if (account.harness !== "claude") return false;
    for (const path of [join(account.homePath, ".credentials.json"), join(this.vaultDirOf(account), ".credentials.json")]) {
      const parsed = parseClaudeCredentials(readIfFile(path));
      if (parsed && parsed.expiresAt > this.now()) return true;
    }
    return false;
  }

  /**
   * Rotate one expired Claude chain exactly once and persist the new chain to
   * the account's vault backup, Keychain item, and only home. `minTtlMs` is
   * the freshness floor the caller needs (the lease mint's ship floor); the
   * default 0 keeps the limits path's "expired means expired" behavior.
   *
   * A healthy running Claude owns its own refresh. Without
   * `deferralDeadlineMs` the daemon defers to it for good (the limits path).
   * With it (the lease mint) the daemon defers only while the token has more
   * than that TTL left, then refreshes itself. Either way the rotation runs
   * under Claude Code's refresh lock, so a running Claude sees a sibling's
   * refresh, never a consumed refresh token.
   */
  private async refreshClaudeCredential(account: AccountRow, minTtlMs = 0, deferralDeadlineMs?: number): Promise<ClaudeRefreshOutcome> {
    this.assertLocalAccount(account);
    if (this.store.credentialAuthorityIsDemoted(account.id) && !this.authorityFor(account)?.enabled(account)) return { kind: "no_refresh_token" };
    if (this.authorityFor(account)?.enabled(account)) {
      await this.authorityFor(account)!.ensure(account, minTtlMs);
      const credential = await this.freshestClaudeCredential(account);
      return credential ? { kind: "ok", credential } : { kind: "no_refresh_token" };
    }
    if (this.authorityFor(account)?.busy(account)) return { kind: "temporary", detail: "credential ownership is changing" };
    const takesOverFromRunningClaude = deferralDeadlineMs !== undefined;
    for (let flight = this.claudeRefreshes.get(account.id); flight; flight = this.claudeRefreshes.get(account.id)) {
      if (flight.takesOverFromRunningClaude || !takesOverFromRunningClaude) return flight.promise;
      await flight.promise.catch(() => undefined);
    }
    const promise = this.refreshClaudeCredentialOnce(account, minTtlMs, deferralDeadlineMs).finally(() => {
      if (this.claudeRefreshes.get(account.id)?.promise === promise) this.claudeRefreshes.delete(account.id);
    });
    this.claudeRefreshes.set(account.id, { takesOverFromRunningClaude, promise });
    return promise;
  }

  private async refreshClaudeCredentialOnce(account: AccountRow, minTtlMs: number, deferralDeadlineMs: number | undefined): Promise<ClaudeRefreshOutcome> {
    // Defer only to a HEALTHY live runtime (one not itself blocked on
    // auth_needed): a session that has failed authentication cannot rotate
    // the chain, so the daemon must not defer to it (HIVE-2).
    const runningClaude = this.hasHealthyLiveRuntime(account.id);
    if (runningClaude) {
      if (deferralDeadlineMs === undefined) return { kind: "live_runtime" };
      const visible = await this.freshestClaudeCredential(account);
      if (visible && visible.expiresAt - this.now() > minTtlMs) return { kind: "ok", credential: visible };
      if (!visible || visible.expiresAt - this.now() > deferralDeadlineMs) return { kind: "live_runtime" };
    }
    let locked;
    try {
      locked = await withClaudeRefreshLock(account.homePath, () => this.rotateClaudeChain(account, minTtlMs, runningClaude));
    } catch (err) {
      const detail = (err instanceof Error ? err.message : String(err)).slice(0, 200);
      this.log(`account.refresh.temporary account=${account.id} detail=${JSON.stringify(detail)}`);
      return { kind: "temporary", detail };
    }
    if (!locked.acquired) {
      this.log(`account.refresh.lock_contended account=${account.id}`);
      return { kind: "temporary", detail: "another Claude process holds a Claude Code credential lock" };
    }
    return locked.value;
  }

  private async rotateClaudeChain(account: AccountRow, minTtlMs: number, runningClaude: boolean): Promise<ClaudeRefreshOutcome> {
    // Claude processes read the Keychain item first and refresh into it
    // alone, leaving a consumed refresh token in the home file and vault: the
    // chain is rotated only from a Keychain read that is known good.
    const keychain = await this.keychainStateReader(account.homePath);
    if (keychain.status === "unreadable") return { kind: "temporary", detail: "the account Keychain is unreadable" };
    // Check for newer credentials first: re-read inside the lock — another
    // limits caller or a running Claude may have advanced the chain after
    // the first read.
    const credential = await this.freshestClaudeCredential(account, keychain);
    if (credential && credential.expiresAt - this.now() > minTtlMs) return { kind: "ok", credential };
    if (!credential?.refreshToken) return { kind: "no_refresh_token" };
    let result: ClaudeRefreshResult;
    try {
      result = await this.fetchers.claudeRefresh(credential.refreshToken);
    } catch (err) {
      result = { kind: "unknown_outcome", description: sanitizeProviderText(err instanceof Error ? err.message : String(err), [credential.refreshToken]) ?? "transport failed" };
    }
    if (result.kind === "rejected") {
      this.log(`account.refresh.rejected account=${account.id} reason=${JSON.stringify(describeRefreshFailure(result))}`);
      return { kind: "rejected" };
    }
    if (result.kind !== "success") {
      const detail = `${result.kind}: ${describeRefreshFailure(result)}`;
      this.log(`account.refresh.temporary account=${account.id} detail=${JSON.stringify(detail)}`);
      return { kind: "temporary", detail };
    }
    const refreshed = result.token;
    const oauth: Record<string, unknown> = {
      ...credential.oauth,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
      ...(refreshed.refreshTokenExpiresAt !== undefined ? { refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt } : {}),
      ...(refreshed.scopes ? { scopes: refreshed.scopes } : {}),
    };
    const document = { ...credential.document, claudeAiOauth: oauth };
    const raw = JSON.stringify(document);
    const keychainRaw = JSON.stringify({ ...document, ...keychainDocument(keychain), claudeAiOauth: oauth });
    // The home file's mtime is what tells a running Claude to drop its cached
    // credential, so it is written last, after the stores it will re-read.
    mkdirSync(this.vaultDirOf(account), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(join(this.vaultDirOf(account), ".credentials.json"), raw);
    let keychainWritten = false;
    const keychainAttempts = keychain.status === "present" ? CLAUDE_KEYCHAIN_PUBLISH_ATTEMPTS : 1;
    for (let attempt = 0; attempt < keychainAttempts && !keychainWritten; attempt += 1) {
      keychainWritten = await this.keychainWriter(account.homePath, keychainRaw).catch(() => false);
    }
    atomicWriteFileSync(join(account.homePath, ".credentials.json"), raw);
    if (keychainWritten) this.claudeKeychainRepairs.delete(account.id);
    else {
      this.claudeKeychainRepairs.set(account.id, this.now() + CLAUDE_KEYCHAIN_REPAIR_RETRY_MS);
      this.log(`account.refresh.keychain_degraded account=${account.id} running_claude=${runningClaude}`);
    }
    if (refreshed.refreshTokenExpiresAt !== undefined) this.store.setAccountRefreshTokenExpiry(account.id, refreshed.refreshTokenExpiresAt, "native credential refreshed");
    this.log(`account.refresh account=${account.id} persisted=home,vault keychain=${keychainWritten} running_claude=${runningClaude}`);
    this.onCredentialValidated(account.id, "refresh");
    return {
      kind: "ok",
      credential: {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
        ...(credential.subscriptionType ? { subscriptionType: credential.subscriptionType } : {}),
        document,
        oauth,
      },
    };
  }

  claudeKeychainRepairTick(): Promise<void> | null {
    if (this.claudeKeychainRepairFlight) return this.claudeKeychainRepairFlight;
    const now = this.now();
    const due = [...this.claudeKeychainRepairs].filter(([, at]) => at <= now);
    if (due.length === 0) return null;
    this.claudeKeychainRepairFlight = (async () => {
      for (const [accountId, dueAt] of due) {
        const account = this.store.getAccount(accountId);
        const outcome = account ? await this.republishClaudeKeychain(account).catch(() => "retry" as const) : "current";
        if (this.claudeKeychainRepairs.get(accountId) !== dueAt) continue;
        if (outcome === "retry") this.claudeKeychainRepairs.set(accountId, this.now() + CLAUDE_KEYCHAIN_REPAIR_RETRY_MS);
        else this.claudeKeychainRepairs.delete(accountId);
      }
    })()
      .catch((err) => this.log(`account.refresh.keychain_repair_error ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        this.claudeKeychainRepairFlight = null;
      });
    return this.claudeKeychainRepairFlight;
  }

  private async republishClaudeKeychain(account: AccountRow): Promise<"repaired" | "current" | "retry"> {
    if (this.authorityFor(account)?.enabled(account) || this.authorityFor(account)?.busy(account)) return "current";
    const homeFile = join(account.homePath, ".credentials.json");
    const locked = await withClaudeRefreshLock(account.homePath, async () => {
      const raw = readIfFile(homeFile);
      if (raw === null || raw !== readIfFile(join(this.vaultDirOf(account), ".credentials.json"))) return "current" as const;
      const rotated = parseClaudeCredentials(raw);
      const keychain = await this.keychainStateReader(account.homePath);
      if (keychain.status === "unreadable") return "retry" as const;
      if (!rotated || keychain.status !== "present") return "current" as const;
      const published = parseClaudeCredentials(keychain.raw);
      if (published && published.expiresAt >= rotated.expiresAt) return "current" as const;
      const document = JSON.parse(raw) as Record<string, unknown>;
      const keychainRaw = JSON.stringify({ ...document, ...keychainDocument(keychain), claudeAiOauth: document.claudeAiOauth });
      if (!(await this.keychainWriter(account.homePath, keychainRaw).catch(() => false))) return "retry" as const;
      atomicWriteFileSync(homeFile, raw);
      return "repaired" as const;
    });
    const outcome = locked.acquired ? locked.value : "retry";
    if (outcome === "repaired") this.log(`account.refresh.keychain_repaired account=${account.id}`);
    return outcome;
  }

  /**
   * v18: verify credentials off the caller path through the shared background
   * lane. Provider-backed probes read limits; agy checks its required OAuth
   * token and leaves limits unsupported. The ids actually queued are returned.
   */
  scheduleVerification(accountIds: readonly string[]): string[] {
    const ids = accountIds.filter((id) => {
      const account = this.store.getAccount(id);
      return account !== null && this.hasCredentialProbe(account.harness);
    });
    if (ids.length > 0) this.enqueueLimitsRefresh(ids);
    return ids;
  }

  /**
   * v18: `account.verify` runs the cheapest probe the harness has. A provider
   * limits read can verify a credential. agy's file probe can prove only that
   * its required token is present or absent, so a present imported token stays
   * unverified until login records fresh evidence.
   */
  async verifyCredentials(account: AccountRow): Promise<VerifyOutcome> {
    const probe = this.credentialProbeOf(account.harness);
    if (!this.credentialed(account)) {
      const updated = this.store.setAccountStatus(
        account.id,
        account.status === "paused" ? "paused" : "auth_needed",
        "account verify: primary credential is absent",
      );
      if (updated.applied) this.log(`account.auth_needed account=${account.id} by=account_verify`);
      return {
        account: updated.account,
        outcome: "absent",
        probe: probe === "credential_file" ? probe : "none",
        limits: null,
      };
    }
    if (probe === "none") {
      return { account, outcome: this.credentialHealthOf(account) === "verified" ? "verified" : "unverified", probe: "none", limits: this.store.getAccountLimits(account.id) };
    }
    const [limits] = await this.refreshLimits([account.id]);
    const after = this.store.getAccount(account.id) ?? account;
    const outcome: VerifyOutcome["outcome"] = after.status === "auth_needed"
      ? "auth_needed"
      : this.credentialHealthOf(after) === "verified"
        ? "verified"
        : "unverified";
    this.log(`account.verify account=${account.id} outcome=${outcome} readable=${limits?.readable ?? "-"}${limits && !limits.readable ? ` reason=${limits.unreadableReason}` : ""}`);
    return { account: after, outcome, probe, limits: probe === "credential_file" ? null : limits ?? null };
  }

  // -------------------------------------------------------------------------
  // v19: account.lease — the credential-lease mint (RN7a)
  // -------------------------------------------------------------------------

  /**
   * Whether the account's local refresher is mid-rotation RIGHT NOW: the
   * claude OAuth single-flight, a secondary-provider read (grok/kimi rotate
   * their refresh tokens inside that read), or a codex app-server probe
   * against the account's home (codex may rotate auth.json in place at turn
   * start). A lease minted while the chain is rotating could ship a token the
   * rotation is about to replace — the mint refuses instead (retryable).
   */
  refreshBusy(account: Pick<AccountRow, "id" | "homePath">): boolean {
    return this.claudeRefreshes.has(account.id) || this.secondaryProviderFetches.has(account.id) || this.codexFetches.has(account.homePath);
  }

  /**
   * Mint the SHORT-LIVED, refresh-blanked credential lease for `account`
   * (spec: credential-leases.md; validated by docs/RN7A_EXPERIMENTS.md).
   * Never returns more than this single account's primary credential, always
   * with every OAuth refresh-token field blanked — the vault/home chain stays
   * the sole holder of the real refresh tokens. Single-flight per account
   * (concurrent callers join); refused while the account's refresher is
   * mid-rotation. SENSITIVE: the return value is the ONLY place secret bytes
   * appear — callers must never log, audit, or persist it.
   */
  async mintLease(account: AccountRow, opts: LeaseOptions = {}): Promise<EphemeralCredential> {
    this.assertLocalAccount(account);
    if (this.store.credentialAuthorityIsDemoted(account.id) && !this.authorityFor(account)?.enabled(account)) throw new RpcError("credential_handoff_decided", "Authority transferred; this daemon cannot mint or rotate a lease for this account.");
    const joined = this.leaseMints.get(account.id);
    if (joined) return joined;
    const pending = this.mintLeaseFresh(account, opts);
    this.leaseMints.set(account.id, pending);
    try {
      return await pending;
    } finally {
      if (this.leaseMints.get(account.id) === pending) this.leaseMints.delete(account.id);
    }
  }

  private async mintLeaseFresh(account: AccountRow, opts: LeaseOptions): Promise<EphemeralCredential> {
    const native = this.nativeRefusal(account);
    if (native) throw new LeaseRefusal("lease_unsupported", native);
    if (this.refreshBusy(account) && !this.authorityFor(account)?.enabled(account)) {
      throw new LeaseRefusal("lease_unavailable", `account ${account.id}'s credential refresher is mid-rotation; retry shortly`);
    }
    const lease = await this.mintLeaseByHarness(account, opts);
    // Secret-free by construction: counts, note, and expiry only.
    this.log(
      `account.lease account=${account.id} harness=${account.harness} files=${lease.files.length}` +
        ` env=${Object.keys(lease.env ?? {}).length} exp=${lease.expiresAt !== undefined ? new Date(lease.expiresAt * 1000).toISOString() : "-"}`,
    );
    const authority = this.authorityFor(account);
    if (!authority?.enabled(account)) return lease;
    try {
      const central = authority.status(account);
      const primary = this.leaseMaterialCodecs.get(account.harness)?.primaryFile;
      const file = lease.files.find(value => value.homeRelPath === primary);
      const shipped = file ? authority.parseDocument(JSON.parse(Buffer.from(file.contentB64, "base64").toString("utf8"))) : null;
      const owned = authority.parseDocument(authority.document(account));
      const expiryUsable = account.harness === "muse" ? lease.expiresAt !== undefined && lease.expiresAt * 1000 > this.now() && owned !== null && lease.expiresAt * 1000 <= owned.expiresAt : shipped !== null && shipped.expiresAt > this.now();
      if (!owned || !shipped || !expiryUsable || shipped.accessToken !== owned.accessToken) throw new LeaseRefusal("lease_unavailable", "Central credential changed during lease mint; retry for the current material.");
      const scoped = { ...lease, ...(central?.authorityInstanceId !== undefined ? { authorityInstanceId: central.authorityInstanceId } : {}) };
      return central?.phase === "ready" ? { ...scoped, generation: central.generation } : scoped;
    } catch {
      throw new LeaseRefusal("lease_unavailable", "Central credential changed during lease mint; retry for the current material.");
    }
  }

  private mintLeaseByHarness(account: AccountRow, opts: LeaseOptions): Promise<EphemeralCredential> {
    switch (account.harness) {
      case "claude":
        return this.mintClaudeLease(account, opts);
      case "codex":
        return this.mintCodexLease(account, opts);
      case "grok":
        return this.mintGrokLease(account, opts);
      case "kimi":
        return Promise.resolve(this.mintKimiLease(account));
      case "opencode":
        return Promise.resolve(this.mintOpenCodeLease(account));
      case "muse":
        return this.mintMuseLease(account, opts);
      default:
        // cursor's machine-global keychain slot (and every unmodeled harness)
        // has no defensible lease artifact — a durable, typed refusal.
        throw new LeaseRefusal(
          "lease_unsupported",
          `harness "${account.harness}" has no credential-lease strategy (supported: claude, codex, grok, kimi, muse, opencode)`,
        );
    }
  }

  /**
   * claude: ship `.credentials.json` with `claudeAiOauth.refreshToken` blanked
   * and the CURRENT access token preserved. Experiment 2 (RN7A_EXPERIMENTS.md)
   * confirmed the harness runs cleanly to real token expiry with a blanked
   * refresh token and fails typed at a server 401 — the daemon's own OAuth
   * refresh (refreshClaudeCredential, single-flight, under Claude Code's
   * refresh lock) freshens a chain at/near expiry BEFORE the lease is cut; a
   * token under CLAUDE_MIN_SHIP_TTL_MS is never shipped dying. A healthy
   * running Claude keeps the refresh until CLAUDE_REFRESH_DEFERRAL_DEADLINE_MS
   * before expiry; an idle one never refreshes, so the daemon then does.
   */
  private async mintClaudeLease(account: AccountRow, opts: LeaseOptions): Promise<EphemeralCredential> {
    if (this.authorityFor(account)?.enabled(account)) {
      const preferredTtlMs = opts.minTtlMs !== undefined && opts.minTtlMs > CLAUDE_MIN_SHIP_TTL_MS ? opts.minTtlMs : undefined;
      try {
        await this.authorityFor(account)!.ensure(account, CLAUDE_MIN_SHIP_TTL_MS, undefined, preferredTtlMs);
      } catch (error) {
        if (error instanceof CredentialAuthorityError) {
          if (error.reason === "login_required") throw new LeaseRefusal("credential_login_required", error.message);
          throw new LeaseRefusal("lease_unavailable", `central Claude credential for ${account.id} is unavailable: ${error.message}`);
        }
        throw error;
      }
    }
    let credential = await this.freshestClaudeCredential(account);
    if (!credential) {
      throw new LeaseRefusal("lease_unavailable", `no claude OAuth credential for ${account.id}; log in: hive v2 account login ${account.id}`);
    }
    if (credential.expiresAt - this.now() <= CLAUDE_MIN_SHIP_TTL_MS) {
      const refreshed = await this.refreshClaudeCredential(account, CLAUDE_MIN_SHIP_TTL_MS, CLAUDE_REFRESH_DEFERRAL_DEADLINE_MS);
      if (refreshed.kind === "ok") credential = refreshed.credential;
      else if (refreshed.kind === "live_runtime") {
        throw new LeaseRefusal("lease_unavailable", `claude OAuth token for ${account.id} is at/near expiry and a healthy running Claude owns refresh; retry shortly`);
      } else if (refreshed.kind === "no_refresh_token") {
        throw new LeaseRefusal("lease_unavailable", `claude OAuth token for ${account.id} is at/near expiry with no refresh chain; log in: hive v2 account login ${account.id}`);
      } else if (refreshed.kind === "temporary") {
        throw new LeaseRefusal("lease_unavailable", `claude OAuth refresh for ${account.id} hit a temporary error (${refreshed.detail}); retry shortly`);
      } else {
        throw new LeaseRefusal("lease_unavailable", `claude OAuth refresh failed for ${account.id}; log in: hive v2 account login ${account.id}`);
      }
    }
    // A joined in-flight refresh (from the limits path, floor 0) may have
    // answered with a token that satisfies "not expired" but not the ship
    // floor — re-check the token actually being shipped.
    if (credential.expiresAt - this.now() <= CLAUDE_MIN_SHIP_TTL_MS) {
      throw new LeaseRefusal("lease_unavailable", `claude OAuth refresh for ${account.id} did not produce a token above the 15-minute ship floor; retry shortly`);
    }
    const body = `${JSON.stringify(blankRefreshTokens(credential.document))}\n`;
    const expSeconds = Math.floor(credential.expiresAt / 1000);
    return {
      files: [{ homeRelPath: ".credentials.json", contentB64: Buffer.from(body, "utf8").toString("base64"), mode: 0o600 }],
      expiresAt: expSeconds,
      kindNote: `claude: shipped .credentials.json with OAuth refresh token blanked, exp ${new Date(expSeconds * 1000).toISOString()}; scrub ANTHROPIC_API_KEY on subscription spawns`,
    };
  }

  /**
   * codex: ship an auth.json carrying a FRESH access token with the refresh
   * token BLANKED (`refresh_token: ""`, field kept — codex serde requires it
   * present). Re-validated on codex-cli 0.152.0 (Experiment 1). A near-expiry
   * vault/home token triggers the central rotation first: codex itself rotates
   * auth.json in place on a no-op turn in the account's home (never a
   * re-implemented OAuth endpoint), then the home is captured back to the
   * vault. Never ships a token with under CODEX_MIN_SHIP_TTL_MS remaining.
   */
  private async mintCodexLease(account: AccountRow, opts: LeaseOptions): Promise<EphemeralCredential> {
    if (this.codexCredentials.enabled(account)) {
      try {
        const preferredTtlMs = opts.minTtlMs !== undefined && opts.minTtlMs > CODEX_MIN_SHIP_TTL_MS ? opts.minTtlMs : undefined;
        await this.codexCredentials.ensure(account, CODEX_MIN_SHIP_TTL_MS, undefined, preferredTtlMs);
      } catch (error) {
        if (error instanceof CredentialAuthorityError) throw new LeaseRefusal(error.reason === "login_required" ? "credential_login_required" : "lease_unavailable", error.message);
        throw error;
      }
    }
    let current = this.freshestCodexAuth(account);
    if (!current) {
      throw new LeaseRefusal("lease_unavailable", `no codex auth.json with a decodable access token for ${account.id}; log in: hive v2 account login ${account.id}`);
    }
    if (current.expSeconds * 1000 - this.now() <= CODEX_MIN_SHIP_TTL_MS) {
      if (this.codexCredentials.enabled(account)) throw new LeaseRefusal("lease_unavailable", "Central Codex refresh did not produce enough access-token lifetime; native rotation is fenced.");
      if (this.hasLiveRuntime(account.id)) {
        throw new LeaseRefusal("lease_unavailable", `codex access token for ${account.id} is near expiry and a live runtime owns the home; retry after its rotation lands`);
      }
      // An imported credential may still sit vault-only; the rotation turn
      // reads CODEX_HOME, so activate the EMPTY home first (a populated home
      // is untouched — the identical rule the spawn path applies).
      const activated = activateHomeIfEmpty(account.harness, account.homePath, this.vaultDirOf(account), { yolo: true });
      if (activated.activated) this.log(`account.activate account=${account.id} home=${account.homePath} copied=${activated.copied.join(",")} by=lease`);
      await this.codexLeaseRefresh(account.homePath);
      // The rotation turn is long (up to 120 s): a runtime may have started on
      // this account meanwhile and now owns the home — re-check before
      // touching it again (the harvest) or shipping what the rotation wrote.
      if (this.hasLiveRuntime(account.id)) {
        throw new LeaseRefusal("lease_unavailable", `a runtime started on ${account.id} during the token rotation and owns the home; retry after its rotation lands`);
      }
      // Harvest the rotated chain home → vault so the vault stays current.
      captureHomeToVault(account.harness, account.homePath, this.vaultDirOf(account));
      current = this.freshestCodexAuth(account);
      if (!current || current.expSeconds * 1000 - this.now() <= CODEX_MIN_SHIP_TTL_MS) {
        throw new LeaseRefusal("lease_unavailable", `codex token rotation for ${account.id} did not produce a fresh access token; not shipping a stale token`);
      }
      this.log(`account.lease.codex_rotated account=${account.id} exp=${new Date(current.expSeconds * 1000).toISOString()}`);
    }
    // Deep blank covers every refresh key ANYWHERE in the file (not only
    // tokens.refresh_token); the explicit spread then guarantees the field is
    // PRESENT as "" — codex serde hard-fails when it is missing entirely.
    const blankedDoc = blankRefreshTokens(current.parsed) as Record<string, unknown>;
    // A subscription lease must never carry a billable developer API key: the
    // registry scrubs OPENAI_API_KEY from spawn env, and the file must not
    // smuggle one back in. An API-key-mode account keeps it — that billing is
    // the account's intent.
    const apiKeyMode = typeof blankedDoc.auth_mode === "string" && /^api[-_]?key$/i.test(blankedDoc.auth_mode);
    const blanked = {
      ...blankedDoc,
      ...(!apiKeyMode && "OPENAI_API_KEY" in blankedDoc ? { OPENAI_API_KEY: null } : {}),
      tokens: { ...(blankedDoc.tokens as Record<string, unknown>), refresh_token: "" },
    };
    const body = `${JSON.stringify(blanked, null, 2)}\n`;
    return {
      files: [{ homeRelPath: "auth.json", contentB64: Buffer.from(body, "utf8").toString("base64"), mode: 0o600 }],
      expiresAt: current.expSeconds,
      kindNote: `codex: shipped access-token-only auth.json (refresh_token blanked), exp ${new Date(current.expSeconds * 1000).toISOString()}`,
    };
  }

  /**
   * The freshest codex auth.json between the account's HOME (the live chain —
   * codex rotates in place there) and the vault snapshot, by access-token
   * `exp`. Null when neither holds a decodable access token.
   */
  private freshestCodexAuth(account: AccountRow, includeMirror = false): { parsed: Record<string, unknown>; expSeconds: number } | null {
    let best: { parsed: Record<string, unknown>; expSeconds: number } | null = null;
    for (const path of [join(account.homePath, "auth.json"), ...(includeMirror ? [join(account.homePath, ".codex", "auth.json")] : []), join(this.vaultDirOf(account), "auth.json")]) {
      const raw = readIfFile(path);
      if (raw === null) continue;
      let parsed: Record<string, unknown>;
      try {
        const value = JSON.parse(raw) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        parsed = value as Record<string, unknown>;
      } catch {
        continue;
      }
      const tokens = parsed.tokens && typeof parsed.tokens === "object" && !Array.isArray(parsed.tokens)
        ? (parsed.tokens as Record<string, unknown>)
        : undefined;
      const accessToken = tokens && typeof tokens.access_token === "string" ? tokens.access_token : undefined;
      const expSeconds = accessToken ? expFromJwt(accessToken) : undefined;
      if (expSeconds === undefined) continue;
      if (!best || expSeconds > best.expSeconds) best = { parsed, expSeconds };
    }
    return best;
  }

  /**
   * grok: ship auth.json (keyed by issuer::client; each entry may carry an
   * OAuth `refresh_token` grok uses to self-refresh) with every refresh token
   * blanked; the cached `key`/`expires_at` are preserved. The spawn side must
   * scrub XAI_API_KEY / GROK_CODE_XAI_API_KEY for subscription bees so the
   * delivered cached OAuth token — not developer API billing — is used.
   */
  private async mintGrokLease(account: AccountRow, opts: LeaseOptions): Promise<EphemeralCredential> {
    if (this.grokCredentials.enabled(account)) {
      try { await this.grokCredentials.ensure(account, CLAUDE_MIN_SHIP_TTL_MS, undefined, opts.minTtlMs); }
      catch (error) {
        if (!(error instanceof CredentialAuthorityError)) throw error;
        throw new LeaseRefusal(error.reason === "login_required" ? "credential_login_required" : "lease_unavailable", error.message);
      }
    }
    const parsed = this.grokCredentials.enabled(account) ? grokAccessOnly(this.grokCredentials.document(account)) : this.leasePrimaryJson(account, "auth.json");
    // Non-secret expiry: the soonest-dying entry bounds the whole lease —
    // that is when RN7b must have re-delivered. Live files carry ISO strings;
    // accept epoch numbers (ms or seconds) defensively.
    let expiresAt: number | undefined;
    for (const entry of Object.values(parsed as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const raw = (entry as Record<string, unknown>).expires_at;
      const ms = typeof raw === "string" ? Date.parse(raw) : typeof raw === "number" ? (raw > 1e11 ? raw : raw * 1000) : Number.NaN;
      if (!Number.isFinite(ms)) continue;
      const seconds = Math.floor(ms / 1000);
      if (expiresAt === undefined || seconds < expiresAt) expiresAt = seconds;
    }
    const body = `${JSON.stringify(blankRefreshTokens(parsed), null, 2)}\n`;
    return {
      files: [{ homeRelPath: "auth.json", contentB64: Buffer.from(body, "utf8").toString("base64"), mode: 0o600 }],
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      kindNote: "grok: shipped auth.json with OAuth refresh token(s) blanked; scrub XAI_API_KEY and GROK_CODE_XAI_API_KEY on subscription spawns",
    };
  }

  /**
   * kimi: API-key lease per the design ruling — kimi's OAuth access tokens
   * live ~15 minutes and its refresh token rotates on every grant, so an
   * OAuth-only account cannot hold a lease across a satellite turn. A
   * credential carrying an `api_key` ships (refresh blanked); an OAuth-only
   * credential is a durable typed refusal.
   */
  private mintKimiLease(account: AccountRow): EphemeralCredential {
    const parsed = this.leasePrimaryJson(account, "credentials/kimi-code.json");
    const apiKey = (parsed as Record<string, unknown>).api_key;
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      throw new LeaseRefusal(
        "lease_unsupported",
        `kimi account ${account.id} is OAuth-only (15-minute rotating tokens cannot survive a lease); log in with a Moonshot API key to lease it`,
      );
    }
    const body = `${JSON.stringify(blankRefreshTokens(parsed), null, 2)}\n`;
    return {
      files: [{ homeRelPath: "credentials/kimi-code.json", contentB64: Buffer.from(body, "utf8").toString("base64"), mode: 0o600 }],
      kindNote: "kimi: shipped credentials/kimi-code.json as an API-key lease (OAuth refresh token blanked)",
    };
  }

  /**
   * opencode: auth.json multiplexes EVERY provider login in one object keyed
   * by providerID. Ship ONLY the account's single coding-plan entry (the same
   * closed provider list the limits probe reads), refresh blanked, every
   * other provider's credential dropped. Never ships the multi-provider file.
   */
  private mintOpenCodeLease(account: AccountRow): EphemeralCredential {
    const rel = join("xdg-data", "opencode", "auth.json");
    const parsed = this.leasePrimaryJson(account, rel);
    const providers = parsed as Record<string, unknown>;
    const provider = OPENCODE_LEASE_PROVIDERS.find((id) => Object.prototype.hasOwnProperty.call(providers, id));
    if (!provider) {
      throw new LeaseRefusal(
        "lease_unsupported",
        `opencode account ${account.id} has no leasable coding-plan provider entry (${OPENCODE_LEASE_PROVIDERS.join(", ")})`,
      );
    }
    const dropped = Object.keys(providers).length - 1;
    const filtered = { [provider]: blankRefreshTokens(providers[provider]) };
    const body = `${JSON.stringify(filtered, null, 2)}\n`;
    return {
      files: [{ homeRelPath: rel, contentB64: Buffer.from(body, "utf8").toString("base64"), mode: 0o600 }],
      kindNote: `opencode: shipped single-provider (${provider}) auth.json (refresh blanked; ${dropped} other provider entr${dropped === 1 ? "y" : "ies"} dropped)`,
    };
  }

  private freshestGrokAuth(account: AccountRow): Record<string, unknown> | null {
    const candidates: Array<{ document: Record<string, unknown>; expiresAt: number }> = [];
    for (const path of [join(account.homePath, "auth.json"), join(this.vaultDirOf(account), "auth.json")]) {
      const raw = readIfFile(path);
      if (raw === null) continue;
      try {
        const document = JSON.parse(raw) as Record<string, unknown>;
        const value = grokCredentialEntry(document);
        if (value) candidates.push({ document, expiresAt: value.expiresAt });
      } catch {}
    }
    candidates.sort((a, b) => b.expiresAt - a.expiresAt);
    return candidates[0]?.document ?? null;
  }

  private async mintMuseLease(account: AccountRow, opts: LeaseOptions): Promise<EphemeralCredential> {
    const rel = "muse/auth.json";
    const authority = this.museCredentials;
    let document: Record<string, unknown>;
    let expiresAt: number;
    if (authority.enabled(account)) {
      await authority.ensure(account, 15 * 60_000, undefined, opts.minTtlMs === undefined ? undefined : Math.min(opts.minTtlMs, 60 * 60_000));
      document = museWorkingDocument(authority.document(account));
      expiresAt = Math.floor(authority.parseDocument(authority.document(account))!.expiresAt / 1000);
    } else {
      const original = this.leasePrimaryJson(account, rel) as Record<string, unknown>;
      const credential = parseMuseCredentials(JSON.stringify(original));
      if (credential?.mechanism === "keychain") throw new LeaseRefusal("lease_unsupported", 'Muse Keychain-backed storage:"keychain" logins cannot be leased.');
      if (!credential) throw new LeaseRefusal("lease_unavailable", "Muse has no usable meta credential; sign in again.");
      if (museMeta(original)?.access_token) throw new LeaseRefusal("lease_unavailable", `Enable central Muse credentials for ${account.id} before leasing its login; bootstrap logins are never delivered to holders.`);
      document = museWorkingDocument(original);
      expiresAt = Math.floor((this.now() + MUSE_DEFAULT_KEY_TTL_MS) / 1000);
    }
    return { files: [{ homeRelPath: rel, contentB64: Buffer.from(JSON.stringify(document)).toString("base64"), mode: 0o600 }], expiresAt,
      kindNote: "muse: issued working key only; lease expiry does not revoke the provider key" };
  }

  /**
   * The account's primary credential file for a lease, HOME first (the live
   * chain) then the vault snapshot, parsed as a JSON object. Typed refusals:
   * missing anywhere → `lease_unavailable`; unparseable → `lease_unavailable`
   * with a re-login hint. Never reads any other account's files.
   */
  private leasePrimaryJson(account: AccountRow, rel: string): unknown {
    for (const path of [join(account.homePath, rel), join(this.vaultDirOf(account), rel)]) {
      const raw = readIfFile(path);
      if (raw === null) continue;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      } catch {
        // fall through to the typed refusal below
      }
      throw new LeaseRefusal("lease_unavailable", `${account.harness} credential ${rel} for ${account.id} is not a JSON object; re-login: hive v2 account login ${account.id}`);
    }
    throw new LeaseRefusal("lease_unavailable", `no ${rel} found for ${account.id}; log in: hive v2 account login ${account.id}`);
  }

  /**
   * v18: `account.add {importExisting:true}` — adopt the machine's existing
   * sign-in for a NEW account (called before the row exists). In order:
   * the account's own home (captured into the vault), a leftover vault
   * entry, then the machine's VENDOR home (the harness's home env var when
   * set in `env`, else the recipe default under `home`; Claude's Keychain
   * item / Cursor's global store as the external primary). The primary must
   * parse as a credential; supporting/config files come along when present.
   * Nothing valid anywhere → `ok:false` with every path checked. Never
   * writes the account home; never records a login (health stays
   * `unverified` until a probe/login proves it).
   */
  async importExistingCredentials(
    account: Pick<AccountRow, "harness" | "id" | "homePath">,
    opts: { env?: Readonly<Record<string, string | undefined>>; home?: string } = {},
  ): Promise<ImportOutcome> {
    const recipe = recipeFor(account.harness);
    const checked: ImportCheck[] = [];
    if (!recipe) return { ok: false, checked };
    const primaryFile = primaryCredentialFile(recipe);
    const vaultDir = this.vaultDirOf(account);
    const check = (path: string, raw: string | null): ImportCheck["state"] =>
      raw === null ? "missing" : this.validPrimaryCredential(account.harness, primaryFile, raw) ? "present" : "invalid";

    // 1. The account's own home (a machine home handed in as homePath).
    const homePrimary = join(account.homePath, primaryFile);
    const homeRaw = readIfFile(homePrimary);
    const homeState = check(homePrimary, homeRaw);
    checked.push({ path: homePrimary, state: homeState });
    if (homeState === "present") {
      const files = captureHomeToVault(account.harness, account.homePath, vaultDir);
      return { ok: true, source: "home", from: account.homePath, files, checked };
    }
    // 2. A leftover vault entry for the id.
    const vaultPrimary = join(vaultDir, primaryFile);
    const vaultRaw = readIfFile(vaultPrimary);
    const vaultState = check(vaultPrimary, vaultRaw);
    checked.push({ path: vaultPrimary, state: vaultState });
    if (vaultState === "present") {
      const files = recipeFilesPresent(vaultDir, recipe);
      return { ok: true, source: "vault", from: vaultDir, files, checked };
    }
    // 3. The machine's vendor home.
    const vendor = resolveVendorHome(account.harness, opts.env ?? process.env, opts.home ?? homedir());
    if (!vendor) return { ok: false, checked };
    const contents = new Map<string, string>();
    for (const file of vendor.files) {
      const raw = readIfFile(file.path);
      if (file.role === "credential" && file.rel === primaryFile) checked.push({ path: file.path, state: check(file.path, raw) });
      if (raw !== null) contents.set(file.rel, raw);
    }
    let source: "vendor_home" | "external" = "vendor_home";
    let from = vendor.vendorHome;
    if (!this.validPrimaryCredential(account.harness, primaryFile, contents.get(primaryFile) ?? null)) {
      contents.delete(primaryFile);
      // The provider's out-of-home store for the VENDOR home.
      const external = account.harness === "claude"
        ? await this.keychainReader(vendor.vendorHome).catch(() => null)
        : account.harness === "cursor"
          ? (await this.cursorAuthReader().catch(() => null))?.raw ?? null
          : null;
      if (account.harness === "claude" || account.harness === "cursor") {
        const store = account.harness === "claude" ? `keychain:${vendor.vendorHome}` : "cursor:global-store";
        const state = check(store, external);
        checked.push({ path: store, state });
        if (state === "present") {
          contents.set(primaryFile, external as string);
          source = "external";
          from = store;
        }
      }
    }
    if (!contents.has(primaryFile)) return { ok: false, checked };
    mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
    const files: string[] = [];
    for (const file of vendor.files) {
      const raw = contents.get(file.rel);
      if (raw === undefined) continue;
      const dst = join(vaultDir, file.rel);
      mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
      atomicWriteFileSync(dst, raw);
      files.push(file.rel);
    }
    return { ok: true, source, from, files, checked };
  }

  private enqueueLimitsRefresh(accountIds: readonly string[]): void {
    for (const id of accountIds) {
      if (!this.activeRefreshIds.has(id)) this.queuedRefreshIds.add(id);
    }
    if (this.refreshing || this.queuedRefreshIds.size === 0) return;
    this.refreshing = (async () => {
      while (this.queuedRefreshIds.size > 0) {
        const batch = [...this.queuedRefreshIds];
        this.queuedRefreshIds.clear();
        for (const id of batch) this.activeRefreshIds.add(id);
        try {
          await this.refreshLimits(batch);
        } finally {
          for (const id of batch) this.activeRefreshIds.delete(id);
        }
      }
    })()
      .catch((err) => this.log(`account.limits.sweep_error ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        this.refreshing = null;
      });
  }

  /** Tick hook: the periodic refresh (every limitsRefreshMs while the daemon runs; 0 = off). Shares the background lane with spawn-triggered stale sampling. */
  periodicRefreshTick(): void {
    const every = this.cfg.accounts.limitsRefreshMs;
    if (every <= 0) return;
    const now = this.now();
    if (now - this.lastPeriodicRefreshAt < every) return;
    this.lastPeriodicRefreshAt = now;
    const ids = this.store.listAccounts().map((account) => account.id);
    if (ids.length === 0) return;
    this.enqueueLimitsRefresh(ids);
  }

  /**
   * Tick hook: drive due central refresh retries and refreshes interrupted by
   * a process death through the limits probe, so the phase, the account status
   * and the limits row settle together instead of waiting for the next caller.
   */
  /**
   * Tick hook: refresh central Claude credentials hours before the access
   * token ends, so every copy and lease carries real margin instead of
   * waiting for a caller at the 15-minute floor.
   */
  centralEarlyRefreshTick(): void {
    const aheadMs = this.cfg.accounts.centralRefreshAheadMs;
    if (aheadMs <= 0) return;
    const now = this.now();
    for (const account of this.store.listAccounts()) {
      if (account.harness === "muse" || account.source === "leased" || !this.credentialAuthorities.has(account.harness) || account.status === "paused") continue;
      const backoff = this.earlyRefreshBackoff.get(account.id);
      if (backoff && backoff.at > now) continue;
      const accountAheadMs = account.harness === "muse" ? Math.min(aheadMs, 60 * 60_000) : aheadMs;
      if (!this.authorityFor(account)!.earlyRefreshDue(account, accountAheadMs)) continue;
      this.log(`account.credentials.early_refresh account=${account.id} ahead_ms=${aheadMs}`);
      void this.authorityFor(account)!.ensure(account, account.harness === "codex" ? CODEX_MIN_SHIP_TTL_MS : CLAUDE_MIN_SHIP_TTL_MS, undefined, accountAheadMs).then(() => {
        this.earlyRefreshBackoff.delete(account.id);
      }, (error) => {
        const failures = (this.earlyRefreshBackoff.get(account.id)?.failures ?? 0) + 1;
        const delayMs = Math.min(this.cfg.accounts.centralRefreshRetryBaseMs * 2 ** Math.min(failures - 1, 20), 15 * 60_000);
        this.earlyRefreshBackoff.set(account.id, { at: this.now() + delayMs, failures });
        this.log(`account.credentials.early_refresh_failed account=${account.id} next_in_ms=${delayMs} err=${JSON.stringify(errorDetail(error).slice(0, 300))}`);
      });
    }
  }

  centralRefreshRetryTick(): void {
    const now = this.now();
    const due = this.store.listAccounts()
      .filter((account) => account.harness !== "muse" && this.credentialAuthorities.has(account.harness) && this.authorityFor(account)!.retryDue(account)
        && !this.queuedRefreshIds.has(account.id) && !this.activeRefreshIds.has(account.id)
        // A retry that cannot even start (a locked Keychain, a failing publication) must not probe on every tick.
        && (this.centralRetryProbes.get(account.id) ?? 0) <= now)
      .map((account) => account.id);
    for (const id of due) this.centralRetryProbes.set(id, now + this.cfg.accounts.centralRefreshRetryBaseMs);
    if (due.length > 0) this.enqueueLimitsRefresh(due);
  }

  // -------------------------------------------------------------------------
  // activation hook (spawn resolve)
  // -------------------------------------------------------------------------

  private activateHomeForSpawn(account: AccountRow, bee: { cwd: string }): ActivationResult {
    const result = activateHomeIfEmpty(account.harness, account.homePath, this.vaultDirOf(account), { trustCwd: bee.cwd, yolo: true });
    if (result.activated) {
      this.log(`account.activate account=${account.id} home=${account.homePath} copied=${result.copied.join(",")}`);
      if (account.harness === "claude") {
        const pending = this.nativeKeychainSeeds.get(account.id) ?? new Set<Promise<unknown>>();
        this.nativeKeychainSeeds.set(account.id, pending);
        const seed = seedClaudeKeychainFromVault(account.homePath, this.vaultDirOf(account), this.keychainWriter).then((seeded) => {
          if (seeded) this.log(`account.activate.keychain account=${account.id} seeded=true`);
        }).catch(() => { this.log(`account.activate.keychain account=${account.id} seeded=false`); }).finally(() => {
          pending.delete(seed);
          if (pending.size === 0) this.nativeKeychainSeeds.delete(account.id);
        });
        pending.add(seed);
      }
    }
    return result;
  }

  /**
   * Complete account readiness before a queued runtime command is claimed:
   * activate an empty home, then reconcile Honeybee-owned native MCP entries
   * through the common multi-harness seeder. A populated home still skips
   * credential/default activation, but its owned gateway entries converge.
   */
  async reconnectGatewayTools(home: string, afterSeed: (targets: string[]) => Promise<void>): Promise<void> {
    const result = await seedGatewayMcp(home, "codex", {
      gateways: liveGateways(), disabled: process.env.HIVE_GATEWAYS_DISABLE === "1", failOnError: true,
      afterSeed,
    });
    if (result.status !== "seeded") throw new Error(`Gateway config reconciliation refused: ${result.reason ?? "unknown"}`);
  }

  async activateForSpawn(account: AccountRow, bee: { cwd: string }): Promise<ActivationResult> {
    if (this.isNative(account)) {
      const moved = this.nativeHomeRefusal(account);
      if (moved) throw new Error(moved);
      return { activated: false, copied: [], reason: "home_populated" };
    }
    this.assertOwnedHome(account, "writes into");
    const unisolated = this.isolationRefusal(account.harness);
    if (unisolated) throw new Error(unisolated);
    if (this.authorityFor(account)?.enabled(account)) {
      await this.authorityFor(account)!.ensure(account, account.harness === "codex" ? CODEX_MIN_SHIP_TTL_MS : CLAUDE_MIN_SHIP_TTL_MS);
      await this.authorityFor(account)!.checkRuntimeCopies(account);
    }
    const result = this.activateHomeForSpawn(account, bee);
    const gatewaySeed = await this.gatewayMcpSeeder(account.homePath, account.harness);
    if (gatewaySeed.written.length > 0) {
      this.log(`account.activate.gateways account=${account.id} written=${gatewaySeed.written.join(",")}`);
    } else if (gatewaySeed.status === "skipped") {
      this.log(`account.activate.gateways account=${account.id} skipped=${JSON.stringify(gatewaySeed.reason ?? "unknown")}`);
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // credential validation + capture (the login flow service drives these)
  // -------------------------------------------------------------------------

  /** The provider's out-of-home credential store (Claude: the home's Keychain item; Cursor: the machine-global store); null elsewhere. */
  async externalLoginCredential(account: AccountRow): Promise<string | null> {
    if (account.harness === "claude") return this.keychainReader(account.homePath).catch(() => null);
    if (account.harness === "cursor") return (await this.cursorAuthReader().catch(() => null))?.raw ?? null;
    return null;
  }

  /** Claude on macOS: seed the home's Keychain item with the credential JSON (false when unavailable/rejected). */
  writeClaudeKeychain(account: AccountRow, credentials: string): Promise<boolean> {
    if (account.harness !== "claude") return Promise.resolve(false);
    return this.keychainWriter(account.homePath, credentials).catch(() => false);
  }

  validPrimaryCredential(harness: string, primaryFile: string, raw: string | null): boolean {
    if (raw === null || raw.trim().length === 0) return false;
    if (harness === "claude") return parseClaudeCredentials(raw) !== null;
    if (harness === "cursor") return parseCursorAuth(raw) !== null;
    // A keychain pointer is a login, but not one that can be captured or copied.
    if (harness === "muse" && parseMuseCredentials(raw)?.mechanism === "keychain") return false;
    if (!primaryFile.endsWith(".json")) return true;
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Validate the primary credential, then capture the recipe files home →
   * vault and record the login on the account row (status ok unless paused,
   * last_login_at). Atomic from the caller's view: an invalid primary
   * touches neither the vault nor the row.
   */
  persistCredentialCapture(
    account: AccountRow,
    primaryFile: string,
    primaryRaw: string | null,
    overrides: Record<string, string>,
  ):
    | { ok: true; account: AccountRow; captured: string[]; at: number }
    | { ok: false; reason: "invalid_primary" | "primary_not_captured" } {
    this.assertLocalAccount(account);
    const foreign = this.foreignHomeRefusal(account, "captures credentials from");
    if (foreign) throw new Error(foreign);
    if (this.authorityFor(account)?.enabled(account) || this.authorityFor(account)?.busy(account)) {
      throw new CredentialAuthorityError("Central credential ownership prevents native capture.");
    }
    if (!this.validPrimaryCredential(account.harness, primaryFile, primaryRaw)) {
      return { ok: false, reason: "invalid_primary" };
    }
    // Cursor's provider login lands outside CURSOR_CONFIG_DIR. Materialize
    // that explicit credential into the account home before vault backup.
    if (account.harness === "cursor" && overrides[primaryFile] !== undefined) {
      atomicWriteFileSync(join(account.homePath, primaryFile), overrides[primaryFile] as string);
    }
    const captured = captureHomeToVault(account.harness, account.homePath, this.vaultDirOf(account), overrides);
    if (!captured.includes(primaryFile)) return { ok: false, reason: "primary_not_captured" };
    const at = this.now();
    this.store.recordAccountLogin(account.id, at);
    const refreshTokenExpiresAt = account.harness === "claude" ? parseClaudeCredentials(primaryRaw)?.refreshTokenExpiresAt ?? null : null;
    const updated = this.store.setAccountRefreshTokenExpiry(account.id, refreshTokenExpiresAt, "credential captured").account;
    return { ok: true, account: updated, captured, at };
  }

  /**
   * Explicit recovery capture. It snapshots the credential that is valid
   * right now, without requiring a login flow to observe a fresh write.
   * Claude/Cursor use their external provider store when present; file-based
   * harnesses use the account home.
   */
  async captureAccount(account: AccountRow): Promise<CaptureOutcome> {
    this.assertLocalAccount(account);
    const foreign = this.foreignHomeRefusal(account, "captures credentials from");
    if (foreign) throw new Error(foreign);
    if (this.authorityFor(account)?.enabled(account)) throw new CredentialAuthorityError("Disable central credentials before capturing native credentials.");
    const recipe = recipeFor(account.harness);
    if (!recipe) throw new Error(`harness ${account.harness} has no identity recipe; cannot capture credentials`);
    const primaryFile = primaryCredentialFile(recipe);
    const externalRaw = account.harness === "claude" || account.harness === "cursor"
      ? await this.externalLoginCredential(account)
      : null;
    const source: CaptureOutcome["source"] = externalRaw !== null ? "external" : "home";
    let primaryRaw = externalRaw;
    if (primaryRaw === null) {
      try {
        primaryRaw = readFileSync(join(account.homePath, primaryFile), "utf8");
      } catch {
        primaryRaw = null;
      }
    }
    const overrides = externalRaw === null ? {} : { [primaryFile]: externalRaw };
    const result = this.persistCredentialCapture(account, primaryFile, primaryRaw, overrides);
    if (!result.ok) {
      if (result.reason === "invalid_primary") {
        throw new Error(`no valid ${account.harness} credential found for ${account.id}; complete a provider login first`);
      }
      throw new Error(`failed to capture ${primaryFile} for ${account.id}`);
    }
    this.log(`account.capture account=${account.id} source=${source} files=${result.captured.join(",")}`);
    return { account: result.account, captured: result.captured, source, at: result.at };
  }

  // -------------------------------------------------------------------------
  // importer — the OLD ~/.hive/vault/accounts.json + homes layout, read-only
  // -------------------------------------------------------------------------

  /**
   * Plan (and unless dryRun, apply) an import of the old registry into
   * account rows. READ-ONLY on the old tree. Each old record becomes
   * {id, harness: tool, homePath: <homesDir>/<id>, label, penalty:
   * autoPickPenalty, status: paused|ok, addedAt}; existing rows are skipped
   * (idempotent). Also reports whether the vault entry / home dir exist so
   * the operator sees which accounts are usable.
   */
  importRegistry(root: string, opts: { dryRun?: boolean; homesDir?: string } = {}): RegistryImportReport {
    const registryPath = join(root, "vault", "accounts.json");
    const homesDir = opts.homesDir ?? join(root, "homes");
    const report: RegistryImportReport = { root, registryPath, dryRun: opts.dryRun === true, applied: false, entries: [], counts: { import: 0, skip: 0 }, byHarness: {} };
    if (!existsSync(registryPath)) {
      report.refusal = `no old registry at ${registryPath}`;
      return report;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(registryPath, "utf8"));
    } catch (err) {
      report.refusal = `invalid JSON in ${registryPath}: ${err instanceof Error ? err.message : String(err)}`;
      return report;
    }
    if (!Array.isArray(parsed)) {
      report.refusal = `${registryPath} is not an array`;
      return report;
    }
    for (const raw of parsed) {
      const r = raw as Record<string, unknown>;
      if (!r || typeof r !== "object" || typeof r.id !== "string" || typeof r.tool !== "string" || typeof r.label !== "string") {
        report.entries.push({ id: String((r as { id?: unknown })?.id ?? "?"), harness: String((r as { tool?: unknown })?.tool ?? "?"), action: "skip", reason: "unusable_record" });
        report.counts.skip += 1;
        continue;
      }
      const id = r.id;
      const harness = r.tool;
      const homePath = join(homesDir, id);
      const vault = vaultDirFor(join(root, "vault"), harness, id);
      const recipe = recipeFor(harness);
      const vaultHasCredentials = recipe ? dirHasCredentials(vault, recipe) : existsSync(vault);
      const homeHasCredentials = recipe ? dirHasCredentials(homePath, recipe) : existsSync(homePath);
      const entry: RegistryImportEntry = {
        id,
        harness,
        action: "import",
        homePath,
        vaultDir: vault,
        vaultHasCredentials,
        homeExists: existsSync(homePath),
        homeHasCredentials,
        penalty: typeof r.autoPickPenalty === "number" && Number.isFinite(r.autoPickPenalty) && r.autoPickPenalty > 0 && r.autoPickPenalty <= 100 ? r.autoPickPenalty : 0,
        // v18: an old record without any credential is imported logged OUT
        // (auth_needed), never as a usable-looking `ok` row.
        status: typeof r.pausedAt === "string" ? "paused" : vaultHasCredentials || homeHasCredentials ? "ok" : "auth_needed",
        addedAt: typeof r.addedAt === "string" && Number.isFinite(Date.parse(r.addedAt)) ? Date.parse(r.addedAt) : null,
      };
      if (this.store.getAccount(id)) {
        entry.action = "skip";
        entry.reason = "already_imported";
      } else if (id !== accountIdFor(harness, r.label)) {
        // Not a refusal — the old id is the identity (homes/vault dirs are named by it); note it.
        entry.note = `id differs from accountIdFor(${harness}, ${JSON.stringify(r.label)}) = ${accountIdFor(harness, r.label)}; keeping the old id`;
      }
      report.entries.push(entry);
      report.counts[entry.action] += 1;
      const bucket = (report.byHarness[harness] ??= { import: 0, skip: 0 });
      bucket[entry.action] += 1;
      if (entry.action === "import" && !report.dryRun) {
        this.store.createAccount({
          id,
          harness,
          homePath,
          label: r.label,
          penalty: entry.penalty,
          status: entry.status,
          ...(entry.addedAt !== null ? { addedAt: entry.addedAt } : {}),
        });
        this.log(`account.import id=${id} harness=${harness} home=${homePath} vaultCreds=${entry.vaultHasCredentials} homeCreds=${entry.homeHasCredentials}`);
      }
    }
    if (!report.dryRun) report.applied = true;
    return report;
  }

  /**
   * Backfill (spec 08 "a backfill maps known home paths to account ids"):
   * every bee with no account whose env home path (HOME_ENV[agent]) equals
   * an account's home_path (same harness) gets bound. Idempotent.
   */
  backfillBeeAccounts(opts: { dryRun?: boolean } = {}): BackfillReport {
    const report: BackfillReport = { dryRun: opts.dryRun === true, bound: [], unmatched: [] };
    const accounts = this.store.listAccounts();
    for (const bee of this.store.listBees()) {
      if (bee.account) continue;
      const key = homeEnvFor(bee.agent);
      const home = key ? bee.env[key] : undefined;
      if (!home) continue;
      const match = accounts.find((a) => a.harness === bee.agent && resolve(a.homePath) === resolve(home));
      if (!match) {
        report.unmatched.push({ beeId: bee.id, home });
        continue;
      }
      report.bound.push({ beeId: bee.id, account: match.id, home });
      if (!report.dryRun) {
        this.store.setBeeAccount(bee.id, match.id);
        this.log(`account.backfill bee=${bee.id} account=${match.id} home=${home}`);
      }
    }
    return report;
  }
}

export interface RegistryImportEntry {
  id: string;
  harness: string;
  action: "import" | "skip";
  reason?: "unusable_record" | "already_imported";
  note?: string;
  homePath?: string;
  vaultDir?: string;
  vaultHasCredentials?: boolean;
  homeExists?: boolean;
  homeHasCredentials?: boolean;
  penalty?: number;
  status?: AccountStatus;
  addedAt?: number | null;
}

export interface RegistryImportReport {
  root: string;
  registryPath: string;
  dryRun: boolean;
  applied: boolean;
  refusal?: string;
  entries: RegistryImportEntry[];
  counts: { import: number; skip: number };
  byHarness: Record<string, { import: number; skip: number }>;
}

export interface BackfillReport {
  dryRun: boolean;
  bound: Array<{ beeId: string; account: string; home: string }>;
  unmatched: Array<{ beeId: string; home: string }>;
}

/** The recipe files (credential + config) that exist in a dir, relative. */
function recipeFilesPresent(dir: string, recipe: NonNullable<ReturnType<typeof recipeFor>>): string[] {
  return [...recipe.credentialFiles, ...(recipe.configFiles ?? [])].filter((rel) => readIfFile(join(dir, rel)) !== null);
}

/**
 * Inherited auth env that would compete with the account's own login. Every
 * Claude account scrubs it (central or not): a satellite daemon started with
 * an operator's CLAUDE_CODE_OAUTH_TOKEN must not leak it into bees bound to
 * another identity. Recipe extras layer over the blanks when an account
 * intentionally supplies them.
 */
export const CLAUDE_COMPETING_AUTH_ENV_SCRUB: Readonly<Record<string, string>> = Object.freeze({
  CLAUDE_CODE_OAUTH_TOKEN: "",
  CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "",
  CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "",
  ANTHROPIC_AUTH_TOKEN: "",
  ANTHROPIC_API_KEY: "",
});

function hasRefreshToken(credential: { refreshToken?: string }): boolean {
  return typeof credential.refreshToken === "string" && credential.refreshToken.length > 0;
}

function readIfFile(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** The old spawn note's usage cell: `Fable 16%, weekly 40%, 5h 3%` (Fable only for a Fable pick). */
export function autoPickUsage(limits: AccountLimits | undefined, model: string | undefined, now: number): string {
  if (!limits?.ok) return "";
  const cell = (label: string, window?: WindowUsage) => {
    if (!window) return null;
    const rolled = windowRolledOver(window, now);
    const velocity = !rolled && typeof window.velocityPerHour === "number" && window.velocityPerHour >= 0.5
      ? ` +${Math.round(window.velocityPerHour)}/h`
      : "";
    return `${label} ${Math.round(rolled ? 0 : window.usedPercent)}%${velocity}`;
  };
  return [
    ...(isFableModel(model) ? [cell("Fable", limits.fableWeekly)] : []),
    cell("weekly", limits.weekly),
    cell("5h", limits.fiveHour),
  ].filter(Boolean).join(", ");
}

/** Whether a directory listing has anything at all (used by the importer's report). */
export function dirEntries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
