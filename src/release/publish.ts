/** Retry-safe publication over a create-only asset store. The first tarball is the durable build receipt. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseComponentIdentity, type ArtifactReference, type ComponentIdentity } from "./index.js";
import { formatSha256Sums, parseRuntimeArtifactManifest, runtimeArtifactTarballName } from "../runtimeArtifact.js";
import type { ReleaseReservation } from "./prepare.js";
const exec = promisify(execFile);
export const releaseBytesDigest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export interface ReleaseAssetStore {
  url(name: string): string;
  read(name: string): Promise<Uint8Array | null>;
  /** Create only. A conflict must never replace existing bytes. */
  put(name: string, bytes: Uint8Array): Promise<void>;
  /** Atomically publish the complete asset set and require host-enforced immutability. */
  seal(): Promise<void>;
}
export type HoneybeeReleaseDescriptor = {
  schemaVersion: 1;
  identity: ComponentIdentity;
  requestedSourceRevision: string;
  productSourceSha256: string;
  assessmentSha256: string;
  inventory: ArtifactReference;
  manifest: ArtifactReference;
  checksums: ArtifactReference;
};
export type HoneybeeReleaseEvent = { schemaVersion: 1; eventKey: string; descriptor: ArtifactReference };
export type PublishHoneybeeOptions = {
  reservation: ReleaseReservation;
  target: string;
  providerFingerprint: string;
  store: ReleaseAssetStore;
  /** The production adapter runs the committed-source build/test gate; no skip option exists. */
  build(): Promise<Uint8Array>;
  notify(event: HoneybeeReleaseEvent): Promise<void>;
};
async function describeBundle(bytes: Uint8Array, options: PublishHoneybeeOptions) {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-release-bundle-"));
  try {
    const path = join(dir, "runtime.tar.gz"); await writeFile(path, bytes);
    const extract = async (name: string) => new Uint8Array((await exec("tar", ["-xOzf", path, name], { encoding: "buffer", maxBuffer: 128 * 1024 * 1024 })).stdout);
    const manifestBytes = await extract("manifest.json"), inventoryBytes = await extract("release-inventory.json");
    const manifest = parseRuntimeArtifactManifest(Buffer.from(manifestBytes).toString("utf8"));
    const { reservation, target } = options;
    if (manifest.gate !== "full" || manifest.sha !== reservation.sourceRevision || manifest.package?.name !== "honeybee"
      || manifest.package.version !== reservation.version || manifest.tarball !== runtimeArtifactTarballName(reservation.sourceRevision)
      || !manifest.identity?.release || manifest.identity.version !== reservation.version || manifest.identity.target !== target) {
      throw new Error("Release requires fully checked source and matching package/artifact identity");
    }
    const inventory = JSON.parse(Buffer.from(inventoryBytes).toString("utf8"));
    if (inventory.schemaVersion !== 1 || inventory.component !== "honeybee" || inventory.providerFingerprint !== options.providerFingerprint) {
      throw new Error("Built API inventory differs from assessed source");
    }
    return { manifestBytes, inventoryBytes };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function putExact(store: ReleaseAssetStore, name: string, bytes: Uint8Array): Promise<Uint8Array> {
  const existing = await store.read(name);
  if (existing) {
    if (releaseBytesDigest(existing) !== releaseBytesDigest(bytes)) throw new Error(`Immutable asset conflict: ${name}`);
    return existing;
  }
  try { await store.put(name, bytes); }
  catch (error) {
    // The server may have accepted an upload whose response was lost.
    const winner = await store.read(name);
    if (!winner || releaseBytesDigest(winner) !== releaseBytesDigest(bytes)) throw error;
  }
  const stored = await store.read(name);
  if (!stored || releaseBytesDigest(stored) !== releaseBytesDigest(bytes)) throw new Error(`Asset verification failed: ${name}`);
  return stored;
}

export async function publishHoneybeeRelease(options: PublishHoneybeeOptions) {
  const { reservation, store } = options;
  const tarballName = runtimeArtifactTarballName(reservation.sourceRevision);
  let tarball = await store.read(tarballName);
  if (!tarball) {
    const built = await options.build();
    await describeBundle(built, options); // Failed/skipped verification has no publication side effects.
    try { await store.put(tarballName, built); }
    catch (error) {
      // A concurrent builder may win with different compression/timestamps. Adopt its checked bytes.
      if (!await store.read(tarballName)) throw error;
    }
    tarball = await store.read(tarballName);
    if (!tarball) throw new Error("Uploaded runtime disappeared");
  }
  const { manifestBytes, inventoryBytes } = await describeBundle(tarball, options);
  await putExact(store, "manifest.json", manifestBytes);
  await putExact(store, "inventory.json", inventoryBytes);
  const files = [{ name: tarballName, bytes: tarball }, { name: "manifest.json", bytes: manifestBytes }, { name: "inventory.json", bytes: inventoryBytes }];
  const sums = new TextEncoder().encode(formatSha256Sums(files.map(file => ({ name: file.name, sha256: releaseBytesDigest(file.bytes).slice(7) }))));
  await putExact(store, "SHA256SUMS", sums);
  const reference = (name: string, bytes: Uint8Array): ArtifactReference => ({ url: store.url(name), sha256: releaseBytesDigest(bytes) });
  const identity = parseComponentIdentity({ component: "honeybee", version: reservation.version, sourceRevision: reservation.sourceRevision,
    target: options.target, artifact: reference(tarballName, tarball) });
  const descriptor: HoneybeeReleaseDescriptor = { schemaVersion: 1, identity, requestedSourceRevision: reservation.requestedSourceRevision,
    productSourceSha256: reservation.productSourceSha256, assessmentSha256: reservation.assessmentSha256,
    inventory: reference("inventory.json", inventoryBytes), manifest: reference("manifest.json", manifestBytes), checksums: reference("SHA256SUMS", sums) };
  const descriptorBytes = new TextEncoder().encode(`${JSON.stringify(descriptor, null, 2)}\n`);
  await putExact(store, "release.json", descriptorBytes);
  // Re-read the entire set before visibility; a retry also validates a previously published release.
  for (const file of [...files, { name: "SHA256SUMS", bytes: sums }, { name: "release.json", bytes: descriptorBytes }]) {
    const bytes = await store.read(file.name);
    if (!bytes || releaseBytesDigest(bytes) !== releaseBytesDigest(file.bytes)) throw new Error(`Asset changed before publication: ${file.name}`);
  }
  await store.seal();
  const descriptorReference = reference("release.json", descriptorBytes);
  const event: HoneybeeReleaseEvent = { schemaVersion: 1, eventKey: descriptorReference.sha256, descriptor: descriptorReference };
  // release.json is a durable outbox. Reruns resend the same event; receivers deduplicate eventKey.
  let notification: "sent" | "pending" = "sent";
  try { await options.notify(event); } catch { notification = "pending"; }
  return { descriptor, descriptorReference, event, notification };
}
