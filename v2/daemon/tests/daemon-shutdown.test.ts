import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { openCoreStore } from "../../core/src/index.ts";
import { inspectProcess, verifyProcessIdentity, type ProcessIdentity } from "../../driver-hsr/src/psutil.ts";
import { RpcClient } from "../../cli/src/client.ts";
import { makeDaemonDir, waitFor } from "./helpers.ts";
import type { SpawnResult, ViewResult } from "../src/protocol.ts";

const fixture = fileURLToPath(new URL("./fixtures/shutdown-daemon.mjs", import.meta.url));
type Identity = ProcessIdentity;
function identity(pid: number): Identity {
  const value = inspectProcess(pid);
  assert.equal(value.kind, "present");
  if (value.kind !== "present") throw new Error("Birth unavailable");
  return {pid, birth: value.birth, bootId: value.bootId};
}
function alive(p: Identity): boolean { return verifyProcessIdentity(p.pid, p); }

for (const mode of ["natural", "retention", "backstop"] as const) test(`daemon shutdown ${mode}: exits promptly and preserves detached bees`, { timeout: 90_000 }, async () => {
  const rig = makeDaemonDir({ cells: { retention: { enabled: mode === "retention" } } });
  const configPath = join(rig.dir, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.cells.root = join(rig.dir, "cells");
  writeFileSync(configPath, JSON.stringify(config));
  const home = join(rig.dir, "throwaway-home");
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), HIVE_GATEWAYS_DISABLE: "1", HIVE_NO_KEYCHAIN: "1", HIVE_TEST_REAP_RUNTIMES_ON_SHUTDOWN: "0" };
  for (const path of [home, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME]) mkdirSync(path, { recursive: true });
  if (mode === "retention") {
    const cwd = join(config.cells.root, "candidate", "space");
    mkdirSync(cwd, { recursive: true });
    const store = openCoreStore(join(rig.dir, "core.sqlite3"));
    store.createBee({ id: "retention-candidate", name: "retention-candidate", agent: "stub", substrate: "cell", cwd });
    store.updateRuntimeState("retention-candidate", 1, "stopped", { exitCause: "stopped_by_user" });
    store.close();
  }
  const children: ChildProcess[] = [];
  const runners: Identity[] = [];
  const helpers: Identity[] = [];
  let client: RpcClient | null = null;
  const launch = (kind: string) => {
    const child = spawn(process.execPath, [fixture, rig.dir, kind], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout!.on("data", chunk => output += chunk);
    child.stderr!.on("data", chunk => output += chunk);
    children.push(child);
    return { child, output: () => output };
  };
  const connect = () => waitFor(async () => { try { return await RpcClient.connect(join(rig.dir, "hived.sock")); } catch { return null; } }, "daemon socket", 15_000);
  try {
    const first = launch(mode);
    client = await connect();
    if (mode === "backstop") helpers.push(identity(Number(readFileSync(join(rig.dir, "slow-helper.pid"), "utf8"))));
    const bees: string[] = [];
    for (let i = 0; i < 12; i++) {
      const spawned: SpawnResult = await client.request<SpawnResult>("spawn", { name: `survivor-${i}`, agent: "stub", substrate: "hsr", cwd: rig.dir });
      bees.push(spawned.beeId);
      await waitFor(async () => (await client!.request<ViewResult>("view", { beeId: spawned.beeId })).view.runtimeState === "idle", "fake bee idle", 15_000);
      assert.equal((await client.request<ViewResult>("view", { beeId: spawned.beeId })).view.generation, 1);
    }
    for (const file of readdirSync(join(rig.dir, "runners")).filter(file => file.endsWith(".status.json"))) {
      const row = JSON.parse(readFileSync(join(rig.dir, "runners", file), "utf8"));
      runners.push(identity(row.hostPid), identity(row.agentPid));
    }
    if (mode === "retention") {
      await waitFor(() => existsSync(join(rig.dir, "worker-held")), "inspection worker held", 10_000);
    }
    client.close(); client = null;
    first.child.kill("SIGTERM");
    const stopped = await waitFor(() => readFileSync(join(rig.dir, "hived.log"), "utf8").includes('"op":"daemon.stopped"') ? Date.now() : null, "application shutdown complete", 5000);
    await waitFor(() => first.child.exitCode !== null || first.child.signalCode !== null, `foreground exit: ${first.output()}`, 2000);
    assert.equal(first.child.exitCode, 0);
    assert.ok(Date.now() - stopped < 2000);
    assert.ok(runners.every(alive), "all original host and agent PIDs survive shutdown");
    assert.ok(helpers.every(alive), "self-exit backstop sends no child signals");
    if (mode === "backstop") assert.match(first.output(), /shutdown exit backstop .*resources=/);
    else assert.doesNotMatch(first.output(), /shutdown exit backstop/);
    if (mode === "retention") {
      assert.ok(!(JSON.parse(readFileSync(join(rig.dir, "shutdown-resources.json"), "utf8")) as string[]).includes("MessagePort"));
      assert.ok(existsSync(join(config.cells.root, "candidate", "space")), "shutdown never removes the held candidate");
      assert.doesNotMatch(readFileSync(join(rig.dir, "hived.log"), "utf8"), /cell\.retention\.error/);
    }
    const successor = launch("natural");
    client = await connect();
    for (const beeId of bees) {
      await waitFor(async () => (await client!.request<ViewResult>("view", { beeId })).view.runtimeState === "idle", "successor re-adopts same runtime", 15_000);
      assert.equal((await client.request<ViewResult>("view", { beeId })).view.generation, 1);
    }
    assert.ok(runners.every(alive), "successor retains exact original processes");
    for (const beeId of bees) await client.request("stop", { beeId });
    await waitFor(() => runners.every(row => !alive(row)), "owned fixture processes stopped", 10_000);
    client.close(); client = null;
    successor.child.kill("SIGTERM");
    await waitFor(() => successor.child.exitCode !== null, "successor exits", 3000);
  } finally {
    client?.close();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    for (const row of runners) if (alive(row)) { try { process.kill(row.pid, "SIGKILL"); } catch {} }
    for (const row of helpers) if (alive(row)) { try { process.kill(row.pid, "SIGKILL"); } catch {} }
    rig.cleanup();
  }
});
