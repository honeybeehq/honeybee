import { assertPeercredReceipt } from "./peercredReceipt.js";
import type { PeercredProvenance } from "./peercredProvenance.js";
/**
 * Deploy settling: prove the globally installed module tree is EXACTLY the
 * tree the local build produced before anything restarts the daemon.
 *
 * Incident this encodes (2026-08): `npm i -g .` followed immediately by
 * `hive daemon restart` booted a daemon from a half-copied / half-rebuilt
 * module mix — new files beside stale ones — and the mixed boot reap
 * false-reaped 8 live runners. The global install may be a directory copy or
 * a symlink into a sibling worktree, so "the install finished" is not a fact
 * the installer's exit code establishes; only content equality is.
 *
 * Mechanism: after `npm run build`, writeBuildStamp() records a digest of the
 * local dist tree inside dist itself; the stamp travels with the install.
 * waitForSettledInstall() then re-reads the INSTALLED stamp and re-hashes the
 * INSTALLED tree until both equal the local digest (bounded retries), which
 * simultaneously proves the copy completed and that the install target is not
 * a stale or mid-rebuild worktree. Only then may the daemon restart.
 */

import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "./fsx.js";
import { readBuildIdentity } from "./release/buildIdentity.js";

/** Lives inside dist/ so the stamp travels with any install mechanism. */
export const BUILD_STAMP_FILENAME = ".build-stamp.json";

/**
 * A satellite updater may add prebuilt files (the peercred bridge) to a
 * released dist before installing it. It records exactly what it added here,
 * beside the stamp; no build ever contains this file.
 */
export const REPACK_RECORD_FILENAME = ".build-repack.json";

/** Legacy artifact hashes retain their original process-locale ordering. */
// Preserve the historical process-locale digest for existing artifacts and rollback stamps.

const DIST_ROOT_METADATA: ReadonlySet<string> = new Set([BUILD_STAMP_FILENAME, REPACK_RECORD_FILENAME]);

export type RepackRecord = {
  schema: 1;
  sourceHead: string;
  baseArtifactHash: string;
  repackArtifactHash: string;
  addedFiles: Array<{ path: string; sha256: string }>;
  peercred: { target: string; sha256: string; ciRun: number; ciJob: number; provenance: PeercredProvenance };
};

export type BuildStamp = {
  hash: string;
  builtAt: string;
};

export type SettleResult = {
  hash: string;
  attempts: number;
  repacked: boolean;
};

export type SettleOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  target?: string;
};

const DEFAULT_SETTLE_TIMEOUT_MS = 60_000;
const DEFAULT_SETTLE_POLL_INTERVAL_MS = 500;

/**
 * Order-stable content digest of every regular file under `dir` (the stamp
 * file excluded — it must be able to DESCRIBE the digest without changing
 * it). Path and content both feed the hash, so a renamed, missing, or extra
 * file changes the digest even when byte totals agree. Throws on a tree that
 * mutates mid-walk; settling treats that as "not settled yet" and retries.
 */
export async function hashDirectoryTree(dir: string, omit: ReadonlySet<string> = new Set()): Promise<string> {
  const digest = createHash("sha256");
  const relativeFiles: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(join(dir, relative), { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relPath = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(relPath);
      else if (entry.isFile() && !DIST_ROOT_METADATA.has(relPath) && !omit.has(relPath)) relativeFiles.push(relPath);
    }
  };
  await walk("");
  for (const relPath of relativeFiles) {
    digest.update(relPath);
    digest.update("\0");
    digest.update(await readFile(join(dir, relPath)));
    digest.update("\0");
  }
  return digest.digest("hex");
}

/** Digest the freshly built tree and persist the stamp beside it. */
export async function writeBuildStamp(distDir: string): Promise<BuildStamp> {
  const stamp: BuildStamp = {
    hash: await hashDirectoryTree(distDir),
    builtAt: new Date().toISOString(),
  };
  await atomicWriteFile(join(distDir, BUILD_STAMP_FILENAME), `${JSON.stringify(stamp, null, 2)}\n`, { mode: 0o644 });
  return stamp;
}

/** Null on a missing or torn stamp — both simply mean "not settled yet". */
export async function readBuildStamp(distDir: string): Promise<BuildStamp | null> {
  let raw: string;
  try {
    raw = await readFile(join(distDir, BUILD_STAMP_FILENAME), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed?.hash !== "string" || parsed.hash.length === 0) return null;
    return { hash: parsed.hash, builtAt: typeof parsed.builtAt === "string" ? parsed.builtAt : "" };
  } catch {
    return null;
  }
}

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function hostTarget(): string {
  return `${process.platform}-${process.arch}`;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const present = Object.keys(value).sort();
  return present.length === keys.length && [...keys].sort().every((key, index) => present[index] === key);
}

