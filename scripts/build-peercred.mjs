import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type } from "node:os";
import { fileURLToPath } from "node:url";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const kernel = type();
const platform = kernel === "Darwin" ? "darwin" : kernel === "Linux" ? "linux" : "unsupported";
const target = `${platform}-${process.arch}`;
const optional = process.argv.includes("--optional");
const output = resolve(process.argv.slice(2).find(value => value !== "--optional") ?? join(root, "dist/v2/peercred", target));
const source = join(root, "v2/daemon/native/peercred.c");
const lines = readFileSync(source, "utf8").trimEnd().split("\n").length;
if (lines >= 200) throw new Error("Peer credential C bridge must remain under 200 lines");
function clearArtifacts() {
  for (const file of ["peercred.node", "manifest.json", "proof.json"]) rmSync(join(output, file), {force: true});
}
const include = join(dirname(dirname(realpathSync(process.execPath))), "include/node");
clearArtifacts();
try {
  if (!["linux-x64", "linux-arm64", "darwin-arm64"].includes(target)) throw new Error(`Unsupported peer credential build target: ${target}`);
  if (!existsSync(join(include, "node_api.h"))) throw new Error(`Node-API headers unavailable: ${include}`);
  mkdirSync(output, {recursive: true});
  const binary = join(output, "peercred.node");
  execFileSync(process.env.CC ?? "cc", ["-DNAPI_VERSION=8", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", ...(platform === "darwin" ? ["-bundle", "-undefined", "dynamic_lookup"] : ["-shared", "-fPIC"]), `-I${include}`, source, "-o", binary], {stdio: "inherit"});
  const sha = bytes => createHash("sha256").update(bytes).digest("hex");
  writeFileSync(join(output, "manifest.json"), JSON.stringify({version: 1, target, sourceSha256: sha(readFileSync(source)), sha256: sha(readFileSync(binary)), napi: 8}) + "\n");
  console.log(`peer credential bridge ${target} (${lines} C lines)`);
} catch (error) {
  clearArtifacts();
  if (!optional) throw error;
  console.warn(`Peer credential bridge not built; runtime will report peer_credentials_unavailable: ${error.message}`);
}
