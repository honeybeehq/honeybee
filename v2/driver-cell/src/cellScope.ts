import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function cellScopeArtifactDirectory(): string {
  return fileURLToPath(new URL(fileURLToPath(import.meta.url).endsWith(".ts") ? `../../../dist/v2/cell-scope/linux-${process.arch}/` : `./cell-scope/linux-${process.arch}/`, import.meta.url));
}

export function validatedCellScopeBinary(directory = cellScopeArtifactDirectory()): string {
  const binary = join(directory, "cell-scope");
  const target = `linux-${process.arch}`;
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  const bytes = readFileSync(binary);
  const info = lstatSync(binary);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o111) === 0 || manifest.version !== 1 || manifest.target !== target
    || manifest.cliShimSha256 !== createHash("sha256").update(readFileSync(join(directory, "hive"))).digest("hex")
    || manifest.sha256 !== hash || !/^[a-f0-9]{64}$/.test(manifest.sourceSha256)
    || bytes.length < 64 || bytes.toString("hex", 0, 4) !== "7f454c46" || bytes[4] !== 2 || bytes[5] !== 1
    || ![2, 3].includes(bytes.readUInt16LE(16)) || bytes.readUInt16LE(18) !== (process.arch === "x64" ? 62 : 183)) {
    throw new Error("cell sandbox: missing or mismatched Landlock scope artifact; refusing launch");
  }
  return binary;
}

export function cellCliBundlePath(): string {
  return fileURLToPath(new URL(fileURLToPath(import.meta.url).endsWith(".ts") ? "../../../dist/v2/cli.js" : "./cli.js", import.meta.url));
}
