import { MIRROR_RAW_BEE_ENV_KEYS } from "./mirror.ts";
import type { AuditRow, BeeRow } from "./types.ts";

export const REDACTED_ENV_VALUE = "<redacted>";

const SECRET_ENV_KEY = /token|secret|key|password|credential/i;
const ENV_FIELDS = new Set(["env", "previousEnv", "targetEnv"]);
const MIRROR_RAW_KEYS: ReadonlySet<string> = new Set(MIRROR_RAW_BEE_ENV_KEYS);

type EnvRedactor = (env: Record<string, string>) => Record<string, string>;

export function isSecretEnvKey(key: string): boolean {
  return SECRET_ENV_KEY.test(key);
}

export function redactEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, isSecretEnvKey(key) ? REDACTED_ENV_VALUE : value]));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === "string");
}

export function redactEnvRecords<T>(value: T, redact: EnvRedactor = redactEnv): T {
  if (Array.isArray(value)) return value.map((entry) => redactEnvRecords(entry, redact)) as T;
  if (typeof value !== "object" || value === null) return value;
  const source = value as Record<string, unknown>;
  const envSibling = "env" in source && isStringRecord(source.env);
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    const envField = ENV_FIELDS.has(key) || (key === "previous" && envSibling);
    out[key] = envField && isStringRecord(entry) ? redact(entry) : redactEnvRecords(entry, redact);
  }
  return out as T;
}

export function redactBeeResultEnv<T>(result: T): T {
  const bee = (result as { bee?: { env?: unknown } | null } | null)?.bee;
  return typeof bee?.env === "object" && bee.env !== null ? redactEnvRecords(result) : result;
}

export function carriesBeeEnvRecord(result: unknown): boolean {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return false;
  const bee = (result as { bee?: unknown }).bee;
  return typeof bee === "object" && bee !== null && !Array.isArray(bee) && isStringRecord((bee as { env?: unknown }).env);
}

export function redactMirrorBeeEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, MIRROR_RAW_KEYS.has(key) ? value : REDACTED_ENV_VALUE]));
}

export function mirrorBeeRow<T extends BeeRow | null>(bee: T): T {
  return bee === null ? bee : { ...bee, env: redactMirrorBeeEnv(bee.env) };
}

export function mirrorBeeAuditRow(row: AuditRow): AuditRow {
  return row.kind.startsWith("bee.") ? { ...row, payload: redactEnvRecords(row.payload, redactMirrorBeeEnv) } : row;
}
