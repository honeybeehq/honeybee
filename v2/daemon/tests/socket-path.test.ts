import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { readLiveEndpointRecord } from "../src/endpointRecord.ts";
import { RpcError } from "../src/protocol.ts";
import { ownedPrivateDir, placeDaemonSockets, shortSocketDir, socketPathBytes, socketPathFits, SOCKET_DIR_RECORD_FILE, UNIX_SOCKET_PATH_LIMIT } from "../src/socketPath.ts";
import { resolveDaemonTarget } from "../../cli/src/target.ts";
import { makeDaemonDir, startDaemon, type DaemonHandle } from "./helpers.ts";

function deepDir(root: string): string {
  let dir = root;
  while (socketPathBytes(join(dir, "hived.sock")) < UNIX_SOCKET_PATH_LIMIT + 40) dir = join(dir, "deep-data-dir-segment");
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("socket placement: a data dir whose sockets fit keeps them in place", () => {
  const root = mkdtempSync(join(tmpdir(), "hb-sp-"));
  try {
    const placed = placeDaemonSockets(root, join(root, "hived.sock"), { runnerSocketDir: tmpdir() });
    assert.deepEqual(placed, { socketPath: join(root, "hived.sock"), tmuxSocketPath: join(root, "tmux.sock"), runnerSocketDir: tmpdir(), socketDir: null });
    assert.equal(existsSync(join(root, SOCKET_DIR_RECORD_FILE)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("socket placement: a deep data dir moves every socket into one short dir that survives a restart", () => {
  const root = mkdtempSync(join(tmpdir(), "hb-sp-deep-"));
  try {
    const dir = deepDir(root);
    assert.equal(socketPathFits(join(dir, "hived.sock")), false);
    const placed = placeDaemonSockets(dir, join(dir, "hived.sock"), { runnerSocketDir: dir, bases: [join(root, "s")] });
    assert.ok(placed.socketDir, "a short dir was created");
    assert.equal(dirname(placed.socketPath), placed.socketDir);
    assert.equal(dirname(placed.tmuxSocketPath), placed.socketDir);
    assert.equal(placed.runnerSocketDir, placed.socketDir);
    for (const path of [placed.socketPath, placed.tmuxSocketPath, join(placed.runnerSocketDir, `hb-rh-${"0".repeat(16)}.sock`)]) {
      assert.ok(socketPathFits(path), `${path} fits`);
    }
    assert.match(placed.socketDir!, /\/[a-f0-9]{12}$/);
    assert.equal(readFileSync(join(dir, SOCKET_DIR_RECORD_FILE), "utf8").trim(), placed.socketDir);
    const again = placeDaemonSockets(dir, join(dir, "hived.sock"), { runnerSocketDir: dir, bases: [join(root, "s")] });
    assert.deepEqual(again, placed, "the recorded short dir is reused");
    rmSync(placed.socketDir!, { recursive: true, force: true });
    const replaced = placeDaemonSockets(dir, join(dir, "hived.sock"), { runnerSocketDir: dir, bases: [join(root, "s")] });
    assert.equal(replaced.socketDir, placed.socketDir, "a vanished short dir is recreated at the stable private path");
    rmSync(replaced.socketDir!, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("socket placement: a recorded dir that is world-writable or a symlink to a foreign dir is never reused", () => {
  const root = mkdtempSync(join(tmpdir(), "hb-sp-trust-"));
  try {
    const dir = deepDir(root);
    const place = () => placeDaemonSockets(dir, join(dir, "hived.sock"), { runnerSocketDir: dir, bases: [join(root, "s")] });
    const first = place();
    assert.ok(first.socketDir && ownedPrivateDir(first.socketDir), "a freshly minted dir is private and owned");

    chmodSync(first.socketDir!, 0o777);
    assert.equal(ownedPrivateDir(first.socketDir!), false);
    assert.throws(place, /socket directory is not private/);
    chmodSync(first.socketDir!, 0o700);
    const foreign = mkdtempSync(join(root, "foreign-"));
    const link = join(root, "link");
    symlinkSync(foreign, link);
    writeFileSync(join(dir, SOCKET_DIR_RECORD_FILE), `${link}\n`);
    const afterLink = place();
    assert.equal(afterLink.socketDir, first.socketDir, "untrusted recorded paths cannot change the designated private path");
    assert.ok(ownedPrivateDir(afterLink.socketDir!));

  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("socket placement: the fit check uses the real path of the base", () => {
  const root = mkdtempSync(join(tmpdir(), "hb-sp-real-"));
  const link = join(tmpdir(), `hb-sp-base-${process.pid}`);
  try {
    let real = realpathSync(root);
    const name = "x.sock";
    while (socketPathBytes(join(real, "hived-XXXXXX", name)) < UNIX_SOCKET_PATH_LIMIT) real = join(real, "pad");
    mkdirSync(real, { recursive: true });
    rmSync(link, { force: true });
    symlinkSync(real, link);
    assert.ok(socketPathFits(join(link, "hived-XXXXXX", name)), "the short link spelling would pass a lexical check");
    assert.throws(() => shortSocketDir("hived-", name, [link]), (error: unknown) => error instanceof RpcError && error.code === "socket_path_too_long");
  } finally {
    rmSync(link, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("socket placement: the refusal names the path when no base can hold a short socket", () => {
  const root = mkdtempSync(join(tmpdir(), "hb-sp-refuse-"));
  try {
    const dir = deepDir(root);
    assert.throws(
      () => placeDaemonSockets(dir, join(dir, "hived.sock"), { runnerSocketDir: dir, bases: [dir] }),
      (error: unknown) => error instanceof RpcError && error.code === "socket_path_too_long"
        && error.message.includes(dir) && error.message.includes(String(UNIX_SOCKET_PATH_LIMIT)),
    );
    assert.throws(
      () => placeDaemonSockets(dir, join(dir, "explicit.sock"), { runnerSocketDir: tmpdir() }),
      (error: unknown) => error instanceof RpcError && error.code === "socket_path_too_long"
        && error.message.includes(join(dir, "explicit.sock")) && error.details?.socketPath === join(dir, "explicit.sock"),
    );
    assert.throws(() => shortSocketDir("hb-sp-", "x.sock", [dir]), (error: unknown) => error instanceof RpcError && error.code === "socket_path_too_long");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a daemon on a deep data dir listens on a short socket that clients find through the endpoint record", async () => {
  const d = makeDaemonDir();
  const dir = deepDir(d.dir);
  writeFileSync(join(dir, "config.json"), readFileSync(join(d.dir, "config.json")));
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir, { env: { HOME: join(d.dir, "h") } });
    const record = readLiveEndpointRecord(dir);
    assert.ok(record, "endpoint record");
    assert.ok(socketPathFits(record.socketPath), `${record.socketPath} fits`);
    assert.ok(socketPathFits(record.tmuxSocketPath!), `${record.tmuxSocketPath} fits`);
    assert.equal(dirname(record.socketPath), dirname(record.tmuxSocketPath!));
    assert.notEqual(dirname(record.socketPath), dir);
    assert.equal(daemon.socketPath, record.socketPath);
    const target = resolveDaemonTarget({ dataDirFlag: dir }, { HOME: join(d.dir, "home") });
    assert.equal(target.socketSource, "record");
    assert.equal(target.cfg.socketPath, record.socketPath);
    const client = await daemon.client();
    const info = await client.request<{ socketPath: string; dataDir: string }>("deployInfo");
    client.close();
    assert.equal(info.socketPath, record.socketPath);
    assert.equal(info.dataDir, dir);
    assert.match(daemon.output(), /listening on .*\.hive\/s\/[a-f0-9]{12}\/hived\.sock/);
  } finally {
    const socketDir = daemon ? dirname(daemon.socketPath) : null;
    await daemon?.stop();
    if (socketDir && socketDir !== dir) rmSync(socketDir, { recursive: true, force: true });
    d.cleanup();
  }
});

test("a daemon refuses an explicit socket path past the platform limit and names it", async () => {
  const d = makeDaemonDir();
  const dir = deepDir(d.dir);
  const explicit = join(dir, "explicit.sock");
  await assert.rejects(startDaemon(d.dir, { socketPath: explicit }), (error: unknown) =>
    error instanceof Error && /daemon exited early/.test(error.message) && error.message.includes("socket_path_too_long") && error.message.includes(explicit));
  assert.equal(readLiveEndpointRecord(d.dir), null);
  d.cleanup();
});
