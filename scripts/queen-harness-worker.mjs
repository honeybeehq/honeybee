import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { HiveDaemon } from "../v2/daemon/src/daemon.ts";
import { loadNodeConfig } from "../v2/daemon/src/config.ts";
import { RpcClient } from "../v2/cli/src/client.ts";
import { inspectProcess, sameProcess } from "../v2/harness/src/processIdentity.ts";
import { startMock, TOOL_COMMAND } from "./queen-harness-mocks.mjs";

const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
const { root, build, paths, sha } = input;
assert.equal(resolve(build), process.cwd());
assert.equal(lstatSync(root).uid, process.geteuid());
assert.equal(lstatSync(root).mode & 0o777, 0o700);
const capability = await import(pathToFileURL(join(build, "v2/driver-cell/src/apiaryHarness.ts")));
assert.equal(typeof capability[input.projectionExport], "function", "Approved projection export is missing; refusing harness launch");
const results = { approvedHead: sha, passed: false, lanes: [], cleanup: [] };
let active;
let stopping = false;
const ownedIdentities = new Map();
function captureOwned() {
  const daemon = active?.daemon;
  if (!daemon?.store || !daemon.driver) return;
  for (const row of daemon.driver.snapshotLive()) {
    const binding = daemon.store.runtimeProcessIdentity(row.beeId, row.generation);
    if (binding.kind !== "bound") continue;
    const current = inspectProcess(row.pid);
    if (sameProcess(binding.identity, current) && current.kind === "present") ownedIdentities.set(current.pid, current);
  }
  for (const runtime of daemon.driver.cell.inner.procs.values()) {
    if (!runtime.agentPid) continue;
    const current = inspectProcess(runtime.agentPid);
    if (current.kind === "present" && current.pgid === runtime.pid) ownedIdentities.set(current.pid, current);
  }
  writeFileSync(join(root, "owned-processes.json"), JSON.stringify([...ownedIdentities.values()]), { mode: 0o600 });
}
const ownershipTimer = setInterval(() => { try { captureOwned(); } catch (error) { results.ownershipFailure = String(error); stopping = true; } }, 50);
async function cleanup() {
  if (!active) return;
  const current = active;
  let ownershipError;
  try { captureOwned(); } catch (error) { ownershipError = error; }
  active = undefined;
  current.client?.close();
  const identities = (current.daemon?.driver?.snapshotLive?.() ?? []).map(row => {
    const binding = current.daemon.store.runtimeProcessIdentity(row.beeId, row.generation);
    return { ...row, identity: binding.kind === "bound" ? binding.identity : null };
  });
  try { await current.daemon?.shutdown({ preserveRuntimes: false }); }
  finally { await current.mock?.close(); }
  if (ownershipError) throw ownershipError;
  const deadline = Date.now() + 10000;
  for (const row of identities) {
    const identity = row.identity;
    if (!identity) throw new Error("Owned runtime cleanup lacks pinned process identity");
    while (sameProcess(identity, inspectProcess(identity.pid)) && inspectProcess(identity.pid).state === "live") {
      if (Date.now() > deadline) throw new Error(`Owned runtime ${identity.pid} failed to exit`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  if (results.ownershipFailure) throw new Error(results.ownershipFailure);
  results.cleanup.push({ harness: current.harness, runtimes: identities.map(row => row.identity), exited: true });
}
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { stopping = true; });
async function wait(fn, label, mock) {
  const deadline = Date.now() + 60000;
  while (!stopping && Date.now() < deadline) {
    if (mock.state.failure) throw new Error(mock.state.failure);
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Fixture interrupted/timed out: ${label}`);
}
try {
  for (const harness of ["codex", "claude"]) {
    const lane = join(root, harness), data = join(lane, "d"), home = join(lane, "home"), account = join(lane, "account"), origin = join(lane, "origin");
    for (const path of [lane, data, home, account, origin]) mkdirSync(path, { mode: 0o700 });
    const gitEnv = { PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const git = args => execFileSync("/usr/bin/git", ["-c", "user.name=QueenFixture", "-c", "user.email=queen@example.invalid", "-c", "core.hooksPath=/dev/null", ...args], { cwd: origin, env: gitEnv, encoding: "utf8", timeout: 10000 }).trim();
    git(["init", "-q"]);
    writeFileSync(join(origin, "AGENTS.md"), "Use only local fixture files.\n");
    writeFileSync(join(origin, "fixture-sentinel"), "queen-fixture\n");
    git(["add", "."]); git(["commit", "-qm", "queen-fixture-base"]);
    const base = git(["rev-parse", "HEAD"]);
    const mock = await startMock(harness);
    active = { harness, mock };
    if (harness === "codex") writeFileSync(join(account, "config.toml"), `model_provider = "queen_fixture"\nmodel = "queen_fixture"\n[model_providers.queen_fixture]\nname = "Queen fixture"\nbase_url = "${mock.url}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`, { mode: 0o600 });
    else {
      writeFileSync(join(account, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true }), { mode: 0o600 });
      writeFileSync(join(account, "settings.json"), JSON.stringify({ skipDangerousModePermissionPrompt: true }), { mode: 0o600 });
    }
    const harnessEnv = { HOME: home, PATH: `${paths.node.path.slice(0, paths.node.path.lastIndexOf("/"))}:/usr/bin:/bin`,
      ...(harness === "codex" ? { CODEX_HOME: account } : { CLAUDE_CONFIG_DIR: account, ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: "queen-fixture-dummy-key", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" }) };
    const version = execFileSync(paths[harness].path, ["--version"], { env: { ...harnessEnv, TMPDIR: join(root, "tmp"), XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache") }, encoding: "utf8", timeout: 10000 }).trim();
    assert.match(version, harness === "codex" ? /^codex(?:-cli)?\s+\d/ : /\bClaude Code\b/i, "Unexpected real harness version output");
    const configPath = join(data, "config.json");
    const socketPath = join(data, "h.sock");
    assert.ok(Buffer.byteLength(socketPath) < 100, "Choose a short scratch parent; refuse socket relocation");
    writeFileSync(configPath, JSON.stringify({ nodeKind: "satellite", socketPath,
      cells: { sandbox: true, warmPoolFree: 0, retention: { fetchUpstream: false } }, naming: { auto: false },
      accounts: { homesDir: join(lane, "homes"), vaultDir: join(lane, "vault") },
      agents: { [harness]: { command: paths[harness].path, adapter: harness,
        args: harness === "codex" ? ["app-server"] : ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--model", "claude-queen-fixture"], env: harnessEnv } },
    }), { mode: 0o600, flag: "wx" });
    const cfg = loadNodeConfig(data);
    assert.equal(cfg.dataDir, data);
    assert.equal(cfg.socketPath, socketPath);
    const daemon = new HiveDaemon(cfg);
    active.daemon = daemon;
    await daemon.start();
    const launches = [];
    const cell = daemon.driver.cell;
    const originalResolve = cell.resolveCellSpawn.bind(cell);
    cell.resolveCellSpawn = (...args) => {
      const spec = originalResolve(...args);
      launches.push({ beeId: args[0], generation: args[1], command: spec.command, args: spec.args, cwd: spec.cwd });
      writeFileSync(join(lane, "launches.json"), JSON.stringify(launches, null, 2), { mode: 0o600 });
      return spec;
    };
    const client = await RpcClient.connect(socketPath);
    active.client = client;
    const spawned = await client.request("spawn", { name: `queen-${harness}`, agent: harness, substrate: "cell", cell: { originRepo: origin, sha: base, sandbox: true }, prompt: `Execute the one deterministic provider-requested Bash/shell command in this fixture; do not use network or other tools.\n${TOOL_COMMAND}` });
    const view = await wait(async () => {
      const value = await client.request("view", { beeId: spawned.beeId });
      if (value.bee?.runtimeState === "stopped") throw new Error("Harness stopped before completing tool receipt");
      return mock.state.turn === 2 && value.bee ? value : false;
    }, "tool result and model completion", mock);
    const bee = daemon.store.getBee(spawned.beeId);
    assert.ok(bee.cwd.startsWith(cfg.cellsRoot + "/"));
    const cellGit = args => execFileSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: bee.cwd, env: gitEnv, encoding: "utf8", timeout: 10000 }).trim();
    const commit = cellGit(["rev-parse", "HEAD"]);
    assert.notEqual(commit, base);
    assert.equal(cellGit(["status", "--porcelain"]), "");
    assert.equal(cellGit(["log", "-1", "--format=%an <%ae>"]), "QueenFixture <queen@example.invalid>");
    assert.equal(readFileSync(join(bee.cwd, "queen-local-fixture.txt"), "utf8"), "queen-local-fixture\n");
    assert.ok(mock.state.output.includes(commit));
    assert.ok(mock.state.output.includes(execFileSync(paths.node.resolved, ["--version"], { env: gitEnv, encoding: "utf8" }).trim()));
    assert.ok(launches.some(launch => launch.args.includes("bwrap")), "Must record actual wrapped bwrap argv");
    await wait(() => readFileSync(bee.sessionLogPath, "utf8").includes("QUEEN_REAL_HARNESS_OK"), "final harness output", mock);
    writeFileSync(join(lane, "mock-requests.json"), JSON.stringify(mock.state.requests, null, 2), { mode: 0o600 });
    results.lanes.push({ harness, version, passed: true, command: paths[harness], provider: mock.url, cwd: bee.cwd, socketPath, base, commit,
      toolOutput: mock.state.output, launches, transcript: bee.sessionLogPath, modelRequests: mock.state.turn, view: { beeId: spawned.beeId } });
    await cleanup();
  }
  results.passed = true;
} catch (error) { results.failure = String(error); process.exitCode = 1; }
finally {
  try { await cleanup(); } catch (error) { results.passed = false; results.cleanupFailure = String(error); process.exitCode = 1; }
  clearInterval(ownershipTimer);
  writeFileSync(join(root, "results.json"), JSON.stringify(results, null, 2) + "\n", { mode: 0o600 });
}
