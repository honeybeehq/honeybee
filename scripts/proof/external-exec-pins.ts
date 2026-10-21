import { readFileSync, lstatSync, readlinkSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import assert from "node:assert/strict";
import { externalConfig, record, sha256 } from "../../v2/core/src/externalExec.ts";
import { verifyBridge, immutableBridgePath } from "../../v2/driver-hsr/src/externalBridge.ts";

const config = externalConfig(record(JSON.parse(readFileSync(process.argv[2]!, "utf8"))).externalExec);
const registration = config.bridges["urbench-v2"];
assert.ok(registration);
const fields = [["executable", "executableSha256"], ["filesManifest", "filesManifestSha256"], ["payloadManifest", "payloadManifestSha256"]] as const;
const verified = verifyBridge({ registration }); verified.close();
const inventory = record(JSON.parse(readFileSync(registration.filesManifest, "utf8")));
assert.ok(Array.isArray(inventory.files));
const paths = inventory.files.map((entry: unknown) => { const file = record(entry); assert.equal(typeof file.path, "string"); return String(file.path); });
const payloadPaths = readFileSync(registration.payloadManifest, "utf8").trim().split("\n").map(line => line.slice(66));
function components(paths: string[]): Set<string> {
  const seen = new Set<string>(["/"]);
  for (const path of paths) {
    let queue = path.split("/").filter(Boolean), current = "/", links = 0;
    while (queue.length) {
      const part = queue.shift()!;
      if (part === ".") continue;
      if (part === "..") { current = dirname(current); continue; }
      const next = join(current, part); seen.add(next);
      if (lstatSync(next).isSymbolicLink()) {
        if (++links > 64) throw new Error("install_symlink_loop");
        const target = resolve(dirname(next), readlinkSync(next));
        queue = [...target.split("/").filter(Boolean), ...queue]; current = "/";
      } else current = next;
    }
  }
  return seen;
}
const inventoryComponents = components(paths);
const allComponents = components([...paths, ...fields.map(([path]) => registration[path]), ...payloadPaths, join(dirname(registration.filesManifest), "registration.json")]);
for (const component of allComponents) immutableBridgePath(component);
const pins = fields.map(([path, hash]) => {
  const stat = statSync(registration[path]);
  assert.equal(stat.uid, 0);
  assert.equal(stat.mode & 0o7777, path === "executable" ? 0o555 : 0o444);
  return {path: registration[path], expected: registration[hash], actual: sha256(readFileSync(registration[path])), uid: stat.uid, mode: (stat.mode & 0o7777).toString(8).padStart(4, "0")};
});
const mismatches = fields.map(([, hash]) => {
  const expected = registration[hash];
  const wrong = (expected[0] === "0" ? "1" : "0") + expected.slice(1);
  assert.throws(() => verifyBridge({registration: {...registration, [hash]: wrong}}), {message: "external_exec_install_mismatch"});
  return {pin: hash, result: "refused", reason: "external_exec_install_mismatch"};
});
process.stdout.write(`${JSON.stringify({schema: "honeybee.external.pin-check.v1", bridgeId: "urbench-v2", source: inventory.sourceCommit, executed: false, registered: false, liveChanges: false, result: "verified-read-only", pins, inventoryFiles: paths.length, components: allComponents.size, inventoryComponents: inventoryComponents.size, componentDefinition: "unique symlink-expanded traversal components for inventory, pin files, payload paths and registration.json", installChain: "pass", mismatches}, null, 2)}\n`);
