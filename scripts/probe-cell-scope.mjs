import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { release } from "node:os";

if (process.platform !== "linux") process.exit(0);
const target = `linux-${process.arch}`;
const directory = resolve(process.argv[2] ?? `dist/v2/cell-scope/${target}`);
const binary = join(directory, "cell-scope");
const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
const sha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
assert.equal(manifest.sha256, sha256);
const version = spawnSync(binary, ["--abi"], { encoding: "utf8", timeout: 5000 });
assert.equal(version.status, 0, version.stderr);
const abi = Number(version.stdout.trim());
assert.ok(abi >= 6, `Landlock ABI >= 6 required; observed ${abi}`);
const socket = "\0hive-t11-fixture-" + randomUUID();
const server = createServer(connection => connection.destroy());
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
let child;
try {
  const script = `
    const net = require('node:net');
    const external = net.connect('\\0' + process.argv[1]);
    external.once('connect', () => process.exit(3));
    external.once('error', error => {
      if (error.code !== 'EPERM') { console.error(error.code); process.exit(4); }
      const name = '\\0' + process.argv[1] + '-inner';
      const server = net.createServer(connection => connection.end('inside'));
      server.listen(name, () => {
        const client = net.connect(name); let value = '';
        client.on('data', data => value += data);
        client.on('end', () => { server.close(); console.log(JSON.stringify({ outside: error.code, inside: value })); });
        client.on('error', () => process.exit(5));
      });
    });
  `;
  child = spawn(binary, ["--", process.execPath, "-e", script, socket.slice(1)], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => stdout += data);
  child.stderr.on("data", data => stderr += data);
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const code = await new Promise(resolve => child.once("close", resolve));
  clearTimeout(timeout);
  assert.equal(code, 0, stderr);
  const result = JSON.parse(stdout);
  assert.deepEqual(result, { outside: "EPERM", inside: "inside" });
  const proof = { version: 1, passed: true, target, sha256, sourceSha256: manifest.sourceSha256, kernel: release(), abi, ...result };
  writeFileSync(join(directory, "proof.json"), JSON.stringify(proof) + "\n");
  console.log(JSON.stringify(proof));
} finally {
  await new Promise(resolve => server.close(resolve));
}
