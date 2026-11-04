import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectProcess, sameProcess } from "../v2/harness/src/processIdentity.ts";

const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  assert.ok(["--approved-head", "--node", "--codex", "--claude", "--scratch-parent", "--projection-export"].includes(key) && value && !options.has(key), "Pass each required named argument once");
  options.set(key, value);
}
for (const key of ["--approved-head", "--node", "--codex", "--claude", "--scratch-parent", "--projection-export"]) assert.ok(options.has(key), `Required ${key}`);
assert.equal(process.platform, "linux", "Queen Linux sandbox-ON host only; no real harness run is authorized in a worker Cell");
assert.equal(process.env.HIVE_CELL, undefined, "Run from the Queen host, never a Cell");
const sha = options.get("--approved-head");
assert.match(sha, /^[a-f0-9]{40}$/);
assert.match(options.get("--projection-export"), /^[A-Za-z_$][A-Za-z0-9_$]*$/);
const repository = fileURLToPath(new URL("..", import.meta.url));
const parent = options.get("--scratch-parent");
assert.ok(isAbsolute(parent));
assert.equal(realpathSync(parent), parent);
assert.equal(statSync(parent).uid, process.geteuid());
assert.ok(statSync(parent).isDirectory());
assert.equal(statSync(parent).mode & 0o077, 0, "Scratch parent must be private (0700)");
const paths = Object.fromEntries(["node", "codex", "claude"].map(name => {
  const path = options.get(`--${name}`);
  assert.ok(isAbsolute(path), `${name} must be an absolute Apiary executable path`);
  const resolved = realpathSync(path), info = statSync(resolved);
  assert.ok(info.isFile() && (info.mode & 0o111) && !(info.mode & 0o022), `Unsafe ${name} executable`);
  return [name, { path, resolved, sha256: createHash("sha256").update(readFileSync(resolved)).digest("hex") }];
}));
assert.equal(realpathSync(process.execPath), paths.node.resolved, "Invoke this script with the approved --node executable");
assert.equal(new Set(Object.values(paths).map(value => value.resolved)).size, 3, "Node and the two real harness executables must be distinct");
const root = mkdtempSync(join(parent, "queen-harness-"));
chmodSync(root, 0o700);
const build = join(root, "build"), home = join(root, "home"), temp = join(root, "tmp");
for (const path of [build, home, temp, join(root, "cache")]) mkdirSync(path, { mode: 0o700 });
const env = { PATH: `${dirname(paths.node.path)}:/usr/bin:/bin`, HOME: home, TMPDIR: temp,
  XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(root, "cache"),
  npm_config_cache: join(root, "cache", "npm"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LANG: "C.UTF-8" };
const receipt = { version: 1, approvedHead: sha, root, executables: paths, passed: false, argv: [], fixtureOnly: true,
  runnerSha256: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex") };
const tracked = new Map();
async function run(command, args, cwd, timeoutMs) {
  receipt.argv.push({ command, args, cwd });
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output += chunk; if (output.length > 16 * 1024 * 1024) output = output.slice(-16 * 1024 * 1024); });
  child.once("spawn", () => {
    const identity = inspectProcess(child.pid);
    if (identity.kind === "present") tracked.set(child.pid, identity);
    else child.kill("SIGTERM");
  });
  const timer = setTimeout(() => {
    const identity = tracked.get(child.pid);
    if (identity && sameProcess(identity, inspectProcess(child.pid))) process.kill(-child.pid, "SIGTERM");
  }, timeoutMs);
  const escalation = setTimeout(() => {
    const identity = tracked.get(child.pid);
    if (identity && sameProcess(identity, inspectProcess(child.pid))) process.kill(-child.pid, "SIGKILL");
  }, timeoutMs + 20000);
  try {
    await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}/${signal}\n${output}`))); });
    return output;
  } finally { clearTimeout(timer); clearTimeout(escalation); tracked.delete(child.pid); writeFileSync(join(root, "commands.log"), output, { flag: "a", mode: 0o600 }); }
}
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  interrupted = true;
  for (const [pid, identity] of tracked) if (sameProcess(identity, inspectProcess(pid))) process.kill(-pid, "SIGTERM");
});
try {
  assert.equal(inspectProcess(process.pid).kind, "present", "Build the reviewed script checkout's peer identity bridge before using this runner");
  const git = (args, cwd = repository) => {
    const result = spawnSync("/usr/bin/git", args, { cwd, env, encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  assert.equal(git(["status", "--porcelain"]), "", "Script checkout must be clean");
  assert.equal(git(["rev-parse", `${sha}^{commit}`]), sha);
  git(["cat-file", "-e", `${sha}:v2/driver-cell/src/apiaryHarness.ts`]);
  const archive = join(root, "source.tar");
  git(["archive", "--format=tar", `--output=${archive}`, sha]);
  await run("/usr/bin/tar", ["-xf", archive, "-C", build], root, 30000);
  writeFileSync(join(build, ".build-provenance.json"), JSON.stringify({ sourceRevision: sha, dirty: false, releaseTag: null }), { mode: 0o600, flag: "wx" });
  for (const name of ["queen-harness-worker.mjs", "queen-harness-mocks.mjs"]) {
    const source = join(repository, "scripts", name);
    copyFileSync(source, join(build, "scripts", name));
    receipt[name] = createHash("sha256").update(readFileSync(source)).digest("hex");
  }
  receipt.lockSha256 = createHash("sha256").update(readFileSync(join(build, "package-lock.json"))).digest("hex");
  const npm = join(dirname(paths.node.resolved), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  assert.ok(existsSync(npm), "Pinned Node installation must carry npm");
  await run(paths.node.resolved, [npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], build, 180000);
  await run(paths.node.resolved, [npm, "run", "build"], build, 180000);
  assert.equal(JSON.parse(readFileSync(join(build, "dist", "build-identity.json"), "utf8")).sourceRevision, sha);
  const input = { root, build, sha, paths, projectionExport: options.get("--projection-export") };
  const inputPath = join(root, "input.json");
  writeFileSync(inputPath, JSON.stringify(input), { mode: 0o600, flag: "wx" });
  assert.ok(!interrupted, "Interrupted before fixture start");
  await run(paths.node.resolved, ["--import", "tsx", "scripts/queen-harness-worker.mjs", inputPath], build, 180000);
  receipt.results = JSON.parse(readFileSync(join(root, "results.json"), "utf8"));
  assert.equal(receipt.results.passed, true);
  receipt.passed = true;
} catch (error) { receipt.failure = String(error); process.exitCode = 1; }
finally {
  try {
    const inventory = join(root, "owned-processes.json");
    if (existsSync(inventory)) {
      const identities = JSON.parse(readFileSync(inventory, "utf8"));
      const ownGroup = inspectProcess(process.pid).pgid;
      for (const identity of identities) {
        const current = inspectProcess(identity.pid);
        if (sameProcess(identity, current) && current.kind === "present" && current.state === "live") {
          assert.ok(current.pgid === identity.pgid && current.pgid !== ownGroup && current.pgid > 1, "Owned process group identity changed");
          process.kill(-current.pgid, "SIGKILL");
          receipt.passed = false;
          receipt.forcedCleanup = true;
          process.exitCode = 1;
        }
      }
      const deadline = Date.now() + 10000;
      while (identities.some(identity => { const current = inspectProcess(identity.pid); return sameProcess(identity, current) && current.state === "live"; })) {
        assert.ok(Date.now() < deadline, "Owned runtime cleanup deadline exceeded");
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  } catch (error) { receipt.passed = false; receipt.cleanupFailure = String(error); process.exitCode = 1; }
  writeFileSync(join(root, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ passed: receipt.passed, receipt: join(root, "receipt.json"), retainedOwnedScratch: root }));
}
