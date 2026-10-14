import { execFile } from "node:child_process";
import { resolveExecutable } from "../../core/src/index.ts";

export const HEM_DEFAULT_FIELD = "api_key";
const DEFAULT_HEM_TIMEOUT_MS = 5_000;
const DEFAULT_HEM_CACHE_TTL_MS = 5 * 60_000;
const MAX_HEM_OUTPUT_BYTES = 64 * 1024;
const MAX_HEM_ERROR_CHARS = 200;

export interface HemSecretRef {
  secret: string;
  field: string;
}

export function parseHemSecretRef(value: string): HemSecretRef | null {
  const parts = value.trim().split(/\s+/);
  if (parts.length < 1 || parts.length > 2) return null;
  const [secret, field = HEM_DEFAULT_FIELD] = parts;
  if (!secret || secret.startsWith("-") || field.startsWith("-")) return null;
  return { secret, field };
}

export type HemGetRunner = (command: string, args: string[], timeoutMs: number) => Promise<string>;

export interface HemSecretResolverOptions {
  timeoutMs?: number;
  cacheTtlMs?: number;
  now?: () => number;
  locateHem?: () => string | null;
  run?: HemGetRunner;
}

function runHemGet(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      command,
      args,
      { env: process.env, timeout: timeoutMs, maxBuffer: MAX_HEM_OUTPUT_BYTES, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (!error) {
          resolvePromise(stdout);
          return;
        }
        const message = /message: "([^"]*)"/.exec(stderr)?.[1] ??
          (error.killed ? `timed out after ${timeoutMs}ms` : String(stderr).trim().split("\n")[0] || error.message);
        reject(new Error(message.slice(0, MAX_HEM_ERROR_CHARS)));
      },
    );
  });
}

export class HemSecretResolver {
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly locateHem: () => string | null;
  private readonly run: HemGetRunner;
  private readonly cache = new Map<string, { value: string; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<string>>();
  private generation = 0;

  constructor(options: HemSecretResolverOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_HEM_TIMEOUT_MS;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_HEM_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
    this.locateHem = options.locateHem ?? (() => resolveExecutable("hem")?.path ?? null);
    this.run = options.run ?? runHemGet;
  }

  async resolve(ref: string): Promise<string> {
    const cached = this.cache.get(ref);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    this.cache.delete(ref);
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
      this.inflight.clear();
    } else {
      this.cache.delete(ref);
      this.inflight.delete(ref);
    }
  }

  private async fetch(ref: string, generation: number): Promise<string> {
    const parsed = parseHemSecretRef(ref);
    if (!parsed) throw new Error(`hem ref ${JSON.stringify(ref)} is not a valid secret reference`);
    const hem = this.locateHem();
    if (!hem) throw new Error(`hem ref ${JSON.stringify(ref)} could not be read: hem executable not found on PATH or the standard install dirs`);
    let stdout: string;
    try {
      stdout = await this.run(hem, ["get", parsed.secret, parsed.field], this.timeoutMs);
    } catch (error) {
      throw new Error(`hem ref ${JSON.stringify(ref)} could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    const value = stdout.replace(/\r?\n$/, "");
    if (value.length === 0 || value.includes("\n") || value.startsWith("{")) {
      throw new Error(`hem ref ${JSON.stringify(ref)} did not return a plain secret value`);
    }
    if (generation === this.generation) this.cache.set(ref, { value, expiresAt: this.now() + this.cacheTtlMs });
    return value;
  }
}
