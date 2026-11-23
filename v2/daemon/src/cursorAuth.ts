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

export class CursorStoreUnavailableError extends Error {}

export type CursorAuthReader = (opts?: { timeoutMs?: number }) => Promise<CursorAuthSnapshot | null>;

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

async function readCursorKeychainSecret(service: string, shortTimeoutMs?: number): Promise<string | undefined> {
  const security = securityExecutable();
  try {
    const { stdout } = await execFileAsync(
      security,
      ["find-generic-password", "-a", "cursor-user", "-s", service, "-w"],
      { timeout: shortTimeoutMs ?? SECURITY_EXEC_TIMEOUT_MS, killSignal: "SIGKILL" },
    );
    const value = String(stdout).trim();
    return value.length > 0 ? value : undefined;
  } catch (error) {
    if (shortTimeoutMs !== undefined && (error as { killed?: boolean }).killed === true) {
      throw new CursorStoreUnavailableError("the Keychain did not answer in time");
    }
    return undefined;
  }
}

/**
 * The login document Honeybee keeps from Cursor's store: the access token
 * only. Honeybee never refreshes Cursor tokens, so it never takes the refresh
 * token, and it never takes Cursor's machine-wide API key.
 */
export function cursorLoginDocument(auth: { accessToken: string }): string {
  return `${JSON.stringify({ accessToken: auth.accessToken }, null, 2)}\n`;
}

/**
 * Read the access token from the live credential store written by
 * `cursor-agent login`: one Keychain item, else the global auth.json. One
 * value, so there is no snapshot of several items to tear.
 */
export const readCursorLiveAuth: CursorAuthReader = async (opts = {}) => {
  if (keychainAvailable()) {
    const accessToken = await readCursorKeychainSecret("cursor-access-token", opts.timeoutMs);
    if (accessToken) return parseCursorAuth(cursorLoginDocument({ accessToken }), "keychain");
  }
  const file = readCursorAuthFile(cursorGlobalAuthPath());
  return file?.accessToken ? parseCursorAuth(cursorLoginDocument({ accessToken: file.accessToken }), file.source) : null;
};

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

/** The Cursor user a token names: issuer and subject, compared as separate fields. */
export interface CursorIdentity {
  iss: string;
  sub: string;
}

/** The Cursor user a credential belongs to, or null when its token carries no readable identity. */
export function cursorTokenIdentity(auth: Pick<CursorAuthSnapshot, "accessToken"> | null): CursorIdentity | null {
  const claims = cursorTokenClaims(auth?.accessToken);
  return claims ? { iss: claims.iss, sub: claims.sub } : null;
}

export function sameCursorIdentity(a: CursorIdentity | null, b: CursorIdentity | null): boolean {
  return a !== null && b !== null && a.iss === b.iss && a.sub === b.sub;
}

export type CursorIdentityVerdict = "same" | "different" | "unverified" | "first";

/**
 * Whether a captured Cursor credential belongs to the user the account
 * already holds. `first` only when the account holds no credential at all;
 * `unverified` when the account's credential or the new one names no user
 * (taking it needs an explicit --replace-account).
 */
export function cursorIdentityVerdict(held: { hasCredentials: boolean; identity: CursorIdentity | null }, nextRaw: string | null): CursorIdentityVerdict {
  if (!held.hasCredentials) return "first";
  const next = cursorTokenIdentity(parseCursorAuth(nextRaw));
  if (held.identity === null || next === null) return "unverified";
  return sameCursorIdentity(held.identity, next) ? "same" : "different";
}