/** Strict schema-1 parse; every rule a record must meet before any file is read. */
export function parseRepackRecord(raw: string, target: string = hostTarget()): RepackRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("repack record is not JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("repack record is not an object");
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["schema", "sourceHead", "baseArtifactHash", "repackArtifactHash", "addedFiles", "peercred"])) {
    throw new Error("repack record keys are not exactly the schema 1 keys");
  }
  if (record.schema !== 1) throw new Error("repack record schema is not 1");
  if (typeof record.sourceHead !== "string" || !HEX40.test(record.sourceHead)) throw new Error("repack sourceHead is not a 40-hex sha");
  for (const key of ["baseArtifactHash", "repackArtifactHash"] as const) {
    if (typeof record[key] !== "string" || !HEX64.test(record[key] as string)) throw new Error(`repack ${key} is not a 64-hex digest`);
  }
  const peercred = record.peercred;
  if (!peercred || typeof peercred !== "object" || Array.isArray(peercred)) throw new Error("repack peercred is not an object");
  const bridge = peercred as Record<string, unknown>;
  if (!exactKeys(bridge, ["target", "sha256", "ciRun", "ciJob", "provenance"])) throw new Error("repack peercred keys are not exactly target, sha256, ciRun, ciJob");
  if (bridge.target !== target) throw new Error(`repack peercred target ${String(bridge.target)} is not this host's ${target}`);
  if (typeof bridge.sha256 !== "string" || !HEX64.test(bridge.sha256)) throw new Error("repack peercred sha256 is not a 64-hex digest");
  if (!positiveInteger(bridge.ciRun) || !positiveInteger(bridge.ciJob)) throw new Error("repack peercred ciRun and ciJob must be positive integers");
  assertPeercredReceipt(bridge, record.sourceHead, target, bridge.sha256);
  const prefix = `v2/peercred/${target}/`;
  if (!Array.isArray(record.addedFiles) || record.addedFiles.length === 0) throw new Error("repack addedFiles is empty");
  const addedFiles: RepackRecord["addedFiles"] = [];
  let previous: string | null = null;
  for (const item of record.addedFiles) {
    if (!item || typeof item !== "object" || Array.isArray(item) || !exactKeys(item as Record<string, unknown>, ["path", "sha256"])) {
      throw new Error("repack addedFiles entries must be exactly { path, sha256 }");
    }
    const { path, sha256 } = item as { path: unknown; sha256: unknown };
    if (typeof path !== "string" || path.startsWith("/") || path.includes("\\")
      || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
      || DIST_ROOT_METADATA.has(path)) {
      throw new Error(`repack added path ${String(path)} is not a plain dist-relative path`);
    }
    if (!path.startsWith(prefix)) throw new Error(`repack added path ${path} is outside ${prefix}`);
    if (typeof sha256 !== "string" || !HEX64.test(sha256)) throw new Error(`repack added file ${path} has no 64-hex sha256`);
    if (previous !== null && !(previous < path)) throw new Error("repack addedFiles are not sorted by path without duplicates");
    previous = path;
    addedFiles.push({ path, sha256 });
  }
  const node = addedFiles.find((file) => file.path === `${prefix}peercred.node`);
  if (!node || node.sha256 !== bridge.sha256) throw new Error(`repack peercred sha256 does not match ${prefix}peercred.node`);
  return {
    schema: 1,
    sourceHead: record.sourceHead,
    baseArtifactHash: record.baseArtifactHash as string,
    repackArtifactHash: record.repackArtifactHash as string,
    addedFiles,
    peercred: { target: bridge.target as string, sha256: bridge.sha256, ciRun: bridge.ciRun, ciJob: bridge.ciJob, provenance: bridge.provenance as PeercredProvenance },
  };
}

/** The raw record text; null when the dist was never repacked. */
export async function readRepackRecordText(distDir: string): Promise<string | null> {
  try {
    return await readFile(join(distDir, REPACK_RECORD_FILENAME), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function symlinksUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) found.push(path);
      else if (entry.isDirectory()) await walk(path);
    }
  };
  await walk(root);
  return found;
}

/**
 * Prove a repacked dist is the released base plus exactly the recorded
 * additions: the record names the expected base, every added file is a
 * regular file with its recorded digest, the dist minus the additions
 * re-hashes to the base, and the whole dist re-hashes to the recorded repack
 * digest. Nothing is excluded from either digest. Resolves with the repack
 * digest; throws with the first disagreement.
 */
