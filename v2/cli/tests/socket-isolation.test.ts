import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalPath, ENDPOINT_RECORD_FILE, readLiveEndpointRecord, writeEndpointRecord } from "../../daemon/src/endpointRecord.ts";
import { RpcServer, socketAcceptsConnections } from "../../daemon/src/rpc.ts";
import { DAEMON_BIN, makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "../../daemon/tests/helpers.ts";
import { RpcError } from "../../daemon/src/protocol.ts";
import { RpcClient } from "../src/client.ts";
import { runV2Cli } from "../src/main.ts";
import { resolveDaemonTarget } from "../src/target.ts";

const CLI_BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "bin.ts");
const FAKE_CLAUDE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "driver-hsr", "test-agent", "fake-claude.mjs");
const ENV_KEYS = ["HIVE_V2_DATA_DIR", "HIVE_V2_SOCKET_PATH", "HIVE_BEE", "HIVE_BEE_ID", "HIVE_PARENT", "HOME"] as const;

type Json = Record<string, any>;

async function cli(args: string[], env: Partial<Record<(typeof ENV_KEYS)[number], string>>): Promise<{ exit: number; out: string[]; err: string[]; json: Json[] }> {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  const out: string[] = [];
  const err: string[] = [];
  try {
    const exit = await runV2Cli(args, { out: (line) => out.push(line), err: (line) => err.push(line) });
    const json = out.flatMap((line) => { try { return [JSON.parse(line) as Json]; } catch { return []; } });
    return { exit, out, err, json };
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function sentinel(path: string): Promise<{ server: Server; connections: () => number }> {
  let count = 0;
  const server = createServer((socket) => { count++; socket.destroy(); });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve({ server, connections: () => count }));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(child.stdout);
}

test("target resolution: flag > env > live record > config, empty env is unset, dead-pid record is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "hb-p8-target-"));
  const saved = { data: process.env.HIVE_V2_DATA_DIR, socket: process.env.HIVE_V2_SOCKET_PATH, home: process.env.HOME };
  try {
    const dir = join(root, "data");
    mkdirSync(dir);
    process.env.HOME = join(root, "home");
    delete process.env.HIVE_V2_DATA_DIR;
    delete process.env.HIVE_V2_SOCKET_PATH;
    let t = resolveDaemonTarget({});
    assert.equal(t.dataDirSource, "default");
    assert.equal(t.cfg.dataDir, join(root, "home", ".hive", "v2"));
    assert.equal(t.socketSource, "config");
    t = resolveDaemonTarget({}, { HIVE_V2_DATA_DIR: dir, HIVE_V2_SOCKET_PATH: "  " });
    assert.equal(t.dataDirSource, "env");
    assert.equal(t.socketSource, "config");
    assert.equal(t.cfg.socketPath, join(dir, "hived.sock"));
    t = resolveDaemonTarget({ dataDirFlag: dir }, { HIVE_V2_DATA_DIR: join(root, "other"), HIVE_V2_SOCKET_PATH: join(root, "env.sock") });
    assert.equal(t.dataDirSource, "flag");
    assert.equal(t.socketSource, "config");
    assert.equal(t.cfg.socketPath, join(dir, "hived.sock"));
    t = resolveDaemonTarget({}, { HIVE_V2_DATA_DIR: dir, HIVE_V2_SOCKET_PATH: join(root, "env.sock") });
    assert.equal(t.dataDirSource, "env");
    assert.equal(t.socketSource, "env");
    assert.equal(t.cfg.socketPath, join(root, "env.sock"));
    t = resolveDaemonTarget({ dataDirFlag: dir, socketFlag: join(root, "flag.sock") }, { HIVE_V2_SOCKET_PATH: join(root, "env.sock") });
    assert.equal(t.socketSource, "flag");
    assert.equal(t.cfg.socketPath, join(root, "flag.sock"));
    writeEndpointRecord(dir, { instanceId: "live", dataDir: dir, socketPath: join(root, "recorded.sock"), pid: process.pid, startedAt: 1 });
    t = resolveDaemonTarget({ dataDirFlag: dir }, {});
    assert.equal(t.socketSource, "record");
    assert.equal(t.cfg.socketPath, join(root, "recorded.sock"));
    assert.equal(t.expectedSocketPath, join(root, "recorded.sock"));
    writeEndpointRecord(dir, { instanceId: "dead", dataDir: dir, socketPath: join(root, "recorded.sock"), pid: deadPid(), startedAt: 1 });
    assert.equal(readLiveEndpointRecord(dir), null);
    t = resolveDaemonTarget({ dataDirFlag: dir }, {});
    assert.equal(t.socketSource, "config");
    assert.equal(t.expectedSocketPath, join(dir, "hived.sock"));
    writeFileSync(join(dir, ENDPOINT_RECORD_FILE), "{not json");
    assert.equal(resolveDaemonTarget({ dataDirFlag: dir }, {}).socketSource, "config");
  } finally {
    for (const [key, value] of [["HIVE_V2_DATA_DIR", saved.data], ["HIVE_V2_SOCKET_PATH", saved.socket], ["HOME", saved.home]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("socket_in_use probe is a bare connect: no bytes reach the listener", async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-p8-probe-"));
  const path = join(root, "live.sock");
  let received = "";
  const server = createServer((socket) => { socket.setEncoding("utf8"); socket.on("data", (chunk: string) => { received += chunk; }); });
  try {
    await new Promise<void>((resolve) => server.listen(path, resolve));
    assert.equal(await socketAcceptsConnections(path), true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(received, "");
    await closeServer(server);
    assert.equal(await socketAcceptsConnections(join(root, "absent.sock")), false);
  } finally {
    if (server.listening) await closeServer(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test("the endpoint record is written after the socket_in_use probe and before the socket accepts", async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-p8f-bind-"));
  const path = join(root, "rpc.sock");
  const server = new RpcServer({ socketPath: path, log: () => undefined, dispatch: () => ({ ok: true }) });
  const second = new RpcServer({ socketPath: path, log: () => undefined, dispatch: () => ({ ok: true }) });
  try {
    const failing = new RpcServer({ socketPath: path, log: () => undefined, dispatch: () => ({ ok: true }) });
    await assert.rejects(failing.listen(() => { throw new Error("record unwritable"); }), /record unwritable/);
    assert.equal(existsSync(path), false);
    let socketExistedAtHook: boolean | null = null;
    await server.listen(() => { socketExistedAtHook = existsSync(path); });
    assert.equal(socketExistedAtHook, false);
    assert.equal(await socketAcceptsConnections(path), true);
    let secondHookRan = false;
    await assert.rejects(second.listen(() => { secondHookRan = true; }), (err: unknown) => err instanceof RpcError && err.code === "socket_in_use");
    assert.equal(secondHookRan, false);
  } finally {
    await server.close();
    await second.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a daemon that cannot write its endpoint record fails before it listens", async () => {
  const d = makeDaemonDir();
  try {
    mkdirSync(join(d.dir, ENDPOINT_RECORD_FILE, "occupied"), { recursive: true });
    const home = mkdtempSync(join(d.dir, "home-"));
    const proc = spawn(process.execPath, [DAEMON_BIN, "--data-dir", d.dir], {
      env: { ...process.env, HOME: home, HIVE_V2_DATA_DIR: d.dir, HIVE_NO_KEYCHAIN: "1", HIVE_GATEWAYS_DISABLE: "1", HIVE_TEST_REAP_RUNTIMES_ON_SHUTDOWN: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    proc.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    proc.stderr.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    const exited = new Promise<number | null>((resolve) => proc.once("exit", (exitCode) => resolve(exitCode)));
    const code = await Promise.race([exited, new Promise<"running">((resolve) => setTimeout(() => resolve("running"), 30_000).unref())]);
    if (code === "running") {
      proc.kill("SIGKILL");
      await exited;
    }
    assert.notEqual(code, "running", `daemon kept running after its endpoint record failed: ${output}`);
    assert.notEqual(code, 0, output);
    assert.doesNotMatch(output, /listening on/);
    assert.equal(existsSync(join(d.dir, "hived.sock")), false);
    assert.equal(readLiveEndpointRecord(d.dir), null);
  } finally {
    d.cleanup();
  }
});

test("socket isolation against throwaway daemons", async (t) => {
  const claudeAgent = (argvLog: string) => ({
    claude: {
      command: process.execPath,
      args: [FAKE_CLAUDE, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
      adapter: "claude",
      env: { FAKE_CLAUDE_ARGV_LOG: argvLog },
    },
  });
  const c = makeDaemonDir();
  const argvLogA = join(c.dir, "argv-a.jsonl");
  const argvLogB = join(c.dir, "argv-b.jsonl");
  const a = makeDaemonDir({ agents: claudeAgent(argvLogA) });
  const b = makeDaemonDir({ agents: claudeAgent(argvLogB) });
  const aSock = join(c.dir, "a-custom.sock");
  const home = join(c.dir, "home");
  mkdirSync(home, { recursive: true });
  const scratch = join(c.dir, "work");
  mkdirSync(scratch, { recursive: true });
  let daemonA: DaemonHandle | null = null;
  let daemonB: DaemonHandle | null = null;
  try {
    daemonA = await startDaemon(a.dir, { socketPath: aSock });
    daemonB = await startDaemon(b.dir, { env: { HIVE_V2_SOCKET_PATH: join(c.dir, "inherited.sock") } });
    const infoA = (await cli(["deploy-info", "--json", "--socket", aSock, "--data-dir", a.dir], { HOME: home })).json[0]!;
    const infoB = (await cli(["deploy-info", "--json", "--data-dir", b.dir], { HOME: home })).json[0]!;
    assert.match(infoA.instanceId, /^[0-9a-f-]{36}$/);
    assert.notEqual(infoA.instanceId, infoB.instanceId);

    await t.test("the endpoint record carries the instance, the socket and the daemon pid", () => {
      const record = readLiveEndpointRecord(a.dir);
      assert.equal(record?.instanceId, infoA.instanceId);
      assert.equal(record?.socketPath, aSock);
      assert.equal(record?.pid, infoA.pid);
      assert.equal(record?.dataDir, canonicalPath(a.dir));
    });

    await t.test("HIVE_V2_SOCKET_PATH is honoured and --json names the daemon it reached", async () => {
      const r = await cli(["ls", "--json"], { HOME: home, HIVE_V2_SOCKET_PATH: aSock });
      assert.equal(r.exit, 0, r.err.join("\n"));
      assert.deepEqual(r.json[0]!.daemonTarget, {
        dataDir: join(home, ".hive", "v2"), dataDirSource: "default", socketPath: aSock, socketSource: "env",
        instanceId: infoA.instanceId, daemonDataDir: canonicalPath(a.dir), connected: true,
      });
    });

    await t.test("--socket overrides HIVE_V2_SOCKET_PATH", async () => {
      const r = await cli(["deploy-info", "--json", "--socket", aSock], { HOME: home, HIVE_V2_SOCKET_PATH: daemonB!.socketPath });
      assert.equal(r.exit, 0, r.err.join("\n"));
      assert.equal(r.json[0]!.instanceId, infoA.instanceId);
      assert.equal(r.json[0]!.daemonTarget.socketSource, "flag");
    });

    await t.test("--data-dir alone follows the live endpoint record to a --socket daemon", async () => {
      const r = await cli(["deploy-info", "--json", "--data-dir", a.dir], { HOME: home });
      assert.equal(r.exit, 0, r.err.join("\n"));
      assert.equal(r.json[0]!.instanceId, infoA.instanceId);
      assert.equal(r.json[0]!.daemonTarget.socketSource, "record");
    });

    await t.test("socket_mismatch before connecting: a configured socket that is not the data dir's", async () => {
      for (const [args, env] of [
        [["ls", "--json", "--data-dir", a.dir, "--socket", daemonB!.socketPath], { HOME: home }],
        [["ls", "--json"], { HOME: home, HIVE_V2_DATA_DIR: a.dir, HIVE_V2_SOCKET_PATH: daemonB!.socketPath }],
        [["ls", "--json", "--socket", daemonB!.socketPath], { HOME: home, HIVE_V2_DATA_DIR: a.dir }],
      ] as const) {
        const r = await cli([...args], env);
        assert.equal(r.exit, 1);
        assert.equal(r.json.length, 1, r.out.join("\n"));
        assert.equal(r.json[0]!.error.code, "socket_mismatch");
        assert.equal(r.json[0]!.error.details.expectedSocketPath, aSock);
        assert.equal(r.json[0]!.daemonTarget.connected, false);
        assert.equal(r.json[0]!.daemonTarget.instanceId, null);
      }
    });

    await t.test("an explicit --data-dir outranks an inherited env socket: a harness inside a bee reaches its throwaway daemon", async () => {
      const r = await cli(["deploy-info", "--json", "--data-dir", a.dir], { HOME: home, HIVE_V2_DATA_DIR: b.dir, HIVE_V2_SOCKET_PATH: daemonB!.socketPath });
      assert.equal(r.exit, 0, r.out.join("\n"));
      assert.equal(r.json[0]!.instanceId, infoA.instanceId);
      assert.equal(r.json[0]!.daemonTarget.socketSource, "record");
      assert.equal(r.json[0]!.daemonTarget.dataDirSource, "flag");
      const spawned = await cli(["spawn", "bee-harness", "--agent", "claude", "--cwd", scratch, "--data-dir", a.dir, "--json"], { HOME: home, HIVE_V2_DATA_DIR: b.dir, HIVE_V2_SOCKET_PATH: daemonB!.socketPath });
      assert.equal(spawned.exit, 0, spawned.out.join("\n"));
      assert.equal(spawned.json[0]!.daemonTarget.instanceId, infoA.instanceId);
    });

    await t.test("a harness passing nothing reaches its own bee's daemon through the env socket", async () => {
      const r = await cli(["deploy-info", "--json"], { HOME: home, HIVE_V2_DATA_DIR: a.dir, HIVE_V2_SOCKET_PATH: aSock });
      assert.equal(r.exit, 0, r.out.join("\n"));
      assert.equal(r.json[0]!.instanceId, infoA.instanceId);
      assert.equal(r.json[0]!.daemonTarget.socketSource, "env");
      assert.equal(r.json[0]!.daemonTarget.dataDirSource, "env");
    });

    await t.test("socket_mismatch after hello: the daemon behind the socket serves another data dir", async () => {
      const other = join(c.dir, "other-data");
      mkdirSync(other, { recursive: true });
      writeFileSync(join(other, "config.json"), JSON.stringify({ socketPath: daemonB!.socketPath }));
      const r = await cli(["ls", "--json", "--data-dir", other, "--socket", daemonB!.socketPath], { HOME: home });
      assert.equal(r.exit, 1);
      assert.equal(r.json[0]!.error.code, "socket_mismatch");
      assert.equal(r.json[0]!.error.details.daemonDataDir, canonicalPath(b.dir));
      assert.equal(r.json[0]!.error.details.instanceId, infoB.instanceId);
      assert.equal(r.json[0]!.daemonTarget.connected, false);
    });

    await t.test("an unreachable configured socket fails loud and never falls back to the default socket or a stale store", async () => {
      const defaultDir = join(home, ".hive", "v2");
      mkdirSync(defaultDir, { recursive: true });
      const watch = await sentinel(join(defaultDir, "hived.sock"));
      try {
        const missing = join(c.dir, "missing.sock");
        for (const [args, env] of [
          [["ls", "--json"], { HOME: home, HIVE_V2_SOCKET_PATH: missing }],
          [["ls", "--json", "--socket", missing], { HOME: home }],
          [["spawn", "x", "--agent", "stub", "--cwd", scratch, "--json"], { HOME: home, HIVE_V2_SOCKET_PATH: missing }],
        ] as const) {
          const r = await cli([...args], env);
          assert.equal(r.exit, 1);
          assert.equal(r.json.length, 1, r.out.join("\n"));
          assert.equal(r.json[0]!.error.code, "socket_unreachable");
          assert.equal(r.json[0]!.error.details.socketPath, missing);
          assert.equal(r.json[0]!.stale, undefined);
          assert.ok(!r.err.some((line) => /stale/i.test(line)), r.err.join("\n"));
        }
        assert.equal(watch.connections(), 0);
        const viaDefault = await cli(["ls", "--json"], { HOME: home });
        assert.equal(viaDefault.exit, 1);
        assert.equal(watch.connections(), 1);
      } finally {
        await closeServer(watch.server);
      }
    });

    await t.test("every --json error is one JSON line on stdout", async () => {
      const r = await cli(["view", "no-such-bee", "--json", "--data-dir", b.dir], { HOME: home });
      assert.equal(r.exit, 1);
      assert.equal(r.out.length, 1);
      assert.equal(r.json[0]!.error.code, "bee_not_found");
      assert.equal(r.json[0]!.daemonTarget.instanceId, infoB.instanceId);
      assert.equal(r.json[0]!.daemonTarget.connected, true);
      const parse = await cli(["view", "--json", "--bogus-flag"], { HOME: home });
      assert.equal(parse.exit, 1);
      assert.equal(parse.json.length, 1);
      assert.equal(parse.json[0]!.error.code, "cli_error");
    });

    await t.test("an honest harness that resolved the throwaway data dir is never foreign, with or without HIVE_V2_DATA_DIR and through a symlinked spelling", async () => {
      const link = join(c.dir, "b-link");
      symlinkSync(b.dir, link);
      const unset = await cli(["spawn", "honest-unset", "--agent", "claude", "--cwd", scratch, "--data-dir", b.dir, "--json"], { HOME: home });
      assert.equal(unset.exit, 0, unset.out.join("\n"));
      const linked = await cli(["spawn", "honest-link", "--agent", "claude", "--cwd", scratch, "--data-dir", link, "--json"], { HOME: home, HIVE_V2_DATA_DIR: `${link}/` });
      assert.equal(linked.exit, 0, linked.out.join("\n"));
      assert.equal(linked.json[0]!.daemonTarget.instanceId, infoB.instanceId);
      const envOnly = await cli(["spawn", "honest-env", "--agent", "claude", "--cwd", scratch, "--json"], { HOME: home, HIVE_V2_DATA_DIR: link });
      assert.equal(envOnly.exit, 0, envOnly.out.join("\n"));
    });

    await t.test("reaching a daemon that is not the one recorded for the resolved data dir is foreign", async () => {
      const r = await cli(["spawn", "unrecorded", "--agent", "claude", "--cwd", scratch, "--json"], { HOME: home, HIVE_V2_SOCKET_PATH: daemonB!.socketPath });
      assert.equal(r.exit, 1);
      assert.equal(r.json[0]!.error.code, "foreign_daemon_spawn");
      assert.equal(r.json[0]!.error.details.reason, "instance_mismatch");
      assert.equal(r.json[0]!.error.details.expectedInstanceId, null);
      assert.equal(r.json[0]!.error.details.daemonInstanceId, infoB.instanceId);
      const stub = await cli(["spawn", "unrecorded-stub", "--agent", "stub", "--cwd", scratch, "--json"], { HOME: home, HIVE_V2_SOCKET_PATH: daemonB!.socketPath });
      assert.equal(stub.exit, 0, stub.out.join("\n"));
    });

    await t.test("a deleted endpoint record turns every provider spawn on the live daemon into foreign_daemon_spawn", async () => {
      const record = readLiveEndpointRecord(b.dir)!;
      rmSync(join(b.dir, ENDPOINT_RECORD_FILE));
      try {
        const r = await cli(["spawn", "record-gone", "--agent", "claude", "--cwd", scratch, "--data-dir", b.dir, "--json"], { HOME: home, HIVE_V2_DATA_DIR: b.dir });
        assert.equal(r.exit, 1);
        assert.equal(r.json[0]!.error.code, "foreign_daemon_spawn");
        assert.equal(r.json[0]!.error.details.reason, "instance_mismatch");
        assert.equal(r.json[0]!.error.details.expectedInstanceId, null);
        assert.match(r.json[0]!.error.message, /no live endpoint record \(hived\.endpoint\.json\).*every provider-harness start is refused/);
        const allowed = await cli(["spawn", "record-gone-allowed", "--agent", "claude", "--cwd", scratch, "--data-dir", b.dir, "--allow-foreign-daemon", "--json"], { HOME: home, HIVE_V2_DATA_DIR: b.dir });
        assert.equal(allowed.exit, 0, allowed.out.join("\n"));
      } finally {
        const { schema: _schema, ...rest } = record;
        writeEndpointRecord(b.dir, rest);
      }
    });

    await t.test("a bee spawning a provider harness into an explicit throwaway dir needs no flag", async () => {
      const intoB = await cli(["spawn", "bee-into-b", "--agent", "claude", "--cwd", scratch, "--data-dir", b.dir, "--json"], { HOME: home, HIVE_V2_DATA_DIR: a.dir, HIVE_V2_SOCKET_PATH: aSock });
      assert.equal(intoB.exit, 0, intoB.out.join("\n"));
      assert.equal(intoB.json[0]!.daemonTarget.instanceId, infoB.instanceId);
      const own = await cli(["spawn", "own-claude", "--agent", "claude", "--cwd", scratch, "--data-dir", b.dir, "--json"], { HOME: home, HIVE_V2_DATA_DIR: b.dir });
      assert.equal(own.exit, 0, own.out.join("\n"));
      const revive = await cli(["revive", "bee-into-b", "--data-dir", b.dir, "--json"], { HOME: home, HIVE_V2_DATA_DIR: a.dir, HIVE_V2_SOCKET_PATH: aSock });
      assert.notEqual(revive.json[0]?.error?.code, "foreign_daemon_spawn", revive.out.join("\n"));
    });

    await t.test("a caller whose env names one dir and whose hello names another is refused by the daemon (data_dir_mismatch)", async () => {
      const client = await RpcClient.connect(daemonB!.socketPath, 3000, undefined, { caller: { dataDir: canonicalPath(a.dir), expectedInstanceId: infoB.instanceId } });
      try {
        await assert.rejects(client.request("spawn", { name: "raw-foreign", agent: "claude", cwd: scratch }), (err: unknown) =>
          err instanceof RpcError && err.code === "foreign_daemon_spawn" && (err.details as Json).reason === "data_dir_mismatch");
        const stub = await client.request<Json>("spawn", { name: "raw-stub", agent: "stub", cwd: scratch });
        assert.ok(stub.beeId);
      } finally {
        client.close();
      }
    });

    await t.test("every daemon exports the socket it listens on to its bees, never an inherited one", async () => {
      assert.equal((await cli(["spawn", "env-a", "--agent", "claude", "--cwd", scratch, "--data-dir", a.dir, "--json"], { HOME: home, HIVE_V2_DATA_DIR: a.dir, HIVE_V2_SOCKET_PATH: aSock })).exit, 0);
      await waitFor(() => existsSync(argvLogA) && readFileSync(argvLogA, "utf8").includes('"HIVE_BEE":"env-a"'), "fake claude env-a logged", 20_000);
      const logged = readFileSync(argvLogA, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Json).find((row) => row.env.HIVE_BEE === "env-a")!;
      assert.equal(logged.env.HIVE_V2_SOCKET_PATH, aSock);
      assert.equal(logged.env.HIVE_V2_DATA_DIR, a.dir);
      await waitFor(() => existsSync(argvLogB) && readFileSync(argvLogB, "utf8").includes('"HIVE_BEE":"own-claude"'), "fake claude own-claude logged", 20_000);
      const loggedB = readFileSync(argvLogB, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Json).find((row) => row.env.HIVE_BEE === "own-claude")!;
      assert.equal(loggedB.env.HIVE_V2_SOCKET_PATH, daemonB!.socketPath);
    });

    await t.test("a second daemon refuses a live socket with socket_in_use and the first stays reachable", async () => {
      const d = makeDaemonDir();
      try {
        const proc = spawn(process.execPath, [DAEMON_BIN, "--data-dir", d.dir, "--socket", aSock], {
          env: { ...process.env, HOME: home, HIVE_V2_DATA_DIR: d.dir, HIVE_NO_KEYCHAIN: "1", HIVE_GATEWAYS_DISABLE: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        proc.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
        proc.stderr.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
        const code = await new Promise<number | null>((resolve) => proc.once("exit", (exitCode) => resolve(exitCode)));
        assert.notEqual(code, 0);
        assert.match(output, /socket_in_use|already listening/);
        const r = await cli(["deploy-info", "--json", "--socket", aSock], { HOME: home });
        assert.equal(r.json[0]!.instanceId, infoA.instanceId);
      } finally {
        d.cleanup();
      }
    });

    await t.test("hive daemon run ignores an inherited HIVE_V2_SOCKET_PATH and listens on its data dir's socket", async () => {
      const d = makeDaemonDir();
      try {
        const proc = spawn(process.execPath, [CLI_BIN, "daemon", "run", "--data-dir", d.dir], {
          env: { ...process.env, HOME: home, HIVE_V2_DATA_DIR: d.dir, HIVE_V2_SOCKET_PATH: daemonB!.socketPath, HIVE_NO_KEYCHAIN: "1", HIVE_GATEWAYS_DISABLE: "1", HIVE_TEST_REAP_RUNTIMES_ON_SHUTDOWN: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        proc.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
        proc.stderr.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
        try {
          await waitFor(() => readLiveEndpointRecord(d.dir) !== null || proc.exitCode !== null, "daemon run record", 30_000);
          assert.equal(proc.exitCode, null, output);
          assert.equal(readLiveEndpointRecord(d.dir)?.socketPath, join(d.dir, "hived.sock"));
          const b2 = await cli(["deploy-info", "--json", "--data-dir", b.dir], { HOME: home });
          assert.equal(b2.json[0]!.instanceId, infoB.instanceId);
        } finally {
          proc.kill("SIGTERM");
          await new Promise((resolve) => proc.exitCode !== null ? resolve(null) : proc.once("exit", resolve));
        }
      } finally {
        d.cleanup();
      }
    });

    await t.test("an explicit target that is the live daemon is refused from a caller whose env names another dir, unless --allow-foreign-daemon", async () => {
      const e = makeDaemonDir({ agents: claudeAgent(join(c.dir, "argv-e.jsonl")) });
      const defaultDir = join(home, ".hive", "v2");
      rmSync(defaultDir, { recursive: true, force: true });
      mkdirSync(join(home, ".hive"), { recursive: true });
      symlinkSync(e.dir, defaultDir);
      const live = await startDaemon(e.dir);
      try {
        const throwawayEnv = { HOME: home, HIVE_V2_DATA_DIR: a.dir, HIVE_V2_SOCKET_PATH: aSock };
        const refused = await cli(["spawn", "into-live", "--agent", "claude", "--cwd", scratch, "--data-dir", defaultDir, "--json"], throwawayEnv);
        assert.equal(refused.exit, 1);
        assert.equal(refused.json[0]!.error.code, "foreign_daemon_spawn");
        assert.equal(refused.json[0]!.error.details.reason, "explicit_live_target");
        assert.equal(refused.json[0]!.error.details.callerDataDir, canonicalPath(a.dir));
        const stub = await cli(["spawn", "into-live-stub", "--agent", "stub", "--cwd", scratch, "--data-dir", defaultDir, "--json"], throwawayEnv);
        assert.equal(stub.exit, 0, stub.out.join("\n"));
        const allowed = await cli(["spawn", "into-live", "--agent", "claude", "--cwd", scratch, "--data-dir", defaultDir, "--json", "--allow-foreign-daemon"], throwawayEnv);
        assert.equal(allowed.exit, 0, allowed.out.join("\n"));
        const bothFlags = ["spawn", "into-live-2", "--agent", "claude", "--cwd", scratch, "--data-dir", defaultDir, "--socket", join(defaultDir, "hived.sock"), "--json"];
        const viaSocket = await cli(bothFlags, throwawayEnv);
        assert.equal(viaSocket.json[0]!.error.code, "foreign_daemon_spawn");
        assert.equal(viaSocket.json[0]!.error.details.reason, "explicit_live_target");
        assert.equal((await cli([...bothFlags, "--allow-foreign-daemon"], throwawayEnv)).exit, 0);
        const socketOnly = await cli(["spawn", "into-live-3", "--agent", "claude", "--cwd", scratch, "--socket", join(defaultDir, "hived.sock"), "--json"], throwawayEnv);
        assert.equal(socketOnly.json[0]!.error.code, "socket_mismatch");
        const viaEnvSocket = await cli(["spawn", "into-bee-daemon", "--agent", "claude", "--cwd", scratch, "--data-dir", b.dir, "--json"], { HOME: home, HIVE_V2_DATA_DIR: a.dir, HIVE_V2_SOCKET_PATH: daemonB!.socketPath });
        assert.equal(viaEnvSocket.json[0]!.error.code, "foreign_daemon_spawn");
        assert.equal(viaEnvSocket.json[0]!.error.details.reason, "explicit_live_target");
        const ownBee = await cli(["spawn", "live-own", "--agent", "claude", "--cwd", scratch, "--data-dir", defaultDir, "--json"], { HOME: home, HIVE_V2_DATA_DIR: defaultDir });
        assert.equal(ownBee.exit, 0, ownBee.out.join("\n"));
        const operator = await cli(["spawn", "live-operator", "--agent", "claude", "--cwd", scratch, "--data-dir", defaultDir, "--json"], { HOME: home });
        assert.equal(operator.exit, 0, operator.out.join("\n"));
      } finally {
        await live.stop().catch(() => undefined);
        rmSync(defaultDir, { force: true });
        e.cleanup();
      }
    });

    await t.test("a clean shutdown removes the record; a restart mints a new instance id and rewrites it", async () => {
      await daemonB!.stop();
      assert.equal(existsSync(join(b.dir, ENDPOINT_RECORD_FILE)), false);
      daemonB = await startDaemon(b.dir);
      const r = await cli(["deploy-info", "--json", "--data-dir", b.dir], { HOME: home });
      assert.notEqual(r.json[0]!.instanceId, infoB.instanceId);
      assert.equal(r.json[0]!.daemonTarget.instanceId, r.json[0]!.instanceId);
      assert.equal(readLiveEndpointRecord(b.dir)?.instanceId, r.json[0]!.instanceId);
    });
  } finally {
    await daemonA?.stop().catch(() => undefined);
    await daemonB?.stop().catch(() => undefined);
    a.cleanup();
    b.cleanup();
    c.cleanup();
  }
});
