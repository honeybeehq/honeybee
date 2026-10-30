import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, createWriteStream, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";
import { Worker } from "node:worker_threads";
import type { ChampionHomeObjectRow, ChampionRow, CoreStore } from "../../core/src/index.ts";
import { transcriptSegmentWorkerUrl, type HomeBundleRequest, type HomeBundleResult, type TranscriptSweepRequest, type TranscriptSweepResult } from "./transcriptSegmentWorker.ts";

export const CHAMPION_HOME_OBJECT_DIR = join("blobs", "champion-homes");
const REF = /^[a-f0-9]{64}$/;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MIN_INTERVAL_MS = 60_000;

export interface ChampionHomeSyncDeps {
  store: () => CoreStore;
  root: string;
  now: () => number;
  log: (op: string) => void;
  maxFileBytes?: number;
  minIntervalMs?: number;
  includeSecrets?: boolean;
  orphanGraceMs?: number;
  workerUrl?: URL;
}

export interface ChampionHomeBundle {
  ref: string;
  bytes: number;
  size: number;
  files: number;
  skipped: string[];
}

export interface ChampionHomeBundleOutcome {
  bundle: ChampionHomeBundle | null;
  refused: { reason: "secrets" | "torn"; paths: string[] } | null;
  error: string | null;
}

const SECRET_FILES = new Set([".netrc", ".npmrc", ".pypirc", ".git-credentials", ".yarnrc", ".yarnrc.yml", "auth.json", "credentials", "credentials.json", ".credentials.json", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "token", "tokens.json", "secrets.json"]);
const SECRET_DIRS = new Set([".ssh", ".gnupg", ".aws", ".config/gcloud", ".kube", ".docker"]);
const SECRET_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".secret", ".token"];

export function looksLikeSecret(relativePath: string): boolean {
  const base = relativePath.split("/").pop() ?? relativePath;
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (SECRET_FILES.has(base)) return true;
  if (SECRET_SUFFIXES.some((suffix) => base.endsWith(suffix))) return true;
  if (relativePath.startsWith(".claude/") && /credential/i.test(base)) return true;
  if (relativePath.startsWith(".codex/") && base === "auth.json") return true;
  const segments = relativePath.split("/");
  for (let i = 1; i <= Math.min(2, segments.length - 1); i++) if (SECRET_DIRS.has(segments.slice(0, i).join("/"))) return true;
  return false;
}

function zstd(): { compress: () => zlib.ZstdCompress; decompress: () => zlib.ZstdDecompress } {
  const compress = (zlib as Partial<typeof zlib>).createZstdCompress;
  const decompress = (zlib as Partial<typeof zlib>).createZstdDecompress;
  if (!compress || !decompress) throw new Error(`champion home bundles need zstd in node:zlib (Node 22.15 or newer); this is ${process.version}`);
  return { compress: () => compress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } }), decompress: () => decompress() };
}

interface HomeWalk {
  files: number;
  skipped: string[];
  secrets: string[];
  newestMtimeMs: number;
  fingerprint: string;
}

function walk(root: string, maxFileBytes: number): HomeWalk {
  let files = 0;
  const skipped: string[] = [];
  const secrets: string[] = [];
  let newestMtimeMs = 0;
  const seen: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const rel = relative(root, path);
        const info = statSync(path);
        if (looksLikeSecret(rel)) secrets.push(rel);
        if (info.size > maxFileBytes) skipped.push(rel);
        else files += 1;
        newestMtimeMs = Math.max(newestMtimeMs, info.mtimeMs);
        seen.push(`${rel}:${info.size}:${info.mtimeMs}`);
      }
    }
  };
  visit(root);
  return { files, skipped, secrets, newestMtimeMs, fingerprint: createHash("sha256").update(seen.sort().join("\n")).digest("hex") };
}

export function championHomeObjectPath(root: string, ref: string): string {
  if (!REF.test(ref)) throw new Error(`invalid champion home reference ${ref}`);
  return join(root, CHAMPION_HOME_OBJECT_DIR, ref);
}

