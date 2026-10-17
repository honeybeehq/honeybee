import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const target = `${process.platform}-${process.arch}`;
const directory = join(root, "dist/v2/delivery-file", target);
const source = join(root, "v2/daemon/native/delivery-file.c");
const binary = join(directory, "delivery-file.node");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
try {
  if (!["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"].includes(target)) throw new Error("Unsupported delivery-file native target");
  mkdirSync(directory, { recursive: true });
  const include = join(dirname(dirname(realpathSync(process.execPath))), "include/node");
  execFileSync(process.env.CC ?? "cc", ["-DNAPI_VERSION=8", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", ...(process.platform === "darwin" ? ["-bundle", "-undefined", "dynamic_lookup"] : ["-shared", "-fPIC"]), `-I${include}`, source, "-o", binary], { stdio: "inherit" });
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({ version: 1, target, napi: 8, sourceSha256: hash(readFileSync(source)), sha256: hash(readFileSync(binary)) }) + "\n");
} catch (error) {
  rmSync(binary, { force: true });
  rmSync(join(directory, "manifest.json"), { force: true });
  if (!process.argv.includes("--optional")) throw error;
  console.warn(`Delivery-file native helper unavailable: ${error.message}`);
}
