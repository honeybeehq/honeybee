import { CredentialAuthority, type CentralCredentialOptions, type CredentialCodec } from "./claudeCredentialAuthority.ts";
import { oauthRefreshTransport, type CredentialRefreshTransport } from "./claudeRefreshTransport.ts";

export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";

export function codexAccessExpiry(accessToken: string): number | null {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) && payload.exp > 0 ? payload.exp * 1000 : null;
  } catch { return null; }
}

export const CODEX_CREDENTIAL_CODEC: CredentialCodec = {
  harness: "codex", label: "Codex",
  parse: raw => {
    try {
      const document = JSON.parse(raw) as Record<string, unknown>;
      if (!document || typeof document !== "object" || Array.isArray(document)) return null;
      const tokens = document.tokens as Record<string, unknown> | undefined;
      if (!tokens || typeof tokens.access_token !== "string" || !tokens.access_token || typeof tokens.refresh_token !== "string") return null;
      const expiresAt = codexAccessExpiry(tokens.access_token);
      return expiresAt === null ? null : { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt };
    } catch { return null; }
  },
  merge: (document, token, at) => ({
    ...document, OPENAI_API_KEY: null,
    tokens: { ...(document.tokens as Record<string, unknown>), access_token: token.accessToken, refresh_token: token.refreshToken,
      ...(token.idToken !== undefined ? { id_token: token.idToken } : {}) },
    last_refresh: new Date(at).toISOString(),
  }),
};

export function defaultCodexRefreshTransport(timeoutMs: number, now: () => number = Date.now, endpoint?: string): CredentialRefreshTransport {
  return oauthRefreshTransport({ timeoutMs, now, providerDescriptions: false, clientId: CODEX_OAUTH_CLIENT_ID,
    endpoint: () => endpoint ?? process.env.HIVE_CODEX_OAUTH_TOKEN_URL ?? CODEX_OAUTH_TOKEN_URL,
    decode: (body, previousRefreshToken, at) => {
      const expiresAt = typeof body.access_token === "string" ? codexAccessExpiry(body.access_token) : null;
      if (expiresAt === null || expiresAt <= at) return null;
      if (body.refresh_token !== undefined && (typeof body.refresh_token !== "string" || !body.refresh_token)) return null;
      if (body.id_token !== undefined && (typeof body.id_token !== "string" || !body.id_token)) return null;
      return { accessToken: body.access_token as string, refreshToken: body.refresh_token as string | undefined ?? previousRefreshToken,
        expiresAt, ...(typeof body.id_token === "string" ? { idToken: body.id_token } : {}) };
    },
  });
}

export class CodexCredentialAuthority extends CredentialAuthority {
  constructor(options: CentralCredentialOptions) { super({ ...options, codec: CODEX_CREDENTIAL_CODEC }); }
}
