import { CredentialAuthority, type CentralCredentialOptions, type CredentialCodec } from "./claudeCredentialAuthority.ts";
import type { CredentialRefreshTransport } from "./claudeRefreshTransport.ts";

export const MUSE_KEY_URL = "https://api.meta.ai/muse-code/key";
export const MUSE_DEFAULT_KEY_TTL_MS = 4 * 60 * 60_000;
export const MUSE_MINT_FLOOR_MS = 5 * 60_000;

export function museMeta(document: Record<string, unknown>): Record<string, unknown> | null {
  const providers = document.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return null;
  const meta = (providers as Record<string, unknown>).meta;
  return meta && typeof meta === "object" && !Array.isArray(meta) ? meta as Record<string, unknown> : null;
}

export function museWorkingDocument(document: Record<string, unknown>): Record<string, unknown> {
  const meta = museMeta(document);
  if (!meta || typeof meta.api_key !== "string" || !meta.api_key) throw new Error("Muse working key is unavailable");
  return { schema_version: 1, providers: { meta: { api_key: meta.api_key,
    ...(typeof meta.api_base_url === "string" ? { api_base_url: meta.api_base_url } : {}) } } };
}

export const MUSE_CREDENTIAL_CODEC: CredentialCodec = {
  harness: "muse", label: "Muse", rotatesRefresh: false, minimumRenewalIntervalMs: MUSE_MINT_FLOOR_MS,
  parse: raw => {
    try {
      const meta = museMeta(JSON.parse(raw));
      if (!meta || meta.storage === "keychain") return null;
      const accessToken = typeof meta.api_key === "string" ? meta.api_key : "";
      const bootstrapToken = typeof meta.access_token === "string" && meta.access_token ? meta.access_token : undefined;
      if (!accessToken && !bootstrapToken) return null;
      const expiresAt = typeof meta.api_key_expires_at === "number" && Number.isFinite(meta.api_key_expires_at) ? meta.api_key_expires_at * 1000 : 0;
      return { accessToken, bootstrapToken, expiresAt };
    } catch { return null; }
  },
  merge: (document, token) => ({ schema_version: 1, providers: { meta: { ...museMeta(document),
    previous_api_key: museMeta(document)?.api_key,
    api_key: token.accessToken, api_base_url: token.apiBaseUrl, api_key_expires_at: token.expiresAt / 1000 } } }),
};

export function defaultMuseKeyTransport(timeoutMs: number, now: () => number = Date.now, fetchImpl: typeof fetch = fetch): CredentialRefreshTransport {
  return async bootstrap => {
    let response: Response;
    try {
      response = await fetchImpl(MUSE_KEY_URL, { method: "POST", headers: { Authorization: `Bearer ${bootstrap}`, "x-api-version": "1.0.0", "Content-Type": "application/json" },
        body: JSON.stringify({ onboard: false }), signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    } catch { return { kind: "unknown_outcome", description: "Muse key mint transport did not return a response" }; }
    if (response.status === 401 || response.status === 403) return { kind: "rejected", httpStatus: response.status, error: "authentication_error", description: "Meta refused the held login; sign in again" };
    if (response.status >= 500) return { kind: "unknown_outcome", description: "Meta key mint returned a server error" };
    if (!response.ok) {
      const header = response.headers.get("retry-after");
      const seconds = header === null ? NaN : Number(header);
      const delay = Number.isFinite(seconds) ? seconds * 1000 : header ? Date.parse(header) - now() : NaN;
      return { kind: "retryable", httpStatus: response.status, error: null, description: "Meta key mint did not succeed",
        ...(Number.isFinite(delay) && delay > 0 ? { retryAfterMs: Math.min(delay, 60 * 60_000) } : {}) };
    }
    try {
      const body = await response.json() as Record<string, unknown>;
      if (typeof body.api_key !== "string" || !body.api_key || typeof body.base_url !== "string") throw new Error();
      const base = new URL(body.base_url);
      if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error();
      const at = now();
      let expiresAt = at + MUSE_DEFAULT_KEY_TTL_MS;
      if (body.expires_in !== undefined) {
        if (typeof body.expires_in !== "number" || !Number.isFinite(body.expires_in) || body.expires_in <= 0) throw new Error();
        expiresAt = at + body.expires_in * 1000;
      }
      if (body.expires_at !== undefined) {
        const expiry = typeof body.expires_at === "number" ? body.expires_at * (body.expires_at > 1e11 ? 1 : 1000) : typeof body.expires_at === "string" ? Date.parse(body.expires_at) : NaN;
        if (!Number.isFinite(expiry)) throw new Error();
        expiresAt = body.expires_in === undefined ? expiry : Math.min(expiry, expiresAt);
      }
      if (!Number.isFinite(expiresAt) || expiresAt <= at || !Number.isFinite(new Date(expiresAt).getTime())) throw new Error();
      return { kind: "success", token: { accessToken: body.api_key, apiBaseUrl: base.href, expiresAt } };
    } catch { return { kind: "unknown_outcome", description: "Meta returned unusable key material or lifetime" }; }
  };
}

export class MuseCredentialAuthority extends CredentialAuthority {
  constructor(options: CentralCredentialOptions) { super({ ...options, codec: MUSE_CREDENTIAL_CODEC }); }
}
