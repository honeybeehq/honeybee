import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectBuildIdentity } from "../src/release/buildIdentityProducer.js";
import { readBuildIdentity } from "../src/release/buildIdentity.js";

test("an exported source build retains its own identity after packaging without git", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeybee-identity-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "honeybee", version: "0.2.0" }));
    await writeFile(join(root, ".build-provenance.json"), JSON.stringify({ sourceRevision: "a".repeat(40), dirty: false, releaseTag: null }));
    const identity = collectBuildIdentity(root);
    assert.equal(identity.version, "0.2.0-dev.aaaaaaaaaaaa");
    assert.equal(identity.sourceRevision, "a".repeat(40));
    assert.equal(identity.release, false);
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist", "build-identity.json"), JSON.stringify(identity));
    await rm(join(root, "package.json"));
    await rm(join(root, ".build-provenance.json"));
    assert.deepEqual(readBuildIdentity(join(root, "dist", "build-identity.json")), identity);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("tagged sources are releases only when clean; dirty and missing source evidence stay explicit", async () => {
  const { execFileSync } = await import("node:child_process");
  const root = await mkdtemp(join(tmpdir(), "honeybee-source-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "honeybee", version: "0.2.0" }));
    git("init"); git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "fixture"); git("-c", "tag.gpgSign=false", "tag", "v0.2.0");
    assert.equal(collectBuildIdentity(root).version, "0.2.0");
    assert.equal(collectBuildIdentity(root).release, true);
    await writeFile(join(root, "source.ts"), "dirty\n");
    const dirty = collectBuildIdentity(root);
    assert.equal(dirty.dirty, true);
    assert.equal(dirty.release, false);
    assert.match(dirty.version, /-dev\.[a-f0-9]{12}\.dirty$/);
    assert.deepEqual(collectBuildIdentity(root), dirty);
    await rm(join(root, ".git"), { recursive: true });
    assert.equal(collectBuildIdentity(root).sourceRevision, null);
    assert.equal(collectBuildIdentity(root).dirty, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("staging reservation tags preserve release provenance without changing runtime artifact identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeybee-stage-identity-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "honeybee", version: "0.2.0" }));
    const provenance = { sourceRevision: "a".repeat(40), dirty: false, releaseTag: `distribution-${"b".repeat(64)}-honeybee-v0.2.0` };
    await writeFile(join(root, ".build-provenance.json"), JSON.stringify(provenance));
    assert.equal(collectBuildIdentity(root).release, true);
    assert.equal(collectBuildIdentity(root).version, "0.2.0");
    for (const change of [{ dirty: true }, { releaseTag: `distribution-${"b".repeat(64)}-honeybee-v0.3.0` }]) {
      await writeFile(join(root, ".build-provenance.json"), JSON.stringify({ ...provenance, ...change }));
      assert.equal(collectBuildIdentity(root).release, false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
