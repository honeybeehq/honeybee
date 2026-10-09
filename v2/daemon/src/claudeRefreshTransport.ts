/**
 * The Claude OAuth refresh transport and its typed outcome. A refresh token
 * rotates on use, so the caller must know whether the provider processed the
 * request: `rejected` and `retryable` prove the token is unconsumed,
 * `unknown_outcome` does not. Nothing here ever carries token content.
 */
import { CLAUDE_OAUTH_CLIENT_ID, claudeOauthTokenUrl, expiryFromSeconds } from "./login/transports.ts";

export interface RefreshedClaudeToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  /** When the refresh token itself stops working; absent when the provider did not say. */
  refreshTokenExpiresAt?: number;
  scopes?: string[];
}

export type ClaudeRefreshResult =
  | { kind: "success"; token: RefreshedClaudeToken }
  /** The provider definitively refused the refresh token: only a new login recovers. */
  | { kind: "rejected"; httpStatus: number; error: string | null; description: string | null }
  /** The request was not processed (connect failure before send, 429, a non-auth 4xx, the provider's own `overloaded_error`): the token is unconsumed. */
  | { kind: "retryable"; httpStatus: number | null; error: string | null; description: string | null; retryAfterMs?: number }
  /** The request was sent and no answer proves what happened to it (no response, a gateway or server error, an unusable 2xx): the token may be consumed. */
  | { kind: "unknown_outcome"; description: string };

export type ClaudeRefreshFailure = Exclude<ClaudeRefreshResult, { kind: "success" }>;

export type ClaudeRefreshTransport = (refreshToken: string) => Promise<ClaudeRefreshResult>;

/** RFC 6749 §5.2 token-endpoint errors plus Anthropic's API error types; anything else is not echoed. */
const OAUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  "invalid_request", "invalid_client", "invalid_grant", "unauthorized_client", "unsupported_grant_type", "invalid_scope",
  "access_denied", "server_error", "temporarily_unavailable",
  "invalid_request_error", "authentication_error", "permission_error", "not_found_error", "rate_limit_error", "api_error", "overloaded_error",
]);

/** The socket never carried the request, so the provider cannot have consumed the token. */
const NOT_SENT_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "EHOSTDOWN", "ENETDOWN", "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * The one 5xx answer that proves no rotation happened: the provider's own
 * structured error saying it shed the request. A status code alone does not,
 * because a gateway can answer 500/502/503/504 after the provider committed
 * the rotation.
 */
const PROVIDER_SHED_REQUEST_ERROR = "overloaded_error";

const DESCRIPTION_MAX_CHARS = 200;
const RETRY_AFTER_MAX_MS = 60 * 60_000;
const TOKEN_SHAPED = /\b(?:sk-ant-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+)*|[A-Za-z0-9_\-+/=]{32,})/g;

/** A provider-authored sentence made safe to log and store: bounded, single-line, no token-shaped runs. */
export function sanitizeProviderText(text: unknown, secrets: readonly string[] = []): string | null {
  if (typeof text !== "string") return null;
  let safe = text;
  for (const secret of secrets) if (secret) safe = safe.split(secret).join("[redacted]");
  safe = safe.replace(TOKEN_SHAPED, "[redacted]").replace(/[^\x20-\x7e]+/g, " ").replace(/\s+/g, " ").trim().slice(0, DESCRIPTION_MAX_CHARS);
  return safe || null;
}

/** `{error, error_description}` (RFC 6749) or Anthropic's `{error: {type, message}}`. */
export function oauthErrorOf(body: unknown, secrets: readonly string[] = []): { error: string | null; description: string | null } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: null, description: null };
  const record = body as Record<string, unknown>;
  const nested = record.error && typeof record.error === "object" && !Array.isArray(record.error) ? record.error as Record<string, unknown> : null;
  const code = nested ? nested.type : record.error;
  return {
    error: typeof code === "string" && OAUTH_ERROR_CODES.has(code) ? code : null,
    description: sanitizeProviderText(nested ? nested.message : record.error_description, secrets),
  };
}

export function describeRefreshFailure(failure: { httpStatus?: number | null; error?: string | null; description?: string | null }): string {
  const status = failure.httpStatus != null ? `HTTP ${failure.httpStatus}` : null;
  const head = [status, failure.error].filter(Boolean).join(" ");
  return [head, failure.description].filter(Boolean).join(head && failure.description ? ": " : "") || "no detail";
}

function retryAfterMsOf(response: Response, now: number): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, RETRY_AFTER_MAX_MS) : undefined;
}

function errorCodeOf(error: unknown): string | null {
  for (let current: unknown = error, depth = 0; current && typeof current === "object" && depth < 4; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export function defaultClaudeRefreshTransport(timeoutMs: number, now: () => number = Date.now): ClaudeRefreshTransport {
  return async (refreshToken) => {
    let response: Response;
    try {
      response = await fetch(claudeOauthTokenUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLAUDE_OAUTH_CLIENT_ID }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const code = errorCodeOf(error);
      if (code !== null && NOT_SENT_ERROR_CODES.has(code)) {
        return { kind: "retryable", httpStatus: null, error: null, description: `connection failed before the request was sent (${code})` };
      }
      const name = error instanceof Error ? error.name : "Error";
      return { kind: "unknown_outcome", description: name === "TimeoutError" || name === "AbortError"
        ? `no response within ${timeoutMs} ms`
        : `connection lost after the request was sent (${code ?? name})` };
    }
    const secrets = [refreshToken];
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const detail = oauthErrorOf(body, secrets);
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        return { kind: "rejected", httpStatus: response.status, ...detail };
      }
      if (response.status >= 500 && detail.error !== PROVIDER_SHED_REQUEST_ERROR) {
        return { kind: "unknown_outcome", description: `${describeRefreshFailure({ httpStatus: response.status, ...detail })} after the request was sent` };
      }
      const retryAfterMs = retryAfterMsOf(response, now());
      return { kind: "retryable", httpStatus: response.status, ...detail, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    }
    let fresh: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; refresh_token_expires_in?: unknown; scope?: unknown };
    try {
      fresh = (await response.json()) as typeof fresh;
    } catch {
      return { kind: "unknown_outcome", description: `HTTP ${response.status} with an unparseable token response` };
    }
    if (typeof fresh?.access_token !== "string" || !fresh.access_token) {
      return { kind: "unknown_outcome", description: `HTTP ${response.status} without an access token` };
    }
    const at = now();
    const refreshTokenExpiresAt = expiryFromSeconds(fresh.refresh_token_expires_in, at);
    return { kind: "success", token: {
      accessToken: fresh.access_token,
      refreshToken: typeof fresh.refresh_token === "string" && fresh.refresh_token ? fresh.refresh_token : refreshToken,
      expiresAt: at + (typeof fresh.expires_in === "number" ? fresh.expires_in : 3600) * 1000,
      ...(refreshTokenExpiresAt !== undefined ? { refreshTokenExpiresAt } : {}),
      ...(typeof fresh.scope === "string" ? { scopes: fresh.scope.split(" ").filter(Boolean) } : {}),
    } };
  };
}
