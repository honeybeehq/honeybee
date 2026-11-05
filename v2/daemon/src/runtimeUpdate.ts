import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, open, readFile, readdir, readlink, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { CoreStore } from "../../core/src/index.ts";
import type { RuntimeJournalEntry } from "../../core/src/types.ts";
import { withFileLock } from "../../core/src/lock.ts";
import { resolveNodePin } from "../../core/src/nodeRuntime.ts";
import { readBuildIdentity } from "../../core/src/release/buildIdentity.ts";
import { ReleaseVerifyError, releaseKeyId, verifyReleaseDescriptor, type ReleaseDescriptor } from "../../core/src/release/descriptor.ts";
import { satisfiesNodeRange } from "../../core/src/release/nodeRange.ts";
import { sha256File } from "../../core/src/release/runtimeArtifact.ts";
import { UnsafeArchiveError, artifactTreeDigest, unpackRuntimeArchive } from "../../core/src/release/strictUnpack.ts";
import { RELEASE_PUBLIC_KEYS } from "../../core/src/release/trustedKeys.ts";
import { BUILD_IDENTITY, RpcError, type RuntimeInstallResult, type RuntimePruneResult, type RuntimeStatusResult, type RuntimeVersion } from "./protocol.ts";

export const RUNTIME_LOCK_NAME = ".deploy.lock";
export const CURRENT_LINK_NAME = "current";
export const HANDOVER_FILE_NAME = "handover.json";
export const DEFAULT_KEEP_VERSIONS = 5;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

export type RuntimeRefusal = "signature_invalid" | "key_unknown" | "archive_digest_mismatch" | "target_mismatch" | "node_pin_unmet"
  | "archive_unsafe" | "archive_invalid" | "install_conflict" | "is_current" | "is_previous";

export function runtimeRefused(reason: RuntimeRefusal, message: string, details: Record<string, unknown> = {}): RpcError {
  return new RpcError("runtime_refused", `runtime: ${message}`, { reason, ...details });
}

export function runtimeRootOf(dataDir: string): string {
  return join(dirname(resolve(dataDir)), "runtime");
}

export function hostTarget(): string {
  return `${process.platform}-${process.arch}`;
}

async function syncPath(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncTree(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await syncTree(path);
    else if (entry.isFile()) await syncPath(path);
  }
  await syncPath(directory);
}

async function readLinkOrNull(path: string): Promise<string | null> {
  try { return await readlink(path); } catch { return null; }
}

async function currentSha(root: string): Promise<string | null> {
  const link = await readLinkOrNull(join(root, CURRENT_LINK_NAME));
  if (!link) return null;
  if (SHA_PATTERN.test(link)) return link;
  try {
    const identity = readBuildIdentity(join(root, CURRENT_LINK_NAME, "dist", "build-identity.json"));
    return identity.component === "honeybee" ? identity.sourceRevision : null;
  } catch { return null; }
}

async function deployHistoryPrevious(root: string, current: string | null): Promise<string | null> {
  let parsed: { entries?: unknown };
  try { parsed = JSON.parse(await readFile(join(root, "deploys.json"), "utf8")); } catch { return null; }
  if (!Array.isArray(parsed?.entries)) return null;
  for (let index = parsed.entries.length - 1; index >= 0; index -= 1) {
    const sha = (parsed.entries[index] as { sha?: unknown })?.sha;
    if (typeof sha === "string" && SHA_PATTERN.test(sha) && sha !== current && existsSync(join(root, sha, "dist", "cli.js"))) return sha;
  }
  return null;
}

export class RuntimeUpdateService {
  private pin: { version: string; path: string } | null | undefined;
  private readonly deps: { dataDir: string; store: () => CoreStore; log: (line: string) => void; trustedKeys?: readonly string[] };
  constructor(deps: { dataDir: string; store: () => CoreStore; log: (line: string) => void; trustedKeys?: readonly string[] }) { this.deps = deps; }

  private trustedKeys(): readonly string[] {
    return this.deps.trustedKeys ?? RELEASE_PUBLIC_KEYS;
  }

  get root(): string { return runtimeRootOf(this.deps.dataDir); }

  nodePin(): { version: string; path: string } | null {
    if (this.pin !== undefined) return this.pin;
    try {
      const pin = resolveNodePin(this.deps.dataDir);
      this.pin = { version: pin.version, path: pin.path };
    } catch {
      this.pin = process.versions.electron ? null : { version: process.versions.node, path: process.execPath };
    }
    return this.pin;
  }

