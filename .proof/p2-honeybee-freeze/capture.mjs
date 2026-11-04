#!/usr/bin/env node
// Replay the same deploy/rollback/completion inputs against one hive CLI and
// record stdout, stderr and exit code per scenario.
// Usage: node capture.mjs <dist/cli.js> <fixture dir> <out dir>
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const [cliArg, fixtureArg, outArg] = process.argv.slice(2);
if (!cliArg || !fixtureArg || !outArg) throw new Error("usage: capture.mjs <dist/cli.js> <fixture dir> <out dir>");
const cli = resolve(cliArg), fixture = resolve(fixtureArg), out = resolve(outArg);
const ROOT = "/tmp/hb-freeze-capture";
const SHA_A = "a".repeat(40), SHA_B = "b".repeat(40);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const archive = join(fixture, "release", `honeybee-runtime-${"f".repeat(40)}.tar.gz`);

function env(store) {
  return { ...process.env, HIVE_STORE_ROOT: store, HIVE_V2_DATA_DIR: join(store, "v2"), HIVE_V2_SERVICE_DIR: join(store, "units"),
    HIVE_V2_SERVICE_LABEL: "honeybee.freeze.fixture", HIVE_NODE_PATH: process.execPath, HIVE_NO_KEYCHAIN: "1", NO_COLOR: "1", TERM: "dumb", HOME: join(store, "home") };
}

async function freshStore(name, v2Live = true) {
  const store = join(ROOT, name);
  await rm(store, { recursive: true, force: true });
  await mkdir(join(store, "home"), { recursive: true });
  await mkdir(join(store, "runtime"), { recursive: true });
  if (v2Live) await writeFile(join(store, "runtime", "runtime-mode.json"), `${JSON.stringify({ schemaVersion: 1, runtime: "v2" })}\n`);
  return store;
}
async function pinNode(store) {
  const { createHash } = await import("node:crypto");
  const { readFileSync, realpathSync } = await import("node:fs");
  const path = realpathSync(process.execPath);
  await writeFile(join(store, "node-runtime.json"), `${JSON.stringify({ path, version: process.versions.node, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") })}\n`);
}

const results = [];
async function scenario(name, store, args, cwd = store) {
  let stdout = "", stderr = "", code = 0;
  try { ({ stdout, stderr } = await run(process.execPath, [cli, ...args], { cwd, env: env(store), maxBuffer: 16 * 1024 * 1024 })); }
  catch (error) { stdout = error.stdout ?? ""; stderr = error.stderr ?? ""; code = typeof error.code === "number" ? error.code : 1; }
  await writeFile(join(out, `${name}.stdout`), stdout);
  await writeFile(join(out, `${name}.stderr`), stderr);
  results.push({ name, args, code });
  return { stdout, stderr, code };
}

async function seedRuntime(store, cliSource) {
  const root = join(store, "runtime");
  for (const sha of [SHA_A, SHA_B]) {
    await mkdir(join(root, sha, "dist", "v2"), { recursive: true });
    await writeFile(join(root, sha, "dist", "cli.js"), cliSource);
    await writeFile(join(root, sha, "dist", "v2", "cli.js"), "var SCHEMA_VERSION = 48;\n");
    await writeFile(join(root, sha, "dist", "build-identity.json"), JSON.stringify({ schemaVersion: 1, component: "honeybee", version: "0.1.0", packageVersion: "0.1.0", sourceRevision: sha, dirty: false, release: true, target: `${process.platform}-${process.arch}` }));
  }
  await symlink(SHA_B, join(root, "current"));
  await writeFile(join(root, "deploys.json"), JSON.stringify({ schemaVersion: 1, entries: [
    { sha: SHA_A, at: "2026-08-01T00:00:00.000Z", artifactHash: "1".repeat(64), by: "op" },
    { sha: SHA_B, at: "2026-08-02T00:00:00.000Z", artifactHash: "2".repeat(64), by: "op" } ] }));
}

