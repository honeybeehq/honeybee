import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const directory = resolve(process.argv.slice(2).find(value => value !== "--optional") ?? `dist/v2/peercred/${process.platform}-${process.arch}`);
if (process.argv.includes("--optional") && !existsSync(join(directory, "peercred.node"))) {
  console.warn("Peer credential proof skipped: local native artifact is unavailable; release staging remains strict.");
  process.exit(0);
}
const bridge = createRequire(import.meta.url)(join(directory, "peercred.node"));
const root = mkdtempSync(join(tmpdir(), "hive-peer-proof-"));
const socketPath = join(root, "rpc.sock");
const server = createServer();
let child;
let socket;
let pin = -1;
try {
  server.listen(socketPath);
  await once(server, "listening");
  const incoming = once(server, "connection");
  child = spawn(process.execPath, ["--input-type=module", "-e", "import {createConnection} from 'node:net'; const s=createConnection(process.argv[1]); s.on('error',()=>process.exit(2));", socketPath], {stdio: "ignore", env: {...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state")}});
  [socket] = await incoming;
  const fd = socket._handle?.fd;
  assert.ok(Number.isInteger(fd) && fd >= 0);
  pin = bridge.pin(fd);
  const peer = bridge.inspect(fd);
  assert.equal(peer.uid, process.geteuid());
  assert.equal(peer.pid, child.pid);
  assert.match(peer.birth, process.platform === "linux" ? /^linux:\d+$/ : /^darwin:\d+:\d+$/);
  assert.deepEqual(bridge.inspect(fd), peer);
  if (pin >= 0) assert.equal(bridge.alive(pin), true);
  assert.equal(socket.destroyed, false);
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  writeFileSync(join(directory, "proof.json"), JSON.stringify({passed: true, target: `${process.platform}-${process.arch}`, sha256: manifest.sha256, sourceSha256: manifest.sourceSha256, node: process.version}) + "\n");
  console.log(JSON.stringify({passed: true, target: `${process.platform}-${process.arch}`, node: process.version, uid: peer.uid, pid: peer.pid, processBirth: peer.birth, pidfd: pin >= 0}));
} finally {
  if (pin >= 0) closeSync(pin);
  socket?.destroy();
  if (child && child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
  await new Promise(resolve => server.close(resolve));
  rmSync(root, {recursive: true, force: true});
}
