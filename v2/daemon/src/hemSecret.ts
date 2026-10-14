import { execFile } from "node:child_process";
import { resolveExecutable } from "../../core/src/index.ts";

export const HEM_DEFAULT_FIELD = "api_key";
export const NAMING_HEM_SECRET_PREFIX = "global/hive-naming-";
const NAMING_HEM_SECRET = /^global\/hive-naming-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HEM_FIELD = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const PLAIN_SECRET_VALUE = /^[A-Za-z0-9][\x21-\x7e]{15,511}$/;
const PENDING_APPROVAL = /pending_request_id|approval_required|pendingapproval|pending approval/i;
const HEM_ENV_KEYS = ["PATH", "HOME", "USER", "TMPDIR", "VALHALL_HEMD_ENDPOINT", "VALHALL_HEM_TOKEN", "HEM_DATA_DIR"] as const;
const DEFAULT_HEM_TIMEOUT_MS = 5_000;
const DEFAULT_HEM_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_HEM_FAILURE_HOLD_MS = 60_000;
const DEFAULT_HEM_APPROVAL_HOLD_MS = 15 * 60_000;
const MAX_HEM_OUTPUT_BYTES = 64 * 1024;
const MAX_HEM_ERROR_CHARS = 200;

export interface HemSecretRef {
  secret: string;
  field: string;
}

export function parseNamingHemSecretRef(value: string): HemSecretRef | null {
  const parts = value.trim().split(/\s+/);
  if (parts.length > 2) return null;
  const [secret = "", field = HEM_DEFAULT_FIELD] = parts;
  if (!NAMING_HEM_SECRET.test(secret) || !HEM_FIELD.test(field)) return null;
  return { secret, field };
}

export interface HemGetOutput {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

export type HemGetRunner = (command: string, args: string[], timeoutMs: number) => Promise<HemGetOutput>;

export interface HemSecretResolverOptions {
  timeoutMs?: number;
  cacheTtlMs?: number;
  failureHoldMs?: number;
  approvalHoldMs?: number;
  now?: () => number;
  locateHem?: () => string | null;
  run?: HemGetRunner;
}

function hemEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of HEM_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function runHemGet(command: string, args: string[], timeoutMs: number): Promise<HemGetOutput> {
  return new Promise((resolvePromise) => {
    const child = execFile(
      command,
      args,
      { env: hemEnv(), timeout: timeoutMs, maxBuffer: MAX_HEM_OUTPUT_BYTES, encoding: "utf8" },
      (error, stdout, stderr) => {
        resolvePromise({
          ok: !error,
          stdout: String(stdout),
          stderr: String(stderr),
          timedOut: Boolean(error?.killed),
          ...(error ? { error: error.message } : {}),
        });
      },
    );
    child.stdin?.end();
  });
}

function hemFailureReason(output: HemGetOutput, timeoutMs: number): string {
  if (output.timedOut) return `timed out after ${timeoutMs}ms`;
  const reason = /message: "([^"]*)"/.exec(output.stderr)?.[1] ??
    (output.stderr.trim().split("\n")[0] || output.error || "hem get failed");
  return reason.slice(0, MAX_HEM_ERROR_CHARS);
}

export class HemSecretResolver {
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly failureHoldMs: number;
  private readonly approvalHoldMs: number;
  private readonly now: () => number;
  private readonly locateHem: () => string | null;
  private readonly run: HemGetRunner;
  private readonly cache = new Map<string, { value: string; expiresAt: number }>();
  private readonly held = new Map<string, { error: string; until: number }>();
  private readonly inflight = new Map<string, Promise<string>>();
  private generation = 0;

  constructor(options: HemSecretResolverOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_HEM_TIMEOUT_MS;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_HEM_CACHE_TTL_MS;
    this.failureHoldMs = options.failureHoldMs ?? DEFAULT_HEM_FAILURE_HOLD_MS;
    this.approvalHoldMs = options.approvalHoldMs ?? DEFAULT_HEM_APPROVAL_HOLD_MS;
    this.now = options.now ?? Date.now;
    this.locateHem = options.locateHem ?? (() => resolveExecutable("hem")?.path ?? null);
    this.run = options.run ?? runHemGet;
  }

  async resolve(ref: string): Promise<string> {
    const now = this.now();
    const cached = this.cache.get(ref);
    if (cached && cached.expiresAt > now) return cached.value;
    this.cache.delete(ref);
    const hold = this.held.get(ref);
    if (hold && hold.until > now) throw new Error(hold.error);
    this.held.delete(ref);
    const pending = this.inflight.get(ref);
    if (pending) return pending;
    const lookup = this.fetch(ref, this.generation).finally(() => {
      if (this.inflight.get(ref) === lookup) this.inflight.delete(ref);
    });
    this.inflight.set(ref, lookup);
    return lookup;
  }

  forget(ref?: string): void {
    this.generation += 1;
    if (ref === undefined) {
      this.cache.clear();
      this.held.clear();
      this.inflight.clear();
    } else {
      this.cache.delete(ref);
      this.held.delete(ref);
      this.inflight.delete(ref);
    }
  }

  reject(ref: string): void {
    this.forget(ref);
    this.hold(ref, this.generation, `hem ref ${JSON.stringify(ref)} holds a key OpenAI rejected`, this.failureHoldMs);
  }

  private async fetch(ref: string, generation: number): Promise<string> {
    const name = JSON.stringify(ref);
    const parsed = parseNamingHemSecretRef(ref);
    if (!parsed) throw new Error(`hem ref ${name} is not an allowed naming secret reference (${NAMING_HEM_SECRET_PREFIX}<name> [field])`);
    const hem = this.locateHem();
    if (!hem) throw this.hold(ref, generation, `hem ref ${name} could not be read: hem executable not found on PATH or the standard install dirs`, this.failureHoldMs);
    const output = await this.run(hem, ["get", parsed.secret, parsed.field], this.timeoutMs);
    if (PENDING_APPROVAL.test(output.stdout) || PENDING_APPROVAL.test(output.stderr)) {
      throw this.hold(ref, generation, `hem ref ${name} is waiting for approval in hem`, this.approvalHoldMs);
    }
    if (!output.ok) {
      throw this.hold(ref, generation, `hem ref ${name} could not be read: ${hemFailureReason(output, this.timeoutMs)}`, this.failureHoldMs);
    }
    const value = output.stdout.endsWith("\n") ? output.stdout.slice(0, -1) : output.stdout;
    if (!PLAIN_SECRET_VALUE.test(value)) {
      throw this.hold(ref, generation, `hem ref ${name} did not return a plain secret value`, this.failureHoldMs);
    }
    if (generation === this.generation) this.cache.set(ref, { value, expiresAt: this.now() + this.cacheTtlMs });
    return value;
  }

  private hold(ref: string, generation: number, error: string, holdMs: number): Error {
    if (generation === this.generation) this.held.set(ref, { error, until: this.now() + holdMs });
    return new Error(error);
  }
}
