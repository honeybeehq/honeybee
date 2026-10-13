export const REDACTED_ENV_VALUE = "<redacted>";

const SECRET_ENV_KEY = /token|secret|key|password|credential/i;
const ENV_FIELDS = new Set(["env", "previousEnv", "targetEnv"]);

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

export function redactEnvRecords<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => redactEnvRecords(entry)) as T;
  if (typeof value !== "object" || value === null) return value;
  const source = value as Record<string, unknown>;
  const envSibling = "env" in source && isStringRecord(source.env);
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    const envField = ENV_FIELDS.has(key) || (key === "previous" && envSibling);
    out[key] = envField && isStringRecord(entry) ? redactEnv(entry) : redactEnvRecords(entry);
  }
  return out as T;
}
