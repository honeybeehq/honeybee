import assert from "node:assert/strict";
import {spawn, spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {once} from "node:events";
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {RpcClient} from "../v2/cli/src/client.ts";

const [rootArg, fleetArg, publicArg] = process.argv.slice(2);
assert.ok(rootArg && fleetArg && publicArg);
const root = resolve(rootArg), fleet = resolve(fleetArg), released = resolve(publicArg);
assert.equal(process.getuid(), 1000);
const status = readFileSync("/proc/self/status", "utf8");
for (const name of ["CapEff", "CapPrm", "CapBnd", "CapInh", "CapAmb"]) assert.equal(BigInt("0x" + new RegExp(`^${name}:\\s*([0-9a-f]+)$`, "m").exec(status)[1]), 0n);
assert.match(status, /^NoNewPrivs:\s*1$/m);
assert.equal(readFileSync("/proc/net/route", "utf8").trim().split("\n").length <= 1, true);
const stat = readFileSync("/proc/self/stat", "utf8");
const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
assert.equal(Number(fields[2]), process.pid); assert.equal(Number(fields[3]), process.pid);
mkdirSync(root, {mode: 0o700});
const source = fileURLToPath(new URL("..", import.meta.url));
const digest = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const lock = digest(join(source, "package-lock.json"));
for (const target of [fleet, released]) assert.equal(digest(join(target, "package-lock.json")), lock);
function environment(dir) {
  const home = join(dir, "home"), temp = join(dir, "tmp"); mkdirSync(home, {mode: 0o700}); mkdirSync(temp, {mode: 0o700});
  return {PATH: `${resolve(process.execPath, "..") }:/usr/local/bin:/usr/bin:/bin`, HOME: home, TMPDIR: temp, LANG: "C.UTF-8", HIVE_REAL_HOME: home, HIVE_NO_KEYCHAIN: "1", HIVE_GATEWAYS_DISABLE: "1"};
}
async function attempt(label, storeSource, target) {
  const dir = join(root, label); mkdirSync(dir, {mode: 0o700});
  const env = environment(dir);
  writeFileSync(join(dir, "config.json"), JSON.stringify({tickMs: 20, naming: {auto: false}, cells: {root: join(dir, "cells"), retention: {enabled: false}}, accounts: {vaultDir: join(dir, "vault"), homesDir: join(dir, "homes"), limitsRefreshMs: 0}, agents: {stub: {command: process.execPath, args: [], adapter: "stub"}}}));
  const made = spawnSync(process.execPath, [fileURLToPath(new URL("./rollback-store-fixture.mjs", import.meta.url)), storeSource, dir], {env, encoding: "utf8", timeout: 15000});
  assert.equal(made.status, 0, made.stderr);
  const entry = join(target, "dist/cli.js"), child = spawn(process.execPath, [entry, "v2", "daemon", "run", "--data-dir", dir], {env, stdio: ["ignore", "pipe", "pipe"]});
  const exit = once(child, "exit"); let output = "";
  child.stdout.on("data", data => {output = (output + data).slice(-32768);}); child.stderr.on("data", data => {output = (output + data).slice(-32768);});
  let connected = false, client;
  try {
    const until = Date.now() + 15000;
    while (Date.now() < until && child.exitCode === null) {
      if (existsSync(join(dir, "hived.sock"))) {
        try { client = await RpcClient.connect(join(dir, "hived.sock"), 500); connected = true; break; } catch {client?.close();}
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (!connected) {
      if (child.exitCode === null) throw new Error("rollback daemon startup unresolved");
      const schemaRefused = /schema v\d+.*speaks v\d+|schema_newer|refusing to open a newer store/.test(output);
      return {label, outcome: schemaRefused ? "schema_refused" : "startup_failed", exit: child.exitCode, artifactSha256: digest(entry), runtimeArtifactSha256: digest(join(target, "dist/v2/cli.js")), outputSha256: createHash("sha256").update(output).digest("hex")};
    }
    const list = await client.request("list", {});
    assert.equal(list.views.some(row => row.bee?.id === "rollback-bee" && row.runtime?.state === "stopped"), true);
    client.close(); child.kill("SIGTERM");
    const result = await Promise.race([exit, new Promise((_, reject) => {const timer = setTimeout(() => reject(new Error("rollback daemon shutdown timed out")), 10000); timer.unref();})]);
    assert.equal(result[0], 0);
    return {label, outcome: "opened_read_started_stopped", exit: result[0], artifactSha256: digest(entry), runtimeArtifactSha256: digest(join(target, "dist/v2/cli.js"))};
  } finally {
    client?.close();
    if (child.exitCode === null && child.signalCode === null) {child.kill("SIGKILL"); await exit;}
    writeFileSync(join(dir, "daemon.log"), output);
  }
}
const rows = [];
rows.push(await attempt("fleet-after-new", source, fleet));
assert.equal(rows[0].outcome, "opened_read_started_stopped");
rows.push(await attempt("public-after-new", source, released));
if (rows[1].outcome !== "opened_read_started_stopped") {
  rows.push(await attempt("public-after-plain-fleet", fleet, released));
  assert.equal(rows[1].outcome, "schema_refused"); assert.equal(rows[2].outcome, "schema_refused");
}
console.log(JSON.stringify({passed: true, uid: process.getuid(), capabilities: "zero", noNewPrivs: true, network: "empty-private-netns", newSession: true, lockSha256: lock, sourceNodeModules: join(source, "node_modules"), dependencyCopy: "cp -a", rows}));
