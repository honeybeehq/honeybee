import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { waitFor } from "./helpers.ts";

const fixture = fileURLToPath(new URL("./fixtures/auth-death-claude.mjs", import.meta.url));

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function setup(t: { after: (fn: () => Promise<void> | void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "auth-death-fixture-"));
  const config = join(dir, "claude");
  mkdirSync(config);
  writeFileSync(join(config, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "token" } }));
  const pids: number[] = [];
  const children: ChildProcess[] = [];
  const servers: Server[] = [];
  t.after(async () => {
    for (const pid of pids) try { process.kill(pid, "SIGKILL"); } catch {}
    for (const child of children) child.stdin?.destroy();
    await waitFor(() => pids.every(pid => !alive(pid)), "fixture test processes exited", 10_000, 50);
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    rmSync(dir, { recursive: true, force: true });
  });
  const env = (extra: Record<string, string>) => ({ PATH: process.env.PATH ?? "", HOME: dir, CLAUDE_CONFIG_DIR: config, ...extra });
  const start = (args: string[], extra: Record<string, string>) => {
    const child = spawn(process.execPath, args, { env: env(extra), stdio: ["pipe", "pipe", "inherit"] });
    children.push(child); pids.push(child.pid!);
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
  return { dir, pids, start, listen, deadUrl };
}

const exitedWithin = async (pid: number, ms: number) => {
  const started = Date.now();
  await waitFor(() => !alive(pid), `fixture ${pid} exited`, ms, 50);
  return Date.now() - started;
};

test("auth-death fixture exits after consecutive connection failures to a dead provider", { timeout: 30_000 }, async t => {
  const { start, deadUrl } = setup(t);
  const child = start([fixture], { AUTH_DEATH_PROVIDER_URL: await deadUrl(), AUTH_DEATH_STAY_ALIVE: "1" });
  assert.ok(await exitedWithin(child.pid!, 10_000) < 10_000);
});

test("auth-death fixture exits when a reused port answers as a different server", { timeout: 30_000 }, async t => {
  const { start, listen } = setup(t);
  const child = start([fixture], { AUTH_DEATH_PROVIDER_URL: await listen(404), AUTH_DEATH_STAY_ALIVE: "1" });
  await exitedWithin(child.pid!, 10_000);
});

test("auth-death fixture keeps polling a live provider and exits once its owner dies", { timeout: 30_000 }, async t => {
  const { start, listen, pids } = setup(t);
  const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  pids.push(owner.pid!);
  const child = start([fixture], { AUTH_DEATH_PROVIDER_URL: await listen(200), AUTH_DEATH_STAY_ALIVE: "1", AUTH_DEATH_OWNER_PID: String(owner.pid) });
  await new Promise(resolve => setTimeout(resolve, 3_000));
  assert.ok(alive(child.pid!), "fixture survives while its owner and provider live");
  owner.kill("SIGKILL");
  await exitedWithin(child.pid!, 5_000);
});

test("auth-death fixture exits when its parent dies even though its stdin stays open", { timeout: 30_000 }, async t => {
  const { start, listen, pids } = setup(t);
  const parent = start(["-e", `const c = require("node:child_process").spawn(process.execPath, [${JSON.stringify(fixture)}], { stdio: ["inherit", "ignore", "inherit"] }); console.log(c.pid); setInterval(() => {}, 1000);`], { AUTH_DEATH_PROVIDER_URL: await listen(200), AUTH_DEATH_STAY_ALIVE: "1" });
  const pid = Number(await new Promise<string>(resolve => parent.stdout!.once("data", chunk => resolve(String(chunk)))));
  pids.push(pid);
  await new Promise(resolve => setTimeout(resolve, 1_000));
  assert.ok(alive(pid));
  parent.kill("SIGKILL");
  await exitedWithin(pid, 5_000);
});

test("auth-death fixture honours the gate fixture lease", { timeout: 30_000 }, async t => {
  const { dir, start, listen } = setup(t);
  const lease = join(dir, "lease");
  mkdirSync(lease);
  const child = start([fixture], { AUTH_DEATH_PROVIDER_URL: await listen(200), AUTH_DEATH_STAY_ALIVE: "1", HIVE_TEST_FIXTURE_LEASE: `${process.pid}:${lease}` });
  await new Promise(resolve => setTimeout(resolve, 1_000));
  assert.ok(alive(child.pid!));
  rmSync(lease, { recursive: true });
  await exitedWithin(child.pid!, 5_000);
});