  private async previous(current: string | null): Promise<string | null> {
    const link = await readLinkOrNull(join(this.root, "previous"));
    if (link && SHA_PATTERN.test(link) && link !== current) return link;
    return deployHistoryPrevious(this.root, current);
  }

  private async versions(current: string | null, previous: string | null): Promise<RuntimeVersion[]> {
    let names: string[];
    try { names = await readdir(this.root); } catch { return []; }
    const journal = this.deps.store().runtimeJournal(200);
    const result: RuntimeVersion[] = [];
    for (const sha of names.filter((name) => SHA_PATTERN.test(name)).sort()) {
      const dir = join(this.root, sha);
      let stat;
      try { stat = await lstat(dir); } catch { continue; }
      if (!stat.isDirectory()) continue;
      const recorded = journal.filter((entry) => entry.sha === sha && entry.event === "installed").at(-1);
      let version: string | null = null, target: string | null = null;
      try {
        const identity = readBuildIdentity(join(dir, "dist", "build-identity.json"));
        version = identity.version; target = identity.target;
      } catch {}
      result.push({ sha, installedAt: recorded?.at ?? Math.round(stat.mtimeMs), version, target, current: sha === current, previous: sha === previous });
    }
    return result.sort((a, b) => b.installedAt - a.installedAt || a.sha.localeCompare(b.sha));
  }