export async function bundleChampionHome(home: string, root: string, opts: { maxFileBytes?: number; includeSecrets?: boolean } = {}): Promise<ChampionHomeBundleOutcome> {
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const before = walk(home, maxFileBytes);
  if (before.secrets.length > 0 && !opts.includeSecrets) return { bundle: null, refused: { reason: "secrets", paths: before.secrets }, error: null };
  const { files, skipped } = before;
  const dir = join(root, CHAMPION_HOME_OBJECT_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = join(dir, `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.partial`);
  const tar = spawn("tar", ["-cf", "-", "--no-xattrs", ...skipped.map((path) => `--exclude=./${path}`), "-C", home, "."], { stdio: ["ignore", "pipe", "pipe"] });
  const stderr: Buffer[] = [];
  tar.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const hash = createHash("sha256");
  let size = 0;
  let bytes = 0;
  tar.stdout.on("data", (chunk: Buffer) => { size += chunk.length; });
  const compressor = zstd().compress();
  compressor.on("data", (chunk: Buffer) => { hash.update(chunk); bytes += chunk.length; });
  const exit = new Promise<number | null>((resolve) => tar.once("close", (code) => resolve(code)));
  await pipeline(tar.stdout, compressor, createWriteStream(temporary, { mode: 0o600 }));
  const code = await exit;
  if (code !== 0) {
    rmSync(temporary, { force: true });
    throw new Error(`tar exited ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`);
  }
  const fd = openSync(temporary, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const after = walk(home, maxFileBytes);
  if (after.fingerprint !== before.fingerprint) {
    rmSync(temporary, { force: true });
    return { bundle: null, refused: { reason: "torn", paths: [] }, error: null };
  }
  const ref = hash.digest("hex");
  const target = championHomeObjectPath(root, ref);
  if (existsSync(target)) rmSync(temporary, { force: true });
  else renameSync(temporary, target);
  return { bundle: { ref, bytes, size, files, skipped }, refused: null, error: null };
}

export async function restoreChampionHome(home: string, root: string, ref: string): Promise<void> {
  const object = championHomeObjectPath(root, ref);
  if (!existsSync(object)) throw new Error(`champion home object ${ref} is missing from ${root}`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const tar = spawn("tar", ["-xf", "-", "-C", home], { stdio: ["pipe", "ignore", "pipe"] });
  const stderr: Buffer[] = [];
  tar.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const exit = new Promise<number | null>((resolve) => tar.once("close", (code) => resolve(code)));
  await pipeline(createReadStream(object), zstd().decompress(), tar.stdin);
  const code = await exit;
  if (code !== 0) throw new Error(`tar exited ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`);
}

export class ChampionHomeSync {
  private readonly deps: ChampionHomeSyncDeps;
  private readonly inFlight = new Map<string, Promise<ChampionHomeObjectRow | null>>();
  private readonly lastAt = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly rerun = new Set<string>();
  private stopping = false;

  constructor(deps: ChampionHomeSyncDeps) {
    this.deps = deps;
  }

  get root(): string {
    return this.deps.root;
  }

  stop(): void {
    this.stopping = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  requestSync(championId: string): void {
    if (this.stopping) return;
    if (this.inFlight.has(championId)) {
      this.rerun.add(championId);
      return;
    }
    if (this.timers.has(championId)) return;
    const interval = this.deps.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    const since = this.deps.now() - (this.lastAt.get(championId) ?? Number.NEGATIVE_INFINITY);
    if (since >= interval) {
      void this.sync(championId);
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(championId);
      if (!this.stopping) void this.sync(championId);
    }, interval - since);
    timer.unref();
    this.timers.set(championId, timer);
  }

  sync(championId: string): Promise<ChampionHomeObjectRow | null> {
    const inFlight = this.inFlight.get(championId);
    if (inFlight) return inFlight;
    const run = this.syncNow(championId).finally(() => {
      this.inFlight.delete(championId);
      if (this.rerun.delete(championId)) this.requestSync(championId);
    });
    this.inFlight.set(championId, run);
    return run;
  }

  private runWorker<T>(request: HomeBundleRequest | TranscriptSweepRequest): Promise<T> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.deps.workerUrl ?? transcriptSegmentWorkerUrl(), { execArgv: [], workerData: request });
      let settled = false;
      worker.once("message", (message: T) => {
        settled = true;
        resolve(message);
      });
      worker.once("error", (err) => {
        if (!settled) reject(err);
        settled = true;
      });
      worker.once("exit", (code) => {
        if (!settled) reject(new Error(`champion home worker exited with code ${code} without a result`));
        settled = true;
      });
    });
  }

  private async syncNow(championId: string): Promise<ChampionHomeObjectRow | null> {
    const store = this.deps.store();
    const champion = store.getChampion(championId);
    if (!champion || !existsSync(champion.home)) return null;
    if (champion.fencedAt != null) {
      this.deps.log(`champion.home.push_skipped id=${championId} reason=fenced epoch=${champion.epoch}`);
      return null;
    }
    this.lastAt.set(championId, this.deps.now());
    const started = Date.now();
    try {
      const outcome = await this.runWorker<HomeBundleResult>({ kind: "bundleHome", home: champion.home, storeRoot: this.deps.root, maxFileBytes: this.deps.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, includeSecrets: this.deps.includeSecrets ?? false } satisfies HomeBundleRequest);
      if (outcome.error != null) throw new Error(outcome.error);
      if (outcome.refused) {
        this.deps.log(`champion.home.push_refused id=${championId} reason=${outcome.refused.reason}${outcome.refused.paths.length > 0 ? ` paths=${JSON.stringify(outcome.refused.paths.slice(0, 20))}` : ""} ms=${Date.now() - started}`);
        return null;
      }
      const bundle = outcome.bundle!;
      const latest = store.latestChampionHomeObject(championId);
      if (latest && latest.ref === bundle.ref && latest.epoch === champion.epoch) {
        this.deps.log(`champion.home.unchanged id=${championId} ref=${bundle.ref} ms=${Date.now() - started}`);
        return latest;
      }
      const row = store.putChampionHomeObject({ championId, ref: bundle.ref, bytes: bundle.bytes, size: bundle.size, files: bundle.files, skipped: bundle.skipped.length, closedAt: this.deps.now(), epoch: champion.epoch });
      this.deps.log(`champion.home.pushed id=${championId} epoch=${champion.epoch} ref=${bundle.ref} bytes=${bundle.bytes} size=${bundle.size} files=${bundle.files} skipped=${bundle.skipped.length}${bundle.skipped.length > 0 ? ` skipped_paths=${JSON.stringify(bundle.skipped.slice(0, 20))}` : ""} ms=${Date.now() - started}`);
      return row;
    } catch (err) {
      this.deps.log(`champion.home.push_failed id=${championId} err=${JSON.stringify(err instanceof Error ? err.message : String(err))} ms=${Date.now() - started}`);
      return null;
    }
  }

  async sweepOrphans(): Promise<{ objects: number; bytes: number; swept: number }> {
    const result = await this.runWorker<TranscriptSweepResult>({
      kind: "sweep",
      storeRoot: this.deps.root,
      dir: CHAMPION_HOME_OBJECT_DIR,
      referenced: [...this.deps.store().listChampionHomeObjectRefs()],
      graceMs: this.deps.orphanGraceMs ?? 60 * 60_000,
      now: this.deps.now(),
    } satisfies TranscriptSweepRequest);
    if (result.error != null) throw new Error(result.error);
    this.deps.log(`champion.home.objects root=${this.deps.root} objects=${result.objects} bytes=${result.bytes} orphans_swept=${result.swept}`);
    return { objects: result.objects, bytes: result.bytes, swept: result.swept };
  }

  describe(ref: string): Pick<ChampionHomeObjectRow, "ref" | "bytes" | "size" | "files" | "skipped"> | null {
    if (!REF.test(ref)) return null;
    const path = championHomeObjectPath(this.deps.root, ref);
    if (!existsSync(path)) return null;
    return { ref, bytes: statSync(path).size, size: 0, files: 0, skipped: 0 };
  }

  async restore(champion: ChampionRow, object: Pick<ChampionHomeObjectRow, "ref" | "bytes">): Promise<boolean> {
    try {
      await restoreChampionHome(champion.home, this.deps.root, object.ref);
      return true;
    } catch (err) {
      this.deps.log(`champion.home.restore_failed id=${champion.id} ref=${object.ref} err=${JSON.stringify(err instanceof Error ? err.message : String(err))}`);
      return false;
    }
  }
}
