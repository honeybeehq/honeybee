/**
 * Provider transports the direct runners talk to (Claude OAuth token
 * exchange / validation, Meta's device authorization for Muse, OpenAI +
 * Anthropic key checks). Injected so the
 * service tests never touch the network; the defaults are the real
 * providers with one bounded timeout.
 */

/** Who a Claude OAuth grant belongs to; secret-free. */
export interface ClaudeIdentity {
  accountUuid: string;
  organizationUuid: string | null;
}

export interface ClaudeTokenGrant {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  /** When the login itself ends (the refresh token's hard lifetime); absent when the provider did not say. */
  refreshTokenExpiresAt?: number;
  scopes: string[];
  /** The provider's account and organization for this grant, when the token response names them. */
  identity?: ClaudeIdentity;
}

export type KeyCheck = "valid" | "invalid" | "unverified";

/** Meta's answer to a device authorization request; `verificationUriComplete` already carries the code. */
export type MuseDeviceAuthorization =
  | { ok: true; deviceCode: string; userCode: string; verificationUri: string; verificationUriComplete: string | null; expiresInSeconds: number; intervalSeconds: number }
  | { ok: false; status: number };

/** One poll of Meta's device token endpoint (RFC 8628 §3.5). */
export type MuseDevicePoll =
  | { kind: "granted"; accessToken: string; refreshToken: string | null; expiresInSeconds: number }
  | { kind: "pending" }
  | { kind: "slow_down" }
  | { kind: "denied" }
  | { kind: "expired" }
  /** A 2xx without a usable access token and lifetime. */
  | { kind: "unusable" }
  | { kind: "refused"; status: number };

export interface LoginTransports {
  /** Exchange a pasted `code#state` for tokens (PKCE). null = the provider rejected it. Throws on transport failure. */
  claudeTokenExchange: (input: { code: string; state: string; codeVerifier: string; redirectUri: string; clientId: string }) => Promise<ClaudeTokenGrant | null>;
  /** Prove the access token authenticates (the usage endpoint) — the validation step. Throws on transport failure; false on 401/403. */
  claudeTokenCheck: (accessToken: string) => Promise<boolean>;
  /** Best-effort subscription type for the credential document (Claude Code reads it); null when unknown. */
  claudeSubscriptionType: (accessToken: string) => Promise<string | null>;
  /** The account and organization an access token belongs to (the profile endpoint); null when unknown. */
  claudeIdentity: (accessToken: string) => Promise<ClaudeIdentity | null>;
  /** Start Meta's device-code sign-in for the Muse CLI's public client. Throws on transport failure. */
  museDeviceAuthorize: () => Promise<MuseDeviceAuthorization>;
  /** Poll for the device code's grant. Throws on transport failure. */
  museDeviceToken: (deviceCode: string) => Promise<MuseDevicePoll>;
  /** OpenAI API key check (`GET /v1/models`). */
  openaiKeyCheck: (apiKey: string, baseUrl?: string) => Promise<KeyCheck>;
  /** Anthropic API key check (`GET /v1/models`). */
  anthropicKeyCheck: (apiKey: string, baseUrl?: string) => Promise<KeyCheck>;
}

// Claude Code's public OAuth client id (the one the CLI itself uses).
export const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
// Keep this contract aligned with `claude auth login`. Anthropic moved the
// Claude Code OAuth surface in 2.1.233; the retired claude.ai/console URLs
// reach the sign-in UI but are rejected after approval as "Invalid format".
export const CLAUDE_OAUTH_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
export const CLAUDE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const CLAUDE_OAUTH_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
export const CLAUDE_OAUTH_SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];