// 1. artifact deploy on an empty node, then the identical replay, then history.
const fresh = await freshStore("artifact", false);
const artifactArgs = ["deploy", "--artifact", archive, "--identity", join(fixture, "identity.json"), "--admission", join(fixture, "admission.json"), "--expected-current", "none", "--bin-dir", join(fresh, "bin")];
await scenario("artifact-fresh", fresh, artifactArgs);
await scenario("artifact-replay", fresh, artifactArgs);
await scenario("artifact-list-json", fresh, ["deploy", "--list", "--json"]);
await scenario("artifact-list", fresh, ["deploy", "--list"]);
await writeFile(join(out, "artifact-shim.stdout"), await readFile(join(fresh, "runtime", "hive"), "utf8").catch(() => "missing"));
await writeFile(join(out, "artifact-runtime-mode.stdout"), await readFile(join(fresh, "runtime", "runtime-mode.json"), "utf8").catch(() => "missing"));
await writeFile(join(out, "artifact-marker.stdout"), await readFile(join(fresh, "runtime", "f".repeat(40), ".honeybee-deployment.json"), "utf8").catch(() => "missing"));
await scenario("artifact-bad-checksum", fresh, ["deploy", "--artifact", archive, "--identity", join(fixture, "bad-identity.json"), "--admission", join(fixture, "admission.json"), "--expected-current", "none"]);
await scenario("artifact-missing-identity", fresh, ["deploy", "--artifact", archive, "--identity", join(fresh, "nope.json"), "--admission", join(fixture, "admission.json"), "--expected-current", "none"]);

// 2. rollback over a seeded two-version history, with the fixture CLI standing in for the daemon.
const seeded = await freshStore("rollback");
const fixtureCli = await readFile(join(fixture, "fixture-cli.js"), "utf8");
await seedRuntime(seeded, fixtureCli);
await pinNode(seeded);
await scenario("rollback-list-before", seeded, ["deploy", "--list"]);
await scenario("rollback", seeded, ["deploy", "--rollback"]);
await scenario("rollback-list-after-json", seeded, ["deploy", "--list", "--json"]);
await writeFile(join(out, "rollback-current.stdout"), `${(await import("node:fs")).readlinkSync(join(seeded, "runtime", "current"))}\n`);
await scenario("rollback-again", seeded, ["deploy", "--rollback"]);

// 3. usage refusals and read-only surfaces.
const usage = await freshStore("usage");
await scenario("help", usage, ["deploy", "--help"]);
await scenario("help-h", usage, ["deploy", "-h"]);
await scenario("unknown-flag", usage, ["deploy", "--dry-run"]);
await scenario("conflicting-modes", usage, ["deploy", "--list", "--rollback"]);
await scenario("stray-positionals", usage, ["deploy", "one", "two"]);
await scenario("skip-tests-banana", usage, ["deploy", "--skip-tests=banana"]);
await scenario("skip-tests-with-list", usage, ["deploy", "--skip-tests", "--list"]);
await scenario("orphan-identity", usage, ["deploy", "--identity", "none"]);
await scenario("artifact-with-help", usage, [...artifactArgs, "--help"]);
await scenario("list-empty", usage, ["deploy", "--list"]);
await scenario("list-empty-json", usage, ["deploy", "--list", "--json"]);
await scenario("init", usage, ["deploy", "--init"]);
await scenario("outside-repo", usage, ["deploy"], "/tmp");
await scenario("rollback-nothing", usage, ["deploy", "--rollback"]);
await scenario("version", usage, ["--version"]);
await scenario("update-owner-status-no-daemon", usage, ["update-owner", "status"]);
await scenario("deploy-info-no-daemon", usage, ["deploy-info", "--json"]);

// 4. completion.
await scenario("completion-bash", usage, ["completion", "bash"]);
await scenario("completion-zsh", usage, ["completion", "zsh"]);
await scenario("completion-fish", usage, ["completion", "fish"]);
await scenario("complete-top", usage, ["__complete", "hive", ""]);
await scenario("complete-dep", usage, ["__complete", "hive", "dep"]);
await scenario("complete-deploy-flags", usage, ["__complete", "hive", "deploy", "--"]);
await scenario("complete-send", usage, ["__complete", "hive", "send", ""]);

await writeFile(join(out, "exit-codes.json"), `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results));
