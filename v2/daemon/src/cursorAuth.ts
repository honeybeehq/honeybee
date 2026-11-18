/**
 * Minimal Cursor credential bridge required by spec 08.
 *
 * Cursor's login secret is machine-global (macOS Keychain, or the global
 * auth.json fallback); CURSOR_CONFIG_DIR only relocates cli-config.json. An
 * explicit account.login therefore watches this live store for digest drift
 * and snapshots the resulting auth.json into that account's one home/vault.
 * At runtime we lift the home snapshot into Cursor's documented env override
 * so two account homes do not depend on whichever identity touched the global
 * slot last.
 *
 * Login and capture still take the store explicitly. Since ADR 004
 * (docs/adr/004-cursor-recapture-machine-login.md) the authority node also
 * re-reads it on demand: only when the cached token is near its JWT exp or
 * a probe got a 401, and only for the same Cursor user (JWT `sub`). There is
 * no background harvesting, and Honeybee never calls a Cursor refresh endpoint.
 */
import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { keychainAvailable } from "./keychain.ts";
import { securityExecutable } from "./nativeKeychain.ts";

const execFileAsync = promisify(execFile);
const SECURITY_EXEC_TIMEOUT_MS = 60_000;

export interface CursorAuthSnapshot {
  raw: string;
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
  source: string;
}

export type CursorAuthReader = () => Promise<CursorAuthSnapshot | null>;

/** Parse Cursor's own auth.json shape. A refresh token alone cannot authenticate a run. */
export function parseCursorAuth(raw: string | null, source = "auth.json"): CursorAuthSnapshot | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const accessToken = typeof value.accessToken === "string" && value.accessToken.length > 0 ? value.accessToken : undefined;
    const refreshToken = typeof value.refreshToken === "string" && value.refreshToken.length > 0 ? value.refreshToken : undefined;
    const apiKey = typeof value.apiKey === "string" && value.apiKey.length > 0 ? value.apiKey : undefined;
    if (!accessToken && !apiKey) return null;
    return {
      raw,
      ...(accessToken ? { accessToken } : {}),
      ...(refreshToken ? { refreshToken } : {}),
      ...(apiKey ? { apiKey } : {}),
      source,
    };
  } catch {
    return null;
  }
}

function cursorGlobalAuthPath(env: Record<string, string | undefined> = process.env): string {
  const override = env.HIVE_CURSOR_AUTH_PATH?.trim();
  if (override) return override;
  if (process.platform === "darwin") return join(homedir(), ".cursor", "auth.json");
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(xdg || join(homedir(), ".config"), "cursor", "auth.json");
}

function readCursorAuthFile(path: string): CursorAuthSnapshot | null {
  try {
    if (!statSync(path).isFile()) return null;
    return parseCursorAuth(readFileSync(path, "utf8"), path);
  } catch {
    return null;
  }
}

async function readCursorKeychainSecret(service: string): Promise<string | undefined> {
  const security = securityExecutable();
  try {
    const { stdout } = await execFileAsync(
      security,
      ["find-generic-password", "-a", "cursor-user", "-s", service, "-w"],
      { timeout: SECURITY_EXEC_TIMEOUT_MS },
    );
    const value = String(stdout).trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The login document Honeybee keeps from Cursor's store: the access token and
 * its refresh token only. Cursor's machine-wide API key is never captured.
 */
export function cursorLoginDocument(auth: { accessToken: string; refreshToken?: string }): string {
  return `${JSON.stringify({ accessToken: auth.accessToken, ...(auth.refreshToken ? { refreshToken: auth.refreshToken } : {}) }, null, 2)}\n`;
}

/**
 * Read the live credential store written by `cursor-agent login` as one
 * snapshot. The Keychain holds the tokens as separate items, so the access
 * token is read again after the refresh token: if cursor-agent rotated in
 * between, the read is retried once and otherwise reported as absent rather
 * than pairing tokens from two logins. Only the access and refresh tokens are
 * returned; Cursor's machine-wide API key is not.
 */
export const readCursorLiveAuth: CursorAuthReader = async () => {
  if (keychainAvailable()) {
    let torn = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const accessToken = await readCursorKeychainSecret("cursor-access-token");
      if (!accessToken) break;
      const refreshToken = await readCursorKeychainSecret("cursor-refresh-token");
      const confirm = await readCursorKeychainSecret("cursor-access-token");
      if (confirm !== accessToken) {
        torn = true;
        continue;
      }
      return parseCursorAuth(cursorLoginDocument({ accessToken, ...(refreshToken ? { refreshToken } : {}) }), "keychain");
    }
    // Rotating twice in a row: report nothing rather than a mixed pair.
    if (torn) return null;
  }
  const file = readCursorAuthFile(cursorGlobalAuthPath());
  if (!file?.accessToken) return null;
  return parseCursorAuth(cursorLoginDocument({ accessToken: file.accessToken, ...(file.refreshToken ? { refreshToken: file.refreshToken } : {}) }), file.source);
};

/** Runtime-only secret env derived from an account's authoritative home. */
export function cursorCredentialEnv(homePath: string): Record<string, string> {
  const auth = readCursorAuthFile(join(homePath, "auth.json"));
  if (auth?.apiKey) return { CURSOR_API_KEY: auth.apiKey };
  if (auth?.accessToken) return { CURSOR_AUTH_TOKEN: auth.accessToken };
  return {};
}

/** The claims Honeybee relies on in a Cursor access token. */
export interface CursorTokenClaims {
  iss: string;
  sub: string;
  /** JWT `exp`, epoch milliseconds. */
  expiresAt: number;
}

function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * The identity claims of a Cursor access token, or null. The token must be a
 * signed JWT shape (a header `alg` other than `none`, a non-empty signature)
 * carrying string `iss` and `sub` and a numeric `exp`. Honeybee cannot verify
 * Cursor's signature; this only tells two tokens Cursor issued apart. Anyone
 * who can write the user's own credential store already owns the user.
 */
export function cursorTokenClaims(token: string | undefined): CursorTokenClaims | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  const header = decodeSegment(parts[0]);
  const alg = header?.alg;
  if (typeof alg !== "string" || alg.length === 0 || alg.toLowerCase() === "none") return null;
  const claims = decodeSegment(parts[1]);
  if (!claims) return null;
  const { iss, sub, exp } = claims;
  if (typeof iss !== "string" || !iss || typeof sub !== "string" || !sub || typeof exp !== "number" || !Number.isFinite(exp) || exp <= 0) return null;
  return { iss, sub, expiresAt: exp * 1000 };
}

/** The Cursor user a credential belongs to (`iss` + `sub`), or null when the token carries no readable identity. */
export function cursorTokenIdentity(auth: Pick<CursorAuthSnapshot, "accessToken"> | null): string | null {
  const claims = cursorTokenClaims(auth?.accessToken);
  return claims ? `${claims.iss}#${claims.sub}` : null;
}

export type CursorIdentityVerdict = "same" | "different" | "unverified" | "first";

/**
 * Whether a captured Cursor credential belongs to the user the account
 * already holds. `heldIdentity` is the account's identity (see
 * AccountsService.cursorHeldIdentity); null only when no copy the account
 * holds carries one. `first` = nothing to compare against, so anything is
 * accepted; `unverified` = the account has an identity but the new
 * credential carries none.
 */
export function cursorIdentityVerdict(heldIdentity: string | null, nextRaw: string | null): CursorIdentityVerdict {
  if (heldIdentity === null) return "first";
  const next = cursorTokenIdentity(parseCursorAuth(nextRaw));
  if (next === null) return "unverified";
  return next === heldIdentity ? "same" : "different";
}