// The Muse CLI's own public client and device endpoints (its launcher,
// https://api.meta.ai/muse-launcher.sh, and the 1.4.7 binary). The CLI sends
// no scope parameter: the client id alone selects the grant.
export const MUSE_OAUTH_BASE_URL = "https://auth.meta.com";
export const MUSE_OAUTH_CLIENT_ID = "1031625952748946";
export const MUSE_OAUTH_DEVICE_AUTHORIZATION_PATH = "/oidc/device/authorization/";
export const MUSE_OAUTH_DEVICE_TOKEN_PATH = "/oidc/device/token/";
export const MUSE_OAUTH_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
// The launcher's bounds: poll every 5 s unless told otherwise, and a code
// lives 15 minutes unless told otherwise, clamped to 1–30 minutes.
const MUSE_DEFAULT_INTERVAL_SECONDS = 5;
const MUSE_DEFAULT_LIFETIME_SECONDS = 900;

/** HIVE_MUSE_OAUTH_URL points the Muse device login at a local stub for isolated daemon runs. */
export function museOauthBaseUrl(): string {
  return process.env.HIVE_MUSE_OAUTH_URL || MUSE_OAUTH_BASE_URL;
}

async function museAuthPost(baseUrl: string, path: string, form: Record<string, string>, timeoutMs: number): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    // Like the launcher: a redirect from the sign-in service is not followed.
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body: body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {} };
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function museDeviceAuthorize(timeoutMs: number, baseUrl = museOauthBaseUrl()): Promise<MuseDeviceAuthorization> {
  const { status, body } = await museAuthPost(baseUrl, MUSE_OAUTH_DEVICE_AUTHORIZATION_PATH, { client_id: MUSE_OAUTH_CLIENT_ID }, timeoutMs);
  if (status < 200 || status >= 300) return { ok: false, status };
  const deviceCode = nonEmpty(body.device_code);
  const userCode = nonEmpty(body.user_code);
  const verificationUri = nonEmpty(body.verification_uri);
  if (!deviceCode || !userCode || !verificationUri) return { ok: false, status };
  const lifetime = positiveInteger(body.expires_in) ?? MUSE_DEFAULT_LIFETIME_SECONDS;
  return {
    ok: true,
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: nonEmpty(body.verification_uri_complete),
    expiresInSeconds: Math.min(1800, Math.max(60, lifetime)),
    intervalSeconds: positiveInteger(body.interval) ?? MUSE_DEFAULT_INTERVAL_SECONDS,
  };
}

export async function museDeviceToken(deviceCode: string, timeoutMs: number, baseUrl = museOauthBaseUrl()): Promise<MuseDevicePoll> {
  const { status, body } = await museAuthPost(baseUrl, MUSE_OAUTH_DEVICE_TOKEN_PATH, { grant_type: MUSE_OAUTH_DEVICE_GRANT, device_code: deviceCode, client_id: MUSE_OAUTH_CLIENT_ID }, timeoutMs);
  if (status >= 200 && status < 300) {
    const accessToken = nonEmpty(body.access_token);
    const expiresInSeconds = positiveInteger(body.expires_in);
    if (!accessToken || expiresInSeconds === null) return { kind: "unusable" };
    return { kind: "granted", accessToken, refreshToken: nonEmpty(body.refresh_token), expiresInSeconds };
  }
  switch (body.error) {
    case "authorization_pending":
      return { kind: "pending" };
    case "slow_down":
      return { kind: "slow_down" };
    case "access_denied":
      return { kind: "denied" };
    case "expired_token":
      return { kind: "expired" };
    default:
      return { kind: "refused", status };
  }
}

/** HIVE_CLAUDE_OAUTH_TOKEN_URL points login and refresh at a local stub for isolated daemon runs. */
export function claudeOauthTokenUrl(): string {
  return process.env.HIVE_CLAUDE_OAUTH_TOKEN_URL || CLAUDE_OAUTH_TOKEN_URL;
}

function claudeProfileUrl(): string {
  return process.env.HIVE_CLAUDE_PROFILE_URL || "https://api.anthropic.com/api/oauth/profile";
}

function uuidOf(value: unknown): string | null {
  const uuid = value !== null && typeof value === "object" ? (value as { uuid?: unknown }).uuid : undefined;
  return typeof uuid === "string" && uuid.length > 0 ? uuid : null;
}