  async status(): Promise<RuntimeStatusResult> {
    const current = await currentSha(this.root);
    const previous = await this.previous(current);
    let handover: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(await readFile(join(this.root, HANDOVER_FILE_NAME), "utf8"));
      handover = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { raw: true };
    } catch {}
    const keys = this.trustedKeys();
    return {
      root: this.root, current, previous,
      running: { sourceRevision: BUILD_IDENTITY.sourceRevision, version: BUILD_IDENTITY.version },
      installed: await this.versions(current, previous),
      journal: this.deps.store().runtimeJournal(50),
      store: this.deps.store().storeSchemaInfo(),
      handover,
      nodePin: this.nodePin(),
      keys: { trusted: keys.length, keyIds: keys.map(releaseKeyId) },
    };
  }

  async install(params: Record<string, unknown>, by: string): Promise<RuntimeInstallResult> {
    const archive = params.archive;
    if (typeof archive !== "string" || !isAbsolute(archive) || resolve(archive) !== archive) throw new RpcError("invalid_request", "runtime.install: archive must be an absolute canonical path", { reason: "archive" });
    if (params.descriptor === undefined || params.descriptor === null) throw new RpcError("invalid_request", "runtime.install: descriptor is required", { reason: "descriptor" });
    if (params.signature === undefined || params.signature === null) throw new RpcError("invalid_request", "runtime.install: signature is required", { reason: "signature" });
    const keys = this.trustedKeys();
    let verified: { descriptor: ReleaseDescriptor; keyId: string };
    try { verified = verifyReleaseDescriptor(params.descriptor, params.signature, keys); }
    catch (error) {
      if (error instanceof ReleaseVerifyError) {
        if (error.reason === "descriptor_invalid") throw new RpcError("invalid_request", `runtime.install: ${error.message}`, { reason: "descriptor" });
        throw runtimeRefused(error.reason, error.message, { trustedKeys: keys.length });
      }
      throw error;
    }
    const { descriptor, keyId } = verified;
    const { identity } = descriptor;
    if (identity.target !== hostTarget()) throw runtimeRefused("target_mismatch", `release targets ${identity.target}; this node is ${hostTarget()}`, { target: identity.target, host: hostTarget() });
    const pin = this.nodePin();
    let satisfied: boolean;
    try { satisfied = pin !== null && satisfiesNodeRange(pin.version, descriptor.engines.node); }
    catch (error) { throw new RpcError("invalid_request", `runtime.install: ${error instanceof Error ? error.message : String(error)}`, { reason: "descriptor" }); }
    if (!satisfied) throw runtimeRefused("node_pin_unmet", `release requires Node ${descriptor.engines.node}; this node's pin is ${pin?.version ?? "unknown"}`, { required: descriptor.engines.node, pinned: pin?.version ?? null });
    const sha = identity.sourceRevision;
    await mkdir(this.root, { recursive: true });
    return withFileLock(join(this.root, RUNTIME_LOCK_NAME), async () => {
      const work = join(this.root, `.install.${sha}.${process.pid}.${randomUUID()}`);
      await mkdir(work, { recursive: true, mode: 0o700 });
      try {
        const snapshot = join(work, "release.tgz");
        try { await cp(archive, snapshot); }
        catch (error) { throw new RpcError("invalid_request", `runtime.install: cannot read archive ${archive}: ${error instanceof Error ? error.message : String(error)}`, { reason: "archive" }); }
        const digest = await sha256File(snapshot);
        if (`sha256:${digest.sha256}` !== identity.artifact.sha256) throw runtimeRefused("archive_digest_mismatch", `archive sha256 ${digest.sha256} differs from the signed descriptor`, { expected: identity.artifact.sha256, actual: `sha256:${digest.sha256}`, bytes: digest.bytes });
        const stage = join(work, "stage");
        await mkdir(stage);
        let bytes: number;
        try { ({ bytes } = await unpackRuntimeArchive(snapshot, stage)); }
        catch (error) {
          if (error instanceof UnsafeArchiveError) throw runtimeRefused("archive_unsafe", error.message);
          throw runtimeRefused("archive_invalid", `archive does not unpack: ${error instanceof Error ? error.message : String(error)}`);
        }
        await rm(snapshot, { force: true });
        if (!existsSync(join(stage, "dist", "cli.js"))) throw runtimeRefused("archive_invalid", "archive has no dist/cli.js");
        let build;
        try { build = readBuildIdentity(join(stage, "dist", "build-identity.json")); }
        catch (error) { throw runtimeRefused("archive_invalid", `archive build identity unreadable: ${error instanceof Error ? error.message : String(error)}`); }
        if (build.component !== "honeybee" || build.sourceRevision !== sha || build.target !== identity.target || build.dirty !== false) {
          throw runtimeRefused("archive_invalid", `archive build identity (${build.component} ${build.sourceRevision ?? "unknown"} ${build.target}${build.dirty === false ? "" : " dirty"}) differs from the signed descriptor`, { build: { component: build.component, sourceRevision: build.sourceRevision, target: build.target, dirty: build.dirty } });
        }
        await syncTree(stage);
        const installedDir = join(this.root, sha);
        let changed = true;
        if (existsSync(installedDir)) {
          if (await artifactTreeDigest(installedDir) !== await artifactTreeDigest(stage)) throw runtimeRefused("install_conflict", `runtime/${sha} is already installed with different bytes`, { installedDir });
          changed = false;
        } else {
          await rename(stage, installedDir);
          await syncPath(this.root);
        }
        const journal = changed
          ? this.deps.store().appendRuntimeJournal({ event: "installed", sha, by, detail: { keyId, bytes, archiveSha256: identity.artifact.sha256, version: identity.version, target: identity.target, engines: descriptor.engines.node } })
          : this.deps.store().runtimeJournal(200).filter((entry) => entry.sha === sha && entry.event === "installed").at(-1)
            ?? this.deps.store().appendRuntimeJournal({ event: "installed", sha, by, detail: { keyId, bytes, archiveSha256: identity.artifact.sha256, version: identity.version, target: identity.target, engines: descriptor.engines.node, adopted: true } });
        this.deps.log(`runtime.install sha=${sha} bytes=${bytes} key=${keyId} changed=${changed} dir=${installedDir}`);
        return { sha, installedDir, bytes, keyId, changed, journal };
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  async prune(params: Record<string, unknown>, by: string): Promise<RuntimePruneResult> {
    const keep = params.keep === undefined ? DEFAULT_KEEP_VERSIONS : params.keep;
    if (typeof keep !== "number" || !Number.isSafeInteger(keep) || keep < 1 || keep > 1000) throw new RpcError("invalid_request", "runtime.prune: keep must be an integer from 1 to 1000", { reason: "keep" });
    await mkdir(this.root, { recursive: true });
    return withFileLock(join(this.root, RUNTIME_LOCK_NAME), async () => {
      const current = await currentSha(this.root);
      const previous = await this.previous(current);
      const versions = await this.versions(current, previous);
      const kept: string[] = [], removed: string[] = [];
      const journal: RuntimeJournalEntry[] = [];
      let ranked = 0;
      for (const version of versions) {
        if (version.current || version.previous) { kept.push(version.sha); continue; }
        ranked += 1;
        if (ranked <= keep) { kept.push(version.sha); continue; }
        await rm(join(this.root, version.sha), { recursive: true, force: true });
        removed.push(version.sha);
        journal.push(this.deps.store().appendRuntimeJournal({ event: "pruned", sha: version.sha, by, detail: { keep, installedAt: version.installedAt } }));
      }
      if (removed.length > 0) await syncPath(this.root);
      this.deps.log(`runtime.prune keep=${keep} removed=${removed.length} kept=${kept.length}`);
      return { removed, kept, journal };
    });
  }
}
