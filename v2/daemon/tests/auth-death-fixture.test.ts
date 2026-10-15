import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { waitFor } from "./helpers.ts";

const fixture = fileURLToPath(new URL("./fixtures/auth-death-claude.mjs", import.meta.url));

const birthOf = (pid: number) => {
  try { return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).trim().replace(/\s+/g, " "); } catch { return null; }
};
const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

function setup(t: { after: (fn: () => Promise<void> | void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "auth-death-fixture-"));
  const config = join(dir, "claude");
  mkdirSync(config);
  writeFileSync(join(config, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "token" } }));
  const children: ChildProcess[] = [];
  const grandchildren: { pid: number; birth: string | null }[] = [];
  const servers: Server[] = [];
  t.after(async () => {
    for (const child of children) if (running(child)) child.kill("SIGKILL");
    for (const { pid, birth } of grandchildren) if (birth !== null && birthOf(pid) === birth) process.kill(pid, "SIGKILL");
    for (const child of children) child.stdin?.destroy();
    await waitFor(() => !children.some(running) && grandchildren.every(({ pid, birth }) => birthOf(pid) !== birth), "fixture test processes exited", 10_000, 50);
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    rmSync(dir, { recursive: true, force: true });
  });
  const env = (extra: Record<string, string>) => ({ PATH: process.env.PATH ?? "", HOME: dir, CLAUDE_CONFIG_DIR: config, ...extra });
  const start = (args: string[], extra: Record<string, string>) => {
    const child = spawn(process.execPath, args, { env: env(extra), stdio: ["pipe", "pipe", "inherit"] });
    children.push(child);
    return child;
  };
  const listen = async (status: number) => {
    const server = createServer((_req, res) => { res.writeHead(status); res.end("{}"); });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/call`;
  };
  const deadUrl = async () => {
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/call`;
    await new Promise<void>(resolve => server.close(() => resolve()));
    return url;
  };
  return { dir, children, grandchildren, start, listen, deadUrl };
}

const exitedWithin = async (exited: () => boolean, ms: number) => {
  const started = Date.now();
  await waitFor(exited, "fixture exited", ms, 50);
  return Date.now() - started;
};

test("auth-death fixture exits after consecutive connection failures to a dead provider", { timeout: 30_000 }, async t => {
  const { start, deadUrl } = setup(t);
  const child = start([fixture], { AUTH_DEATH_PROVIDER_URL: await deadUrl(), AUTH_DEATH_STAY_ALIVE: "1" });
  assert.ok(await exitedWithin(() => !running(child), 10_000) < 10_000);
});

test("auth-death fixture exits when a reused port answers as a different server", { timeout: 30_000 }, async t => {
  const { start, listen } = setup(t);
  const child = start([fixture], { AUTH_DEATH_PROVIDER_URL: await listen(404), AUTH_DEATH_STAY_ALIVE: "1" });
  await exitedWithin(() => !running(child), 10_000);
});

test("auth-death fixture keeps polling a live provider and exits once its owner dies", { timeout: 30_000 }, async t => {
  const { start, listen, children } = setup(t);
  const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(owner);
  const child = start([fixture], { AUTH_DEATH_PROVIDER_URL: await listen(200), AUTH_DEATH_STAY_ALIVE: "1", AUTH_DEATH_OWNER_PID: String(owner.pid) });
  await new Promise(resolve => setTimeout(resolve, 3_000));
  assert.ok(running(child), "fixture survives while its owner and provider live");
  owner.kill("SIGKILL");
  await exitedWithin(() => !running(child), 5_000);
});

test("auth-death fixture exits when its parent dies even though its stdin stays open", { timeout: 30_000 }, async t => {
  const { start, listen, grandchildren } = setup(t);
  const parent = start(["-e", `const c = require("node:child_process").spawn(process.execPath, [${JSON.stringify(fixture)}], { stdio: ["inherit", "ignore", "inherit"] }); console.log(c.pid); setInterval(() => {}, 1000);`], { AUTH_DEATH_PROVIDER_URL: await listen(200), AUTH_DEATH_STAY_ALIVE: "1" });
  const pid = Number(await new Promise<string>(resolve => parent.stdout!.once("data", chunk => resolve(String(chunk)))));
  const birth = birthOf(pid);
  grandchildren.push({ pid, birth });
  await new Promise(resolve => setTimeout(resolve, 1_000));
  assert.ok(birth !== null && birthOf(pid) === birth);
  parent.kill("SIGKILL");
  await exitedWithin(() => birthOf(pid) !== birth, 5_000);
});

test("auth-death fixture honours the gate fixture lease", { timeout: 30_000 }, async t => {
  const { dir, start, listen } = setup(t);
  const lease = join(dir, "lease");
  mkdirSync(lease);
  const child = start([fixture], { AUTH_DEATH_PROVIDER_URL: await listen(200), AUTH_DEATH_STAY_ALIVE: "1", HIVE_TEST_FIXTURE_LEASE: `${process.pid}:${lease}` });
  await new Promise(resolve => setTimeout(resolve, 1_000));
  assert.ok(running(child));
  rmSync(lease, { recursive: true });
  await exitedWithin(() => !running(child), 5_000);
});
