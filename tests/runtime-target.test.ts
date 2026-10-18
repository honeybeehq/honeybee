import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRuntimeTarget, validateRuntimeBuildTarget } from "../src/release/runtimeTarget.js";

async function peerArtifact(stage: string, target: string): Promise<void> {
  for (const name of ["peercred", "delivery-file"]) await nativeArtifact(stage, target, name);
}

async function nativeArtifact(stage: string, target: string, name: string): Promise<void> {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(0x0100000c, 4); bytes.writeUInt32LE(8, 12);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const sourceSha256 = "a".repeat(64);
  const directory = join(stage, "dist/v2", name, target);
  await mkdir(directory, {recursive: true});
  await writeFile(join(directory, `${name}.node`), bytes);
  await writeFile(join(directory, "manifest.json"), JSON.stringify({version: 1, target, napi: 8, sha256, sourceSha256}));
  await writeFile(join(directory, "proof.json"), JSON.stringify({version: 1, passed: true, target, sha256, sourceSha256}));
  const host = join(stage, "dist/v2", name, `${process.platform}-${process.arch}`);
  if (host !== directory) {
    await mkdir(host, {recursive: true});
    await writeFile(join(host, "manifest.json"), JSON.stringify({sourceSha256}));
  }
}

test("a Linux build can package macOS PTY prebuilds without retaining host binaries or host identity", async t => {
  const stage = await mkdtemp(join(tmpdir(), "honeybee-target-"));
  t.after(() => rm(stage, { recursive: true, force: true }));
  const identity = { schemaVersion: 1, component: "honeybee", version: "0.2.0", packageVersion: "0.2.0",
    sourceRevision: "a".repeat(40), dirty: false, release: true, target: "linux-x64" };
  await mkdir(join(stage, "dist"));
  await writeFile(join(stage, "dist/build-identity.json"), JSON.stringify(identity));
  const pty = join(stage, "node_modules/node-pty");
  const prebuilt = join(pty, "prebuilds/darwin-arm64");
  await mkdir(prebuilt, { recursive: true });
  await mkdir(join(pty, "build/Release"), { recursive: true });
  await writeFile(join(pty, "build/Release/pty.node"), "Linux host binary");
  // Mach-O 64-bit little endian, ARM64; bundle and executable respectively.
  for (const [file, type] of [["pty.node", 8], ["spawn-helper", 2]] as const) {
    const bytes = Buffer.alloc(32);
    bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(0x0100000c, 4); bytes.writeUInt32LE(type, 12);
    await writeFile(join(prebuilt, file), bytes, { mode: 0o644 });
  }
  validateRuntimeBuildTarget("darwin-arm64", "linux-x64");
  await assert.rejects(prepareRuntimeTarget(stage, "darwin-arm64"), {code: "ENOENT"});
  await peerArtifact(stage, "darwin-arm64");
  const deliveryProof = join(stage, "dist/v2/delivery-file/darwin-arm64/proof.json");
  await rm(deliveryProof);
  await assert.rejects(prepareRuntimeTarget(stage, "darwin-arm64"), {code: "ENOENT"});
  assert.deepEqual(JSON.parse(await readFile(join(stage, "dist/build-identity.json"), "utf8")), identity);
  await peerArtifact(stage, "darwin-arm64");
  const invalidProof = JSON.parse(await readFile(deliveryProof, "utf8"));
  await writeFile(deliveryProof, JSON.stringify({...invalidProof, passed: false}));
  await assert.rejects(prepareRuntimeTarget(stage, "darwin-arm64"), /Missing or unproven delivery file artifact/);
  await peerArtifact(stage, "darwin-arm64");
  await prepareRuntimeTarget(stage, "darwin-arm64");
  assert.deepEqual(JSON.parse(await readFile(join(stage, "dist/build-identity.json"), "utf8")), { ...identity, target: "darwin-arm64" });
  await assert.rejects(stat(join(pty, "build")), { code: "ENOENT" });
  assert.equal((await stat(join(prebuilt, "spawn-helper"))).mode & 0o111, 0o111);
  assert.equal((await readFile(join(prebuilt, "pty.node"))).readUInt32LE(4), 0x0100000c);
  assert.equal(JSON.parse(await readFile(join(stage, "dist/v2/peercred/darwin-arm64/proof.json"), "utf8")).passed, true);
  assert.equal(JSON.parse(await readFile(join(stage, "dist/v2/delivery-file/darwin-arm64/proof.json"), "utf8")).passed, true);
  if (process.platform === "linux") await assert.rejects(stat(join(stage, "dist/v2/delivery-file/linux-x64")), {code: "ENOENT"});
  if (process.platform === "linux") await assert.rejects(stat(join(stage, "dist/v2/peercred/linux-x64")), {code: "ENOENT"});
});

test("unsupported cross-builds are refused before building or reserving a release", () => {
  for (const target of [undefined, "darwin-x64", "windows-x64", ""]) {
    assert.throws(() => validateRuntimeBuildTarget(target, "linux-x64"), /Unsupported/);
  }
  assert.throws(() => validateRuntimeBuildTarget("linux-x64", "darwin-arm64"), /Cannot package/);
  validateRuntimeBuildTarget("linux-x64", "linux-x64");
  validateRuntimeBuildTarget("darwin-arm64", "darwin-arm64");
});

test("absent or wrong-architecture macOS prebuilds cannot relabel an archive", async t => {
  const stage = await mkdtemp(join(tmpdir(), "honeybee-target-refusal-"));
  t.after(() => rm(stage, { recursive: true, force: true }));
  await mkdir(join(stage, "dist"));
  const identity = JSON.stringify({ schemaVersion: 1, component: "honeybee", version: "0.2.0", packageVersion: "0.2.0",
    sourceRevision: "a".repeat(40), dirty: false, release: true, target: "linux-x64" });
  await writeFile(join(stage, "dist/build-identity.json"), identity);
  await assert.rejects(prepareRuntimeTarget(stage, "darwin-arm64"), { code: "ENOENT" });
  const prebuilt = join(stage, "node_modules/node-pty/prebuilds/darwin-arm64");
  await mkdir(prebuilt, { recursive: true });
  await writeFile(join(prebuilt, "pty.node"), Buffer.from("\x7fELFwrong platform"));
  await assert.rejects(prepareRuntimeTarget(stage, "darwin-arm64"), /Invalid darwin-arm64/);
  const wrongArch = Buffer.alloc(32);
  wrongArch.writeUInt32LE(0xfeedfacf, 0); wrongArch.writeUInt32LE(0x01000007, 4); wrongArch.writeUInt32LE(8, 12);
  await writeFile(join(prebuilt, "pty.node"), wrongArch);
  await assert.rejects(prepareRuntimeTarget(stage, "darwin-arm64"), /Invalid darwin-arm64/);
  assert.equal(await readFile(join(stage, "dist/build-identity.json"), "utf8"), identity);
});
