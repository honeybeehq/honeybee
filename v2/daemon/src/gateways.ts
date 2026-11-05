/**
 * MCP gateways a bee's harness is pointed at. Two shapes: a stdio shim record
 * Apiary writes under `<storeRoot>/gateways/` (gatewayRev 1, until C6) and an
 * HTTP endpoint registered through `gateway.register` (gatewayRev 2), which
 * Honeybee stores and writes to the same directory itself.
 */
import { accessSync, constants, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { atomicWriteFile } from "../../core/src/fsx.ts";
import type { GatewayRow } from "../../core/src/types.ts";

export interface StdioGateway {
  kind: "stdio";
  name: string;
  shim: { command: string; args: string[] };
  env: Record<string, string>;
  envVars?: string[];
  pid?: number;
  stateless?: boolean;
}

export interface HttpGateway {
  kind: "http";
  name: string;
  url: string;
  tokenIssuer: string | null;
}

export type LiveGateway = StdioGateway | HttpGateway;

export const GATEWAY_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
export const MAX_GATEWAY_URL_LENGTH = 2048;
export const MAX_TOKEN_ISSUER_LENGTH = 1024;

/** The endpoint shape `gateway.register` accepts: an absolute http(s) URL with no credentials or fragment. */
export function gatewayUrlRefusal(url: unknown): string | null {
  if (typeof url !== "string" || url.length === 0) return "url must be a non-empty string";
  if (url.length > MAX_GATEWAY_URL_LENGTH) return `url must be at most ${MAX_GATEWAY_URL_LENGTH} characters`;
  if (/[\u0000-\u0020\u007f]/u.test(url)) return "url must not contain control characters or spaces";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "url must be an absolute URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "url must use http or https";
  if (parsed.username || parsed.password) return "url must not carry credentials";
  if (parsed.hash) return "url must not carry a fragment";
  return null;
}

export function httpGateway(row: Pick<GatewayRow, "name" | "url" | "tokenIssuer">): HttpGateway {
  return { kind: "http", name: row.name, url: row.url, tokenIssuer: row.tokenIssuer };
}

export function gatewayFilePath(name: string, storeRoot = process.env.HIVE_STORE_ROOT ?? join(homedir(), ".hive")): string {
  return join(storeRoot, "gateways", `${name}.json`);
}

/** Honeybee's own record of a registered gateway: the file it writes beside Apiary's stdio records. */
export function gatewayFileText(row: GatewayRow): string {
  return `${JSON.stringify({
    name: row.name,
    protocol: "mcp",
    gatewayRev: 2,
    transport: "http",
    url: row.url,
    tokenIssuer: row.tokenIssuer,
    registeredAt: new Date(row.registeredAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    writtenBy: "hived",
  }, null, 2)}\n`;
}

export async function writeGatewayFile(row: GatewayRow, storeRoot?: string): Promise<string> {
  const path = gatewayFilePath(row.name, storeRoot);
  await atomicWriteFile(path, gatewayFileText(row), { mode: 0o600 });
  return path;
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const PROTECTED_ENV = new Set(["HIVE_BEE", "HIVE_BEE_ID", "HIVE_PARENT", "HIVE_COMB"]);

export function parseGatewayRecord(raw: string): LiveGateway | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.gatewayRev === 2) {
    if (typeof record.name !== "string" || !GATEWAY_NAME.test(record.name)) return null;
    if (record.protocol !== "mcp" || record.transport !== "http" || gatewayUrlRefusal(record.url) !== null) return null;
    if (record.tokenIssuer !== undefined && record.tokenIssuer !== null && (typeof record.tokenIssuer !== "string" || record.tokenIssuer.length > MAX_TOKEN_ISSUER_LENGTH)) return null;
    return { kind: "http", name: record.name, url: record.url as string, tokenIssuer: typeof record.tokenIssuer === "string" ? record.tokenIssuer : null };
  }
  const shim = record.shim;
  if (!shim || typeof shim !== "object" || Array.isArray(shim)) return null;
  const shimRecord = shim as Record<string, unknown>;
  if (typeof record.name !== "string" || record.name.length === 0 || /[\u0000-\u001f]/u.test(record.name)) return null;
  if (record.protocol !== "mcp" || record.gatewayRev !== 1) return null;
  if (record.stateless !== undefined && typeof record.stateless !== "boolean") return null;
  if (typeof record.startedAt !== "string" || !Number.isFinite(Date.parse(record.startedAt))) return null;
  if (typeof shimRecord.command !== "string" || !isAbsolute(shimRecord.command) || shimRecord.command.includes("\0")) return null;
  if (!Array.isArray(shimRecord.args) || !shimRecord.args.every((arg) => typeof arg === "string" && !arg.includes("\0"))) return null;
  if (!record.env || typeof record.env !== "object" || Array.isArray(record.env)) return null;
  const envEntries = Object.entries(record.env as Record<string, unknown>);
  if (envEntries.some(([key, item]) => !ENV_KEY.test(key) || typeof item !== "string" || item.includes("\0"))) return null;
  if (record.envVars !== undefined && (
    !Array.isArray(record.envVars)
    || !record.envVars.every((name) => typeof name === "string" && ENV_KEY.test(name))
  )) return null;
  const stateless = record.stateless === true;
  if (
    (!stateless || record.socketPath !== undefined)
    && (typeof record.socketPath !== "string" || !isAbsolute(record.socketPath) || record.socketPath.includes("\0"))
  ) return null;
  if (!stateless && (!Number.isSafeInteger(record.pid) || Number(record.pid) <= 0)) return null;
  if (record.pid !== undefined && (!Number.isSafeInteger(record.pid) || Number(record.pid) <= 0)) return null;
  return {
    kind: "stdio",
    name: record.name,
    shim: { command: shimRecord.command, args: [...shimRecord.args] as string[] },
    env: Object.fromEntries(envEntries.filter(([key]) => !PROTECTED_ENV.has(key))) as Record<string, string>,
    ...(Array.isArray(record.envVars) ? { envVars: [...record.envVars] as string[] } : {}),
    ...(record.pid !== undefined ? { pid: Number(record.pid) } : {}),
    ...(stateless ? { stateless: true } : {}),
  };
}

function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function liveGateways(storeRoot = process.env.HIVE_STORE_ROOT ?? join(homedir(), ".hive")): LiveGateway[] {
  if (process.env.HIVE_GATEWAYS_DISABLE === "1") return [];
  let names: string[];
  try {
    names = readdirSync(join(storeRoot, "gateways"))
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    try {
      const record = parseGatewayRecord(readFileSync(join(storeRoot, "gateways", name), "utf8"));
      if (!record) return [];
      const live = record.kind === "http"
        || (record.stateless === true
          ? executable(record.shim.command)
          : record.pid !== undefined && processIsLive(record.pid));
      return live ? [record] : [];
    } catch {
      return [];
    }
  });
}
