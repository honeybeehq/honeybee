import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const target = `${process.platform}-${process.arch}`;
const directory = resolve(process.argv.slice(2).find(value => value !== "--optional") ?? `dist/v2/delivery-file/${target}`);
if (process.argv.includes("--optional") && !existsSync(join(directory, "delivery-file.node"))) process.exit(0);
rmSync(join(directory, "proof.json"), {force: true});
const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
const digest = createHash("sha256").update(readFileSync(join(directory, "delivery-file.node"))).digest("hex");
assert.equal(manifest.target, target);
assert.equal(manifest.sha256, digest);
const bridge = createRequire(import.meta.url)(join(directory, "delivery-file.node"));
const root = realpathSync(mkdtempSync(join(tmpdir(), "delivery-file-probe-")));
try {
  const bee = createHash("sha256").update("probe").digest("hex"), id = randomUUID(), bytes = Buffer.from("line one\nline two 雪\n");
  bridge.publish(root, bee, id, bytes);
  const path = join(root, "delivery-content", bee, `${id}.txt`), inode = statSync(path).ino;
  assert.deepEqual(readFileSync(path), bytes);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, "delivery-content", bee)).mode & 0o777, 0o700);
  bridge.publish(root, bee, id, bytes);
  assert.equal(statSync(path).ino, inode);
  assert.throws(() => bridge.publish(root, bee, id, Buffer.from("other")));
  bridge.remove(root, bee, id);
  assert.equal(existsSync(path), false);
  writeFileSync(join(directory, "proof.json"), JSON.stringify({version: 1, target, passed: true, sha256: digest, sourceSha256: manifest.sourceSha256}) + "\n");
} finally {
  rmSync(root, {recursive: true, force: true});
}
