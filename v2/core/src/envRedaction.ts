import { isAbsolute } from "node:path";
import type { AuditRow, BeeRow } from "./types.ts";

const ENV_FIELDS = new Set(["env", "previousEnv", "targetEnv"]);

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.values(value).every(entry => typeof entry === "string");
}

export type PublicBeeRow = Omit<BeeRow, "env"> & { envKeys: string[] };

export function toPublicBee(bee: BeeRow): PublicBeeRow {
  const { env, ...publicBee } = bee;
  return { ...publicBee, envKeys: Object.keys(env).sort() };
}

export function mirrorBeeRow(bee: BeeRow | null): PublicBeeRow | null {
  return bee === null ? null : toPublicBee(bee);
}

export interface OperatorLocalHomes {
  codexHome: string | null;
  claudeConfigDir: string | null;
  grokHome: string | null;
}

export type OperatorLocalBeeRow = PublicBeeRow & { operatorLocalHomes: OperatorLocalHomes };

export function operatorLocalHomesOf(env: Record<string, string>): OperatorLocalHomes {
  const path = (value: string | undefined): string | null => value && isAbsolute(value) && !/[\0\r\n]/.test(value) ? value : null;
  return { codexHome: path(env.CODEX_HOME), claudeConfigDir: path(env.CLAUDE_CONFIG_DIR), grokHome: path(env.GROK_HOME) };
}

export function operatorLocalBee(bee: BeeRow | null): OperatorLocalBeeRow | null {
  return bee === null ? null : { ...toPublicBee(bee), operatorLocalHomes: operatorLocalHomesOf(bee.env) };
}

export function publicAuditRow(row: AuditRow, includeOperatorLocalHomes = false): AuditRow {
  if (row.kind.startsWith("template.")) return row;
  const payload = publicEnvRecords(row.payload) as Record<string, unknown>;
  if (includeOperatorLocalHomes && row.kind.startsWith("bee.")) {
    const bee = row.payload.bee;
    if (bee && typeof bee === "object" && "env" in bee && isStringRecord(bee.env)) {
      payload.bee = { ...payload.bee as object, operatorLocalHomes: operatorLocalHomesOf(bee.env) };
    } else if (isStringRecord(row.payload.env)) {
      payload.operatorLocalHomes = operatorLocalHomesOf(row.payload.env);
    }
  }
  return { ...row, payload };
}

export function carriesBeeEnvRecord(result: unknown): boolean {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return false;
  const bee = (result as { bee?: unknown }).bee;
  return typeof bee === "object" && bee !== null && !Array.isArray(bee) && isStringRecord((bee as { env?: unknown }).env);
}

export function publicBeeResult(result: unknown): unknown {
  return carriesBeeEnvRecord(result) ? publicEnvRecords(result) : result;
}

export function publicEnvRecords(value: unknown, includeOperatorLocalHomes = false): unknown {
  if (Array.isArray(value)) return value.map(entry => publicEnvRecords(entry, includeOperatorLocalHomes));
  if (typeof value !== "object" || value === null) return value;
  const source = value as Record<string, unknown>;
  const envSibling = isStringRecord(source.env);
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (key === "operatorLocalHomes") {
      if (includeOperatorLocalHomes && entry && typeof entry === "object") {
        const homes = entry as Record<string, unknown>;
        out[key] = operatorLocalHomesOf({
          ...(typeof homes.codexHome === "string" ? { CODEX_HOME: homes.codexHome } : {}),
          ...(typeof homes.claudeConfigDir === "string" ? { CLAUDE_CONFIG_DIR: homes.claudeConfigDir } : {}),
          ...(typeof homes.grokHome === "string" ? { GROK_HOME: homes.grokHome } : {}),
        });
      }
      continue;
    }
    if ((ENV_FIELDS.has(key) || key === "previous" && envSibling) && isStringRecord(entry)) {
      const field = key === "previous" ? "previousEnvKeys" : `${key}Keys`;
      out[field] = Object.keys(entry).sort();
    } else {
      out[key] = publicEnvRecords(entry, includeOperatorLocalHomes);
    }
  }
  return out;
}
