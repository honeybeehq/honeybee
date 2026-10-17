/**
 * Account login flows (spec 08 amendment, 2026-08-28 operator decision):
 * login is a first-class, tmux-independent Honeybee domain flow. The daemon
 * owns the flow row, the provider recipe's method descriptors, the worker
 * that runs it, credential validation/capture, and cleanup. Clients (Apiary,
 * the CLI) mirror the row and render it; they never scrape a terminal.
 *
 * SAFETY: a flow row is a MIRRORED, AUDITED record. It carries only safe
 * facts — never a raw CLI/PTY transcript, never a typed secret, never a
 * provider token. Authorization URLs and device user codes are shown to the
 * operator by design and are the only provider-issued strings that ride here.
 */

/** Closed phase vocabulary; an unmatched phase is a software bug. */
export const LOGIN_FLOW_PHASES = [
  /** Admitted; the method runner has not produced its first instruction yet. */
  "starting",
  /** An authorization URL is issued; waiting for the browser-side sign-in to complete on its own. */
  "waiting_browser",
  /** A device/user code is issued; the operator enters it on the provider's device page. */
  "waiting_device",
  /** The flow needs typed input (`inputFields`) — an authorization code, an API key, structured fields. */
  "waiting_input",
  /** Input received / callback landed; the credential is being validated and captured. */
  "validating",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  /** The daemon restarted (or the worker died) under a live flow; retry issues a new revision. */
  "interrupted",
] as const;
export type LoginFlowPhase = (typeof LOGIN_FLOW_PHASES)[number];

export const LOGIN_FLOW_TERMINAL_PHASES: ReadonlySet<LoginFlowPhase> = new Set<LoginFlowPhase>([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "interrupted",
]);

export function isTerminalLoginPhase(phase: LoginFlowPhase): boolean {
  return LOGIN_FLOW_TERMINAL_PHASES.has(phase);
}

/** Vendor-neutral method kinds. A recipe advertises one or more. */
export const LOGIN_METHOD_KINDS = [
  /** Open a URL; the provider completes the sign-in without further input (callback / polling). */
  "browser",
  /** Open a URL; the provider shows an authorization code the operator pastes back. */
  "browser_code",
  /** Show a user code; the operator enters it on the provider's device page. */
  "device_code",
  /** A single API key (secret field). */
  "api_key",
  /** Several structured fields (provider selection, key, optional non-secret extras). */
  "credential_fields",
] as const;
export type LoginMethodKind = (typeof LOGIN_METHOD_KINDS)[number];

export const LOGIN_FIELD_INPUT_TYPES = ["text", "password", "url", "select"] as const;
export type LoginFieldInputType = (typeof LOGIN_FIELD_INPUT_TYPES)[number];

/** Safe metadata about one input the flow needs. NEVER carries a value. */
export interface LoginFieldDescriptor {
  /** Stable id (`code`, `apiKey`, `provider`, …) — the submit key. */
  id: string;
  label: string;
  help: string | null;
  required: boolean;
  /** Secret fields are password inputs client-side and are never persisted anywhere but the credential store. */
  secret: boolean;
  inputType: LoginFieldInputType;
  placeholder: string | null;
  /** Client-side validation shape (an anchored regex source), or null. */
  pattern: string | null;
  /** `select` options. */
  options: Array<{ value: string; label: string }> | null;
  /** Provider scope the field belongs to (OpenCode provider id), or null. */
  scope: string | null;
}

/** One way to log an account in. Recipes advertise these; the flow row copies them verbatim. */
export interface LoginMethodDescriptor {
  id: string;
  kind: LoginMethodKind;
  label: string;
  description: string | null;
  /**
   * Whether the method works when the Honeybee node is remote from the
   * operator's browser (no localhost callback the browser must reach).
   */
  remoteCapable: boolean;
  /** Fields the method requests up front (api_key / credential_fields); dynamic prompts add to `inputFields` later. */
  fields: LoginFieldDescriptor[];
}

/** Closed error/refusal vocabulary for a flow row (never prose-only). */
export const LOGIN_FLOW_ERROR_CODES = [
  "unsupported_method",
  "remote_loopback_unsupported",
  "pty_unavailable",
  "cli_missing",
  "cli_failed",
  "invalid_input",
  "invalid_credential",
  "capture_failed",
  "process_exited",
  "worker_died",
  "timeout",
  "provider_error",
  "network_error",
  "account_removed",
  "account_paused",
  "daemon_restarted",
  "cancelled_by_user",
  /** A centrally managed account's new login belongs to another Anthropic account; nothing changed. */
  "different_account",
  /** Which Anthropic account a central login belongs to could not be established; nothing changed. */
  "identity_unverified",
  /** The central credential could not take the new login (busy, Keychain, publication); retry. */
  "credential_unavailable",
] as const;
export type LoginFlowErrorCode = (typeof LOGIN_FLOW_ERROR_CODES)[number];

