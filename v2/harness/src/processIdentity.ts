import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function validatePeerArtifact(directory: string, target: string): string {
  if (!["linux-x64", "linux-arm64", "darwin-arm64"].includes(target)) throw new Error("Unsupported peer credential target");
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  const binary = join(directory, "peercred.node");
  const bytes = readFileSync(binary);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (manifest.version !== 1 || manifest.target !== target || manifest.napi !== 8 || manifest.sha256 !== hash) throw new Error("Invalid peer credential artifact metadata");
  const [platform, architecture] = target.split("-");
  if (platform === "linux") {
    if (bytes.length < 64 || bytes.toString("hex", 0, 4) !== "7f454c46" || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(16) !== 3 || bytes.readUInt16LE(18) !== (architecture === "x64" ? 62 : 183)) throw new Error("Wrong peer credential ELF target");
  } else if (platform === "darwin") {
    if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== (architecture === "x64" ? 0x01000007 : 0x0100000c) || bytes.readUInt32LE(12) !== 8) throw new Error("Wrong peer credential Mach-O target");
  } else throw new Error("Unsupported peer credential target");
  return binary;
}

let reader: ((pid: number) => string | null) | null = null;
export function exactProcessBirth(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (!reader) {
      const target = process.platform + "-" + process.arch;
      const root = fileURLToPath(new URL(fileURLToPath(import.meta.url).endsWith(".ts") ? "../../../dist/v2/peercred/" : "./peercred/", import.meta.url));
      const path = validatePeerArtifact(join(root, target), target);
      const bridge = createRequire(import.meta.url)(path) as { processBirth?: (pid: number) => unknown };
      if (typeof bridge.processBirth !== "function") return null;
      reader = pid => { const value = bridge.processBirth!(pid); return typeof value === "string" && /^(?:linux:[0-9]+|darwin:[0-9]+:[0-9]+)$/.test(value) ? value : null; };
    }
    return reader(pid);
  } catch { return null; }
}
