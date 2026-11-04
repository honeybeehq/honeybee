import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

export function cellCliReadOnlyFiles(directory = dirname(cellCliBundlePath())): { source: string; destination: string }[] {
  const failure = () => new Error("cell sandbox: missing or invalid Cell CLI closure; refusing launch");
  const manifestPath = join(directory, "cell-cli-manifest.json");
  const manifestInfo = lstatSync(manifestPath, { throwIfNoEntry: false });
  if (!manifestInfo?.isFile() || manifestInfo.isSymbolicLink()) throw failure();
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.version !== 1 || manifest.entry !== "cli.js" || !manifest.files || typeof manifest.files !== "object") throw failure();
  const pending = [manifest.entry];
  const seen = new Set<string>();
  const files: { source: string; destination: string }[] = [];
  while (pending.length) {
    const name = pending.pop()!;
    if (seen.has(name)) continue;
    if (name !== "cli.js" && !/^cli-chunk-[A-Z0-9]+\.js$/.test(name)) throw failure();
    const metadata = manifest.files[name];
    if (!metadata || !/^[a-f0-9]{64}$/.test(metadata.sha256) || !Array.isArray(metadata.imports) || metadata.imports.some((value: unknown) => typeof value !== "string")) throw failure();
    const source = join(directory, name);
    const info = lstatSync(source, { throwIfNoEntry: false });
    if (!info?.isFile() || info.isSymbolicLink() || createHash("sha256").update(readFileSync(source)).digest("hex") !== metadata.sha256) throw failure();
    seen.add(name);
    files.push({ source, destination: join("/run/honeybee", name === "cli.js" ? "hive.mjs" : name) });
    pending.push(...metadata.imports);
  }
  return files;
}