export async function verifyRepackedDist(distDir: string, expectedBaseHash: string, raw: string, target: string = hostTarget()): Promise<string> {
  const record = parseRepackRecord(raw, target);
  if (record.baseArtifactHash !== expectedBaseHash) {
    throw new Error(`repack base ${record.baseArtifactHash.slice(0, 12)} is not the expected artifact ${expectedBaseHash.slice(0, 12)}`);
  }
  const identity = readBuildIdentity(join(distDir, "build-identity.json"));
  if (identity.sourceRevision !== record.sourceHead) {
    throw new Error(`repack sourceHead ${record.sourceHead.slice(0, 12)} is not the build's ${String(identity.sourceRevision).slice(0, 12)}`);
  }
  // Reject symlinked ancestors before reading any recorded addition. The tree
  // digest skips symlinks, so following one here would prove different bytes.
  for (const relative of ["v2", "v2/peercred"]) {
    const stat = await lstat(join(distDir, relative)).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`repacked dist requires a real directory at ${relative}`);
  }
  const links = await symlinksUnder(join(distDir, "v2", "peercred"));
  if (links.length > 0) throw new Error(`repacked dist holds a symlink under v2/peercred: ${links[0]}`);
  for (const file of record.addedFiles) {
    const path = join(distDir, ...file.path.split("/"));
    const stat = await lstat(path).catch(() => null);
    if (!stat?.isFile()) throw new Error(`repack added file ${file.path} is not a regular file`);
    const sha256 = createHash("sha256").update(await readFile(path)).digest("hex");
    if (sha256 !== file.sha256) throw new Error(`repack added file ${file.path} does not match its sha256`);
  }
  const repackHash = await hashDirectoryTree(distDir);
  if (repackHash !== record.repackArtifactHash) {
    throw new Error(`repacked tree ${repackHash.slice(0, 12)} is not the recorded ${record.repackArtifactHash.slice(0, 12)}`);
  }
  const baseHash = await hashDirectoryTree(distDir, new Set(record.addedFiles.map((file) => file.path)));
  if (baseHash !== record.baseArtifactHash) {
    throw new Error(`repacked tree minus its additions ${baseHash.slice(0, 12)} is not the base ${record.baseArtifactHash.slice(0, 12)}`);
  }
  return repackHash;
}

/**
 * The digest a dist settles at against an expected artifact hash: the plain
 * tree digest, or for a recorded repack the verified repack digest. Throws
 * with the disagreement otherwise.
 */
export async function verifyDistAgainstArtifact(distDir: string, expectedHash: string, target: string = hostTarget()): Promise<{ hash: string; repacked: boolean }> {
  const raw = await readRepackRecordText(distDir);
  if (raw !== null) return { hash: await verifyRepackedDist(distDir, expectedHash, raw, target), repacked: true };
  const hash = await hashDirectoryTree(distDir);
  if (hash !== expectedHash) throw new Error(`tree ${hash.slice(0, 12)} != expected ${expectedHash.slice(0, 12)}`);
  return { hash, repacked: false };
}

/**
 * Block until the installed dist tree provably equals the local build:
 * the installed stamp must name the local digest AND the installed tree must
 * re-hash to it (a stamp that merely copied early proves nothing). Resolves
 * with the settled digest; throws once the timeout expires with the last
 * observed disagreement, so the caller never restarts a daemon over a mixed
 * tree.
 */
export async function waitForSettledInstall(
  localDist: string,
  installedDist: string,
  options: SettleOptions = {},
): Promise<SettleResult> {
  const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS);
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_SETTLE_POLL_INTERVAL_MS);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const localStamp = await readBuildStamp(localDist);
  if (!localStamp) {
    throw new Error(`deploy-settle: no build stamp under ${localDist}; run the build (writeBuildStamp) first`);
  }
  const deadline = now() + timeoutMs;
  let attempts = 0;
  let lastDisagreement = "installed tree not yet observed";
  for (;;) {
    attempts += 1;
    try {
      const installedStamp = await readBuildStamp(installedDist);
      if (!installedStamp) {
        lastDisagreement = "installed build stamp is missing or unreadable";
      } else if (installedStamp.hash !== localStamp.hash) {
        lastDisagreement = `installed stamp ${installedStamp.hash.slice(0, 12)} != local build ${localStamp.hash.slice(0, 12)}`;
      } else {
        const localRecord = await readRepackRecordText(localDist);
        const installedRecord = await readRepackRecordText(installedDist);
        if (localRecord !== installedRecord) {
          lastDisagreement = "installed repack record differs from the local one";
        } else if (installedRecord !== null) {
          const hash = await verifyRepackedDist(installedDist, localStamp.hash, installedRecord, options.target);
          return { hash, attempts, repacked: true };
        } else {
          const installedHash = await hashDirectoryTree(installedDist);
          if (installedHash === localStamp.hash) return { hash: installedHash, attempts, repacked: false };
          lastDisagreement = `installed tree ${installedHash.slice(0, 12)} != its own stamp ${localStamp.hash.slice(0, 12)} (copy in flight?)`;
        }
      }
    } catch (error) {
      // A tree mutating (or missing) mid-walk is exactly the unsettled state
      // this loop exists to outwait.
      lastDisagreement = error instanceof Error ? error.message : String(error);
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error(`deploy-settle: installed module tree did not settle within ${timeoutMs}ms: ${lastDisagreement}`);
    }
    await sleep(Math.min(pollIntervalMs, remaining));
  }
}
