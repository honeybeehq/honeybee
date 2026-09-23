import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readBuildIdentity } from "./buildIdentity.js";

/** JavaScript is portable; the only cross-build supported here uses shipped macOS PTY prebuilds. */
export function validateRuntimeBuildTarget(target: string | undefined, host = `${process.platform}-${process.arch}`): asserts target is string {
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
  await writeFile(identityPath, `${JSON.stringify({ ...identity, target }, null, 2)}\n`);
}
