import { CredentialOwnershipConflict, CredentialAuthority, type CentralCredentialOptions, type CredentialCodec } from "./claudeCredentialAuthority.ts";
import { oauthRefreshTransport, type CredentialRefreshTransport } from "./claudeRefreshTransport.ts";

export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";

export function codexAccessExpiry(accessToken: string): number | null {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    const expiresAt = typeof payload.exp === "number" ? payload.exp * 1000 : NaN;
    return Number.isFinite(expiresAt) && expiresAt > 0 && Number.isFinite(new Date(expiresAt).getTime()) ? expiresAt : null;
  } catch { return null; }
}

export const CODEX_CREDENTIAL_CODEC: CredentialCodec = {
  harness: "codex", label: "Codex", retainRotatedOnUnusableAccess: true, nativeLoginRecovery: true,
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
    tokens: { ...(document.tokens as Record<string, unknown>), access_token: (codexAccessExpiry(token.accessToken) ?? 0) <= at ? (document.tokens as Record<string, unknown>).access_token : token.accessToken, refresh_token: token.refreshToken,
      ...(token.idToken !== undefined ? { id_token: token.idToken } : {}) },
    last_refresh: new Date(at).toISOString(),
  }),
};

export function defaultCodexRefreshTransport(timeoutMs: number, now: () => number = Date.now, endpoint?: string): CredentialRefreshTransport {
  return oauthRefreshTransport({ timeoutMs, now, providerDescriptions: false, clientId: CODEX_OAUTH_CLIENT_ID,
    endpoint: () => endpoint ?? process.env.HIVE_CODEX_OAUTH_TOKEN_URL ?? CODEX_OAUTH_TOKEN_URL,
    decode: (body, previousRefreshToken, at) => {
      const expiresAt = typeof body.access_token === "string" ? codexAccessExpiry(body.access_token) : null;
      if (body.refresh_token != null && (typeof body.refresh_token !== "string" || !body.refresh_token)) return null;
      return { accessToken: typeof body.access_token === "string" ? body.access_token : "", refreshToken: body.refresh_token as string | undefined ?? previousRefreshToken,
        expiresAt: expiresAt ?? 0, accessUsable: expiresAt !== null && expiresAt > at, ...(typeof body.id_token === "string" && body.id_token ? { idToken: body.id_token } : {}) };
    },
  });
}

export class CodexCredentialAuthority extends CredentialAuthority {
  constructor(options: CentralCredentialOptions) { super({ ...options, codec: CODEX_CREDENTIAL_CODEC }); }
}

export function readCodexCredentialCopy(read: () => string | null, account: string): ReturnType<CredentialCodec["parse"]> {
  let raw = read();
  if (raw !== null && raw.trim() === "") raw = read();
  if (raw === null) return null;
  const credential = CODEX_CREDENTIAL_CODEC.parse(raw);
  if (!credential) throw new CredentialOwnershipConflict(`A Codex credential copy is invalid after re-reading; stop external Codex processes, then run hive account credentials disable ${account}; hive account login ${account}; hive account credentials enable ${account}.`);
  return credential;
}