/** The identity a token or profile response names: `{account: {uuid}, organization: {uuid}}`. */
export function claudeIdentityOf(body: unknown): ClaudeIdentity | null {
  if (body === null || typeof body !== "object") return null;
  const record = body as { account?: unknown; organization?: unknown };
  const accountUuid = uuidOf(record.account);
  return accountUuid ? { accountUuid, organizationUuid: uuidOf(record.organization) } : null;
}

async function fetchClaudeProfile(accessToken: string, timeoutMs: number): Promise<unknown> {
  try {
    const response = await fetch(claudeProfileUrl(), {
      headers: { Authorization: `Bearer ${accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/** The account an access token belongs to, from the profile endpoint; null when the provider did not say. */
export async function fetchClaudeIdentity(accessToken: string, timeoutMs: number): Promise<ClaudeIdentity | null> {
  return claudeIdentityOf(await fetchClaudeProfile(accessToken, timeoutMs));
}

function claudeUsageUrl(): string {
  return process.env.HIVE_CLAUDE_USAGE_URL || "https://api.anthropic.com/api/oauth/usage";
}

/** Epoch ms from a token response's relative lifetime; undefined when the provider did not send one. */
export function expiryFromSeconds(seconds: unknown, now: number): number | undefined {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? Math.round(now + seconds * 1000) : undefined;
}

async function checkedJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function keyCheckFromStatus(status: number): KeyCheck {
  if (status === 401 || status === 403) return "invalid";
  if (status >= 200 && status < 300) return "valid";
  return "unverified";
}

export function defaultLoginTransports(timeoutMs: number): LoginTransports {
  return {
    claudeTokenExchange: async ({ code, state, codeVerifier, redirectUri, clientId }) => {
      const response = await fetch(claudeOauthTokenUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "authorization_code", code, state, client_id: clientId, redirect_uri: redirectUri, code_verifier: codeVerifier }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 400 || response.status === 401 || response.status === 403) return null;
      const body = (await checkedJson(response)) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; refresh_token_expires_in?: unknown; scope?: unknown; account?: unknown; organization?: unknown };
      if (typeof body.access_token !== "string" || typeof body.refresh_token !== "string") return null;
      const now = Date.now();
      const refreshTokenExpiresAt = expiryFromSeconds(body.refresh_token_expires_in, now);
      const identity = claudeIdentityOf(body);
      return {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresAt: now + (typeof body.expires_in === "number" ? body.expires_in : 3600) * 1000,
        ...(refreshTokenExpiresAt !== undefined ? { refreshTokenExpiresAt } : {}),
        scopes: typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : CLAUDE_OAUTH_SCOPES,
        ...(identity ? { identity } : {}),
      };
    },
    claudeTokenCheck: async (accessToken) => {
      const response = await fetch(claudeUsageUrl(), {
        headers: { Authorization: `Bearer ${accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 401 || response.status === 403) return false;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return true;
    },
    claudeSubscriptionType: async (accessToken) => {
      const body = (await fetchClaudeProfile(accessToken, timeoutMs)) as { organization?: { organization_type?: unknown }; account?: { has_claude_max?: unknown; has_claude_pro?: unknown } } | null;
      const type = body?.organization?.organization_type;
      if (typeof type === "string" && type.startsWith("claude_")) return type.slice("claude_".length);
      if (body?.account?.has_claude_max === true) return "max";
      if (body?.account?.has_claude_pro === true) return "pro";
      return null;
    },
    claudeIdentity: (accessToken) => fetchClaudeIdentity(accessToken, timeoutMs),
    museDeviceAuthorize: () => museDeviceAuthorize(timeoutMs),
    museDeviceToken: (deviceCode) => museDeviceToken(deviceCode, timeoutMs),
    openaiKeyCheck: async (apiKey, baseUrl) => {
      const response = await fetch(`${(baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "")}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      return keyCheckFromStatus(response.status);
    },
    anthropicKeyCheck: async (apiKey, baseUrl) => {
      const response = await fetch(`${(baseUrl ?? "https://api.anthropic.com/v1").replace(/\/+$/, "")}/models`, {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      return keyCheckFromStatus(response.status);
    },
  };
}
