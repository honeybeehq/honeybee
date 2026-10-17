import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "node:os";
import { readBuildIdentity } from "./buildIdentity.js";

/** JavaScript is portable; the only cross-build supported here uses shipped macOS PTY prebuilds. */
export function validateRuntimeBuildTarget(target: string | undefined, host = runtimeHostTarget()): asserts target is string {
  if (target !== "darwin-arm64" && target !== "linux-x64") throw new Error("Unsupported Honeybee runtime target");
  if (target !== host && !(host === "linux-x64" && target === "darwin-arm64")) {
    throw new Error(`Cannot package ${target} on ${host}`);
  }
}

/** Finalize an isolated production-dependency stage before hashing or archiving it. */
export async function prepareRuntimeTarget(stage: string, target: string): Promise<void> {
  if (target !== "darwin-arm64" && target !== "linux-x64") throw new Error("Unsupported Honeybee runtime target");
  const identityPath = join(stage, "dist/build-identity.json");
  const identity = readBuildIdentity(identityPath);
  if (target === "darwin-arm64") {
    const pty = join(stage, "node_modules/node-pty");
    const prebuilt = join(pty, "prebuilds/darwin-arm64");
    // Optional npm dependencies may silently fail installation. Never label a missing or
    // wrong-architecture PTY payload as a usable macOS release.
    for (const [name, fileType] of [["pty.node", 8], ["spawn-helper", 2]] as const) {
      const bytes = await readFile(join(prebuilt, name));
      if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf
        || bytes.readUInt32LE(4) !== 0x0100000c || bytes.readUInt32LE(12) !== fileType) {
        throw new Error(`Invalid darwin-arm64 node-pty prebuild: ${name}`);
      }
    }
    // node-pty searches build/Release before prebuilds. A Linux npm ci may have
    // compiled a host addon; only the target prebuilds belong in this runtime.
    await rm(join(pty, "build"), { recursive: true, force: true });
    await chmod(join(prebuilt, "spawn-helper"), 0o755);
  }
  await stagePeerCredentials(stage, target);
  await stageDeliveryFiles(stage, target);
  await writeFile(identityPath, `${JSON.stringify({ ...identity, target }, null, 2)}\n`);
}

async function stageDeliveryFiles(stage: string, target: string): Promise<void> {
  const root = join(stage, "dist/v2/delivery-file");
  const hostManifest = JSON.parse(await readFile(join(root, runtimeHostTarget(), "manifest.json"), "utf8"));
  const source = process.env.HIVE_DELIVERY_FILE_PREBUILTS ? join(process.env.HIVE_DELIVERY_FILE_PREBUILTS, target) : join(root, target);
  const manifestBytes = await readFile(join(source, "manifest.json"));
  const proofBytes = await readFile(join(source, "proof.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const proof = JSON.parse(proofBytes.toString("utf8"));
  const bytes = await readFile(join(source, "delivery-file.node"));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (manifest.version !== 1 || manifest.napi !== 8 || manifest.target !== target || manifest.sha256 !== digest || typeof manifest.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.sourceSha256) || manifest.sourceSha256 !== hostManifest.sourceSha256 || proof.version !== 1 || proof.passed !== true || proof.target !== target || proof.sha256 !== digest || proof.sourceSha256 !== manifest.sourceSha256) throw new Error(`Missing or unproven delivery file artifact: ${target}`);
  if (target === "darwin-arm64") {
    if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== 0x0100000c || bytes.readUInt32LE(12) !== 8) throw new Error(`Wrong delivery file artifact target: ${target}`);
  } else if (bytes.length < 64 || bytes.toString("hex", 0, 4) !== "7f454c46" || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(16) !== 3 || bytes.readUInt16LE(18) !== 62) throw new Error(`Wrong delivery file artifact target: ${target}`);
  await rm(root, {recursive: true, force: true});
  const destination = join(root, target);
  await mkdir(destination, {recursive: true});
  await writeFile(join(destination, "manifest.json"), manifestBytes);
  await writeFile(join(destination, "proof.json"), proofBytes);
  await writeFile(join(destination, "delivery-file.node"), bytes, {mode: 0o755});
}

async function stagePeerCredentials(stage: string, target: string): Promise<void> {
  const root = join(stage, "dist/v2/peercred");
  const hostManifest = JSON.parse(await readFile(join(root, runtimeHostTarget(), "manifest.json"), "utf8"));
  const source = process.env.HIVE_PEERCRED_PREBUILTS ? join(process.env.HIVE_PEERCRED_PREBUILTS, target) : join(root, target);
  const manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8"));
  const proof = JSON.parse(await readFile(join(source, "proof.json"), "utf8"));
  const bytes = await readFile(join(source, "peercred.node"));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (manifest.version !== 1 || manifest.napi !== 8 || manifest.target !== target || manifest.sha256 !== digest || manifest.sourceSha256 !== hostManifest.sourceSha256 || proof.passed !== true || proof.target !== target || proof.sha256 !== digest || proof.sourceSha256 !== manifest.sourceSha256) throw new Error(`Missing or unproven peer credential artifact: ${target}`);
  if (target === "darwin-arm64") {
    if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== 0x0100000c || bytes.readUInt32LE(12) !== 8) throw new Error(`Wrong peer credential artifact target: ${target}`);
  } else if (bytes.length < 64 || bytes.toString("hex", 0, 4) !== "7f454c46" || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(16) !== 3 || bytes.readUInt16LE(18) !== (target.endsWith("arm64") ? 183 : 62)) throw new Error(`Wrong peer credential artifact target: ${target}`);
  const selected = {manifest: await readFile(join(source, "manifest.json")), proof: await readFile(join(source, "proof.json")), binary: bytes};
  await rm(root, {recursive: true, force: true});
  const destination = join(root, target);
  await mkdir(destination, {recursive: true});
  await writeFile(join(destination, "manifest.json"), selected.manifest);
  await writeFile(join(destination, "proof.json"), selected.proof);
  await writeFile(join(destination, "peercred.node"), selected.binary, {mode: 0o755});
}

function runtimeHostTarget(): string {
  const kernel = type();
  return `${kernel === "Darwin" ? "darwin" : kernel === "Linux" ? "linux" : "unsupported"}-${process.arch}`;
}