export interface LoginFlowError {
  code: LoginFlowErrorCode;
  /** Safe, bounded, operator-facing message (no secrets, no raw output). */
  message: string;
}

/** The durable flow row (`login_flows`); mirrored verbatim as `hive_login_flows`. */
export interface LoginFlowRow {
  id: string;
  account: string;
  harness: string;
  /** Provider selected inside the harness (OpenCode provider id), or null. */
  provider: string | null;
  /** Bumped on retry / reissued authorization URL so clients open a URL exactly once per revision. */
  revision: number;
  /** Selected method id (one of `methods[].id`), or null before selection. */
  methodId: string | null;
  methods: LoginMethodDescriptor[];
  phase: LoginFlowPhase;
  /** Safe operator-facing progress text (static recipe strings only). */
  detail: string | null;
  authorizationUrl: string | null;
  userCode: string | null;
  /** The fields currently requested (empty unless `waiting_input`). */
  inputFields: LoginFieldDescriptor[];
  error: LoginFlowError | null;
  retryable: boolean;
  /** The client declared the node remote from its browser (method filtering). */
  remote: boolean;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  completedAt: number | null;
}

/** Keys of a flow row — the mirror shape snapshot (see mirror.ts). */
export const LOGIN_FLOW_KEYS = [
  "id",
  "account",
  "harness",
  "provider",
  "revision",
  "methodId",
  "methods",
  "phase",
  "detail",
  "authorizationUrl",
  "userCode",
  "inputFields",
  "error",
  "retryable",
  "remote",
  "createdAt",
  "updatedAt",
  "expiresAt",
  "completedAt",
] as const;

/** The parts of a flow row a runner may change after creation. */
export type LoginFlowPatch = Partial<
  Pick<
    LoginFlowRow,
    | "provider"
    | "revision"
    | "methodId"
    | "phase"
    | "detail"
    | "authorizationUrl"
    | "userCode"
    | "inputFields"
    | "error"
    | "retryable"
    | "expiresAt"
    | "completedAt"
  >
>;

/** Validate a client-facing URL for the flow row: https only (http only for loopback), no credentials, bounded. */
export interface LoginAuthorizationPolicy {
  hosts: readonly string[];
  paths: readonly string[];
  parameters: readonly string[];
  claudeCodeFlag?: boolean;
}

const LOGIN_CREDENTIAL_WORDS = new Set(["code", "token", "access_token", "id_token", "refresh_token", "password", "secret", "apikey", "api_key", "key", "auth", "assertion", "session", "credential", "passwd", "cookie", "signature", "sig", "authorization", "bearer", "otp", "passphrase", "pin", "secretref"]);

function credentialParameter(name: string): boolean {
  let decoded = name;
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      return true;
    }
  }
  if (["code_challenge", "code_challenge_method"].includes(decoded.toLowerCase())) return false;
  const matches = (word: string): boolean => LOGIN_CREDENTIAL_WORDS.has(word) || word.endsWith("s") && LOGIN_CREDENTIAL_WORDS.has(word.slice(0, -1));
  const words = decoded.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  return matches(decoded.toLowerCase()) || matches(words) || words.split(/[^a-z0-9]+/).some(matches);
}

function credentialValue(value: string): boolean {
  let decoded = value;
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      return true;
    }
  }
  if (/\b(?:Bearer\s+|(?:sk|xai|ghp|github_pat)[-_][a-z0-9]|eyJ[a-z0-9_-]+\.eyJ|-----BEGIN .*PRIVATE KEY)/i.test(decoded)) return true;
  if (/^https?:/i.test(decoded)) {
    try {
      const nested = new URL(decoded);
      if (nested.username || nested.password || nested.hash) return true;
      if ([...nested.searchParams].some(([name, content]) => credentialParameter(name) || credentialValue(content))) return true;
    } catch {
      return true;
    }
  }
  for (const match of decoded.matchAll(/(?:^|[?&#;\s{,"'])([a-z0-9_%.-]+)["']?\s*[:=]/gi)) {
    if (credentialParameter(match[1]!)) return true;
  }
  return false;
}

export function safeAuthorizationUrl(candidate: string, policy: LoginAuthorizationPolicy | "cli"): string | null {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 4096) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return null;
  if (policy !== "cli" && (!policy.hosts.includes(url.hostname) || !policy.paths.includes(url.pathname) || url.port)) return null;
  url.hash = "";
  for (const name of [...url.searchParams.keys()]) {
    const claudeFlag = policy !== "cli" && policy.claudeCodeFlag === true && name === "code" && url.searchParams.getAll(name).length === 1 && url.searchParams.get(name) === "true";
    if (!claudeFlag && (credentialParameter(name) || policy !== "cli" && !policy.parameters.includes(name))) url.searchParams.delete(name);
  }
  if (credentialValue(url.pathname) || [...url.searchParams.values()].some(credentialValue)) return null;
  return url.toString();
}
