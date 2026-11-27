import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { AGY_AUTH_FILE, AGY_OAUTH_TOKEN_FILE } from "../../core/src/index.ts";
import { atomicWriteFileSync } from "./homeDefaults.ts";

export const AGY_MIN_SHIP_TTL_MS = 10 * 60_000;
export const AGY_GENERATION_FILE = ".agy-generation.json";
export const AGY_LEGACY_MARKER = `${JSON.stringify({ method: "oauth-personal" }, null, 2)}\n`;

export function repairAgyMarker(dir: string): boolean {
  if (existsSync(join(dir, AGY_AUTH_FILE)) || !existsSync(join(dir, AGY_OAUTH_TOKEN_FILE))) return false;
  atomicWriteFileSync(join(dir, AGY_AUTH_FILE), AGY_LEGACY_MARKER, 0o600);
  return true;
}

const ACCESS_KEYS = ["access_token", "accessToken"] as const;
const REFRESH_KEYS = ["refresh_token", "refreshToken"] as const;
const EXPIRY_KEYS = ["expiry", "expires_at", "expiresAt", "expiry_date", "expiryDate"] as const;

export interface AgyOauthToken {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
}

function tokenObject(document: Record<string, unknown>): Record<string, unknown> | null {
  if (ACCESS_KEYS.some((key) => typeof document[key] === "string")) return document;
  for (const value of Object.values(document)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = tokenObject(value as Record<string, unknown>);
      if (nested) return nested;
    }
  }
  return null;
}

function expiryMs(value: unknown): number | null {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
  return null;
}

export function parseAgyOauthDocument(document: unknown): AgyOauthToken | null {
  if (!document || typeof document !== "object" || Array.isArray(document)) return null;
  const token = tokenObject(document as Record<string, unknown>);
  if (!token) return null;
  const accessKey = ACCESS_KEYS.find((key) => typeof token[key] === "string" && (token[key] as string).length > 0);
  const expiryKey = EXPIRY_KEYS.find((key) => expiryMs(token[key]) !== null);
  if (!accessKey || !expiryKey) return null;
  const refreshKey = REFRESH_KEYS.find((key) => typeof token[key] === "string" && (token[key] as string).length > 0);
  return { accessToken: token[accessKey] as string, refreshToken: refreshKey ? (token[refreshKey] as string) : null, expiresAt: expiryMs(token[expiryKey])! };
}

export function parseAgyOauthToken(raw: string | null): AgyOauthToken | null {
  if (raw === null) return null;
  try {
    return parseAgyOauthDocument(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function agyExpiredCopy(document: Record<string, unknown>): Record<string, unknown> {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    const isToken = ACCESS_KEYS.some((key) => typeof (value as Record<string, unknown>)[key] === "string");
    for (const [key, inner] of Object.entries(value)) {
      if (isToken && (EXPIRY_KEYS as readonly string[]).includes(key) && expiryMs(inner) !== null) out[key] = typeof inner === "string" ? new Date(1000).toISOString() : 1;
      else out[key] = visit(inner);
    }
    return out;
  };
  return visit(document) as Record<string, unknown>;
}

export interface AgyGeneration {
  generation: number;
  changed: boolean;
}

export function advanceAgyGeneration(vaultDir: string, revision: string): AgyGeneration {
  const path = join(vaultDir, AGY_GENERATION_FILE);
  let stored: { revision?: unknown; generation?: unknown } = {};
  try {
    stored = JSON.parse(readFileSync(path, "utf8")) as typeof stored;
  } catch {
    stored = {};
  }
  const previous = typeof stored.generation === "number" && Number.isSafeInteger(stored.generation) && stored.generation > 0 ? stored.generation : 0;
  if (stored.revision === revision && previous > 0) return { generation: previous, changed: false };
  const generation = previous + 1;
  mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
  atomicWriteFileSync(path, `${JSON.stringify({ revision, generation })}\n`, 0o600);
  return { generation, changed: previous > 0 };
}

export type AgyRefreshRun = (env: Record<string, string>) => Promise<"signed_in" | "signed_out" | "unavailable">;

export async function refreshAgyOauthToken(raw: string, run: AgyRefreshRun, extraEnv: (home: string) => Record<string, string>, now: () => number): Promise<{ outcome: "refreshed"; raw: string } | { outcome: "signed_out" | "unavailable" }> {
  const home = mkdtempSync(join(tmpdir(), "hb-agy-refresh-"));
  try {
    const path = join(home, AGY_OAUTH_TOKEN_FILE);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(path, `${JSON.stringify(agyExpiredCopy(JSON.parse(raw) as Record<string, unknown>))}\n`, 0o600);
    const result = await run(extraEnv(home));
    if (result !== "signed_in") return { outcome: result };
    const next = readFileSync(path, "utf8");
    const token = parseAgyOauthToken(next);
    return token && token.expiresAt > now() ? { outcome: "refreshed", raw: next } : { outcome: "unavailable" };
  } catch {
    return { outcome: "unavailable" };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
