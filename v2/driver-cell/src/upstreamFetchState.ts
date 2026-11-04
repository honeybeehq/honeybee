import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveUpstreamSshPolicy, UpstreamFetchError, UPSTREAM_FETCH_FAILURES, type UpstreamFetchFailure, type UpstreamSshPolicy } from "./upstreamFetch.ts";

export interface UpstreamFailureState {
  version: 1;
  fingerprint: string;
  failures: number;
  nextAttemptAt: number;
  code: UpstreamFetchFailure;
  error: string;
  parked: boolean;
}

const CODES: readonly string[] = UPSTREAM_FETCH_FAILURES;
const FILE = "honeybee-fetch-state.json";

export function upstreamPolicyFingerprint(policy?: UpstreamSshPolicy): string {
  const resolved = policy ?? resolveUpstreamSshPolicy(undefined, ".");
  const paths = [...resolved.identityFiles, resolved.knownHostsFile];
  const metadata = paths.map(path => {
    try {
      const info = lstatSync(path, { bigint: true });
      return [path, info.dev, info.ino, info.mode, info.uid, info.size, info.mtimeNs, info.ctimeNs].map(String);
    } catch { return [path, "unavailable"]; }
  });
  return createHash("sha256").update(JSON.stringify({ policy: resolved, metadata })).digest("hex");
}

export function readUpstreamFailure(mirror: string): UpstreamFailureState | null {
  const path = join(mirror, FILE);
  let info;
  try { info = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw new UpstreamFetchError("transport_refused", "upstream failure state must be a bounded regular file");
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { throw new UpstreamFetchError("transport_refused", "upstream failure state is invalid; repair it before retrying"); }
  if (parsed === null || typeof parsed !== "object") throw new UpstreamFetchError("transport_refused", "upstream failure state is invalid");
  const p = parsed as Record<string, unknown>;
  if (p.version !== 1 || typeof p.fingerprint !== "string" || !/^[0-9a-f]{64}$/u.test(p.fingerprint) || typeof p.failures !== "number" || !Number.isInteger(p.failures) || p.failures < 1 || p.failures > 30 || typeof p.nextAttemptAt !== "number" || !Number.isFinite(p.nextAttemptAt) || typeof p.parked !== "boolean" || typeof p.error !== "string" || p.error.length > 2048 || typeof p.code !== "string" || !CODES.includes(p.code)) throw new UpstreamFetchError("transport_refused", "upstream failure state is invalid");
  return { version: 1, fingerprint: p.fingerprint, failures: p.failures, nextAttemptAt: p.nextAttemptAt, parked: p.parked, code: p.code as UpstreamFetchFailure, error: p.error };
}

export function writeUpstreamFailure(mirror: string, state: UpstreamFailureState | null): void {
  const path = join(mirror, FILE);
  if (state === null) { rmSync(path, { force: true }); return; }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

export function failedUpstreamState(fingerprint: string, previous: UpstreamFailureState | null, code: UpstreamFetchFailure, error: string, now: number, maxAgeMs: number): UpstreamFailureState {
  const failures = Math.min((previous?.fingerprint === fingerprint ? previous.failures : 0) + 1, 30);
  const base = Math.max(maxAgeMs, 5 * 60_000);
  const delay = Math.max(base, Math.min(60 * 60_000, base * 2 ** Math.min(failures, 20)));
  return { version: 1, fingerprint, failures, code, error: error.slice(0, 2048), parked: code !== "fetch_failed", nextAttemptAt: now + delay };
}
