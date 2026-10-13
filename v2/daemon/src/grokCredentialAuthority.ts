import { CredentialAuthority, type CentralCredentialOptions, type CredentialCodec } from "./claudeCredentialAuthority.ts";
import { oauthRefreshTransport, type CredentialRefreshTransport } from "./claudeRefreshTransport.ts";

export const GROK_OAUTH_ISSUER = "https://auth.x.ai";
export const GROK_OAUTH_TOKEN_URL = "https://auth.x.ai/oauth2/token";

export function grokCredentialEntry(document: Record<string, unknown>): { scope: string; entry: Record<string, unknown>; expiresAt: number } | null {
  const entries = Object.entries(document);
  if (entries.length !== 1) return null;
  const [scope, raw] = entries[0]!;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  if (entry.auth_mode !== "oidc" || entry.oidc_issuer !== GROK_OAUTH_ISSUER
    || typeof entry.oidc_client_id !== "string" || !entry.oidc_client_id
    || scope !== `${GROK_OAUTH_ISSUER}::${entry.oidc_client_id}`
    || typeof entry.key !== "string" || !entry.key
    || (entry.refresh_token !== undefined && entry.refresh_token !== null && typeof entry.refresh_token !== "string")) return null;
  const expiresAt = typeof entry.expires_at === "string" ? Date.parse(entry.expires_at) : NaN;
  return Number.isFinite(expiresAt) ? { scope, entry, expiresAt } : null;
}

export const GROK_CREDENTIAL_CODEC: CredentialCodec = {
  harness: "grok", label: "Grok", nativeLoginRecovery: true, retainRotatedOnUnusableAccess: true,
  parse: raw => {
    try {
      const value = grokCredentialEntry(JSON.parse(raw));
      return value ? { accessToken: value.entry.key as string, refreshToken: typeof value.entry.refresh_token === "string" ? value.entry.refresh_token : undefined, expiresAt: value.expiresAt } : null;
    } catch { return null; }
  },
  merge: (document, token, at) => {
    const value = grokCredentialEntry(document)!;
    const usableMaterial = Boolean(token.accessToken) && token.expiresAt > 0 && Number.isFinite(new Date(token.expiresAt).getTime());
    return { ...document, [value.scope]: { ...value.entry,
      key: usableMaterial ? token.accessToken : value.entry.key, refresh_token: token.refreshToken,
      create_time: new Date(at).toISOString(),
      expires_at: usableMaterial ? new Date(token.expiresAt).toISOString() : value.entry.expires_at } };
  },
};

export function grokAccessOnly(document: Record<string, unknown>): Record<string, unknown> {
  const value = grokCredentialEntry(document)!;
  const { refresh_token, ...entry } = value.entry;
  return { [value.scope]: entry };
}

export function defaultGrokRefreshTransport(timeoutMs: number, now: () => number = Date.now, endpoint?: string): CredentialRefreshTransport {
  return async (refreshToken, document) => {
    const value = document ? grokCredentialEntry(document) : null;
    if (!value) return { kind: "retryable", httpStatus: null, error: null, description: "Grok credential requires one first-party OIDC scope" };
    const parameters: Record<string, string> = {};
    for (const field of ["principal_type", "principal_id"]) {
      if (typeof value.entry[field] === "string") parameters[field] = value.entry[field];
    }
    return oauthRefreshTransport({ timeoutMs, now, form: true, parameters, providerDescriptions: false,
      clientId: value.entry.oidc_client_id as string,
      endpoint: () => endpoint ?? process.env.HIVE_GROK_OAUTH_TOKEN_URL ?? GROK_OAUTH_TOKEN_URL,
      decode: (body, previousRefreshToken, at) => {
        if (body.refresh_token !== undefined && body.refresh_token !== null && (typeof body.refresh_token !== "string" || !body.refresh_token)) return null;
        const candidateExpiry = typeof body.expires_in === "number" && Number.isFinite(body.expires_in) ? at + body.expires_in * 1000 : at + 3600 * 1000;
        const expiresAt = Number.isFinite(new Date(candidateExpiry).getTime()) ? candidateExpiry : 0;
        const accessToken = typeof body.access_token === "string" ? body.access_token : "";
        return { accessToken, refreshToken: body.refresh_token as string | undefined ?? previousRefreshToken,
          expiresAt, accessUsable: Boolean(accessToken) && expiresAt > at };
      },
    })(refreshToken);
  };
}

export class GrokCredentialAuthority extends CredentialAuthority {
  constructor(options: CentralCredentialOptions) { super({ ...options, codec: GROK_CREDENTIAL_CODEC }); }
}
