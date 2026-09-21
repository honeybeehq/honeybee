import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { publishHoneybeeRelease, type ReleaseAssetStore } from "../src/release/publish.js";
import type { ReleaseReservation } from "../src/release/prepare.js";

const reservation: ReleaseReservation = { schemaVersion: 1, version: "0.1.0", tag: "honeybee-v0.1.0", sourceRevision: "a".repeat(40),
  requestedSourceRevision: "b".repeat(40), productSourceSha256: `sha256:${"c".repeat(64)}`, assessmentSha256: `sha256:${"d".repeat(64)}` };
const fingerprint = `sha256:${"e".repeat(64)}`;
class Assets implements ReleaseAssetStore {
  files = new Map<string, Uint8Array>();
  published = false;
  failAt: string | null = null;
  url(name: string) { return `https://github.com/honeybeehq/apiary-releases/releases/download/honeybee-v0.1.0-darwin-arm64/${name}`; }
  async read(name: string) { return this.files.get(name) ?? null; }
  async put(name: string, bytes: Uint8Array) {
    if (this.failAt === name) { this.failAt = null; throw new Error("interrupted upload"); }
    if (this.published || this.files.has(name)) throw new Error("cannot overwrite");
    this.files.set(name, bytes.slice());
  }
  async seal() { this.published = true; }
}
async function bundle(t: { after(fn: () => Promise<void>): void }, gate = "full", version = "0.1.0") {
  const dir = await mkdtemp(join(tmpdir(), "hon5-publication-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stage = join(dir, "stage"); await mkdir(stage);
  const manifest = { schemaVersion: 1, sha: reservation.sourceRevision, artifactHash: "f".repeat(64), protocol: "v2/1", executionCorpusDigest: "f".repeat(64),
    engines: { node: ">=20" }, package: { name: "honeybee", version }, tarball: `honeybee-runtime-${reservation.sourceRevision}.tar.gz`, gate, builtAt: "2026-09-21T00:00:00Z",
    identity: { schemaVersion: 1, component: "honeybee", version, packageVersion: version, sourceRevision: reservation.sourceRevision, dirty: false, release: true, target: "darwin-arm64" } };
  await writeFile(join(stage, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(stage, "release-inventory.json"), JSON.stringify({ schemaVersion: 1, component: "honeybee", providerFingerprint: fingerprint, coverage: { complete: false, gaps: ["unresolved routes"] } }));
  const path = join(dir, "runtime.tgz");
  execFileSync("tar", ["-czf", path, "-C", stage, "manifest.json", "release-inventory.json"]);
  return new Uint8Array(await readFile(path));
}

test("interrupted publication resumes original uploaded bytes and exact identities before notifying evaluator", async t => {
  const bytes = await bundle(t), store = new Assets();
  const notifications: unknown[] = [];
  const options = { reservation, target: "darwin-arm64", providerFingerprint: fingerprint, store,
    build: async () => bytes, notify: async (event: unknown) => { notifications.push(event); } };
  store.failAt = "manifest.json";
  await assert.rejects(publishHoneybeeRelease(options), /interrupted/);
  assert.equal(store.published, false);
  assert.equal(notifications.length, 0);
  const result = await publishHoneybeeRelease({ ...options, build: async () => { throw new Error("must recover uploaded bundle"); } });
  assert.equal(store.published, true);
  assert.equal(result.descriptor.identity.version, "0.1.0");
  assert.equal(result.descriptor.identity.sourceRevision, reservation.sourceRevision);
  assert.equal(result.notification, "sent");
  assert.equal(notifications.length, 1);
  const repeated = await publishHoneybeeRelease(options);
  assert.deepEqual(repeated, result);
});

test("failed and skipped verification never publish; identity and assessed inventory must match", async t => {
  for (const [gate, version, expectedFingerprint] of [["tests-skipped", "0.1.0", fingerprint], ["full", "0.2.0", fingerprint], ["full", "0.1.0", `sha256:${"0".repeat(64)}`]]) {
    const bytes = await bundle(t, gate, version), store = new Assets();
    await assert.rejects(publishHoneybeeRelease({ reservation, target: "darwin-arm64", providerFingerprint: expectedFingerprint, store,
      build: async () => bytes, notify: async () => {} }), /checked source|assessed source/);
    assert.equal(store.files.size, 0);
    assert.equal(store.published, false);
  }
  const store = new Assets();
  await assert.rejects(publishHoneybeeRelease({ reservation, target: "darwin-arm64", providerFingerprint: fingerprint, store,
    build: async () => { throw new Error("tests failed"); }, notify: async () => {} }), /tests failed/);
  assert.equal(store.files.size, 0);
});

test("notification failure preserves independent publication and rerun retries the identical event", async t => {
  const bytes = await bundle(t), store = new Assets(), events: unknown[] = [];
  const options = { reservation, target: "darwin-arm64", providerFingerprint: fingerprint, store, build: async () => bytes,
    notify: async (event: unknown) => { events.push(event); if (events.length === 1) throw new Error("evaluator unavailable"); } };
  const first = await publishHoneybeeRelease(options);
  assert.equal(first.notification, "pending"); assert.equal(store.published, true);
  const second = await publishHoneybeeRelease({ ...options, build: async () => { throw new Error("no rebuild"); } });
  assert.equal(second.notification, "sent"); assert.deepEqual(events[0], events[1]);
  assert.deepEqual(first.descriptor, second.descriptor);
});

test("existing metadata with different bytes is never overwritten or exposed as complete", async t => {
  const bytes = await bundle(t), store = new Assets();
  store.files.set("manifest.json", new TextEncoder().encode("different bytes"));
  await assert.rejects(publishHoneybeeRelease({ reservation, target: "darwin-arm64", providerFingerprint: fingerprint, store,
    build: async () => bytes, notify: async () => {} }), /Immutable asset conflict/);
  assert.equal(store.published, false);
  assert.equal(new TextDecoder().decode(store.files.get("manifest.json")), "different bytes");
});

test("release build boundary refuses the local skip-tests escape hatch", async () => {
  const { buildDeployArtifact } = await import("../src/commands/deploy.js");
  await assert.rejects(buildDeployArtifact({ repoRoot: "/unused", sha: reservation.sourceRevision, workDir: "/unused", log: () => {}, release: true, skipTests: true }), /cannot skip tests/);
});

import { generateKeyPairSync } from "node:crypto";
import { distributionIdentity, distributionPrefix } from "../src/release/distribution-profile.js";
test("staging publication binds reservation, descriptor and notification and cannot touch production assets", async t => {
  const profile = { schemaVersion: 1 as const, id: "fixture-stage", repository: "fixture/stage", verificationKeys: { fixture: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString() } };
  const staged = { ...reservation, distribution: distributionIdentity(profile), tag: `${distributionPrefix(profile)}${reservation.tag}` };
  const production = new Assets(), store = new Assets(), events: unknown[] = [], bytes = await bundle(t);
  store.url = name => `https://github.com/fixture/stage/releases/download/honeybee-v0.1.0-darwin-arm64/${name}`;
  const options = { reservation: staged, profile, target: "darwin-arm64", providerFingerprint: fingerprint, store, build: async () => bytes, notify: async (event: unknown) => { events.push(event); } };
  await assert.rejects(publishHoneybeeRelease({ ...options, store: production }), /distribution/);
  await assert.rejects(publishHoneybeeRelease({ ...options, reservation }), /distribution/);
  assert.equal(production.files.size, 0); assert.equal(store.files.size, 0);
  const published = await publishHoneybeeRelease(options);
  assert.equal(published.descriptor.distribution, distributionIdentity(profile));
  const repeated = await publishHoneybeeRelease({ ...options, build: async () => { throw Error("must reuse"); } });
  assert.deepEqual(repeated, published); assert.deepEqual(events[0], events[1]);
});
