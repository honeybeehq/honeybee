import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedGatewayMcp } from "../src/accounts/gatewayMcpSeed.ts";

test("reconnect effect shares the native seed lock and preserves unrelated config and existing nonce", async t => {
  const home = await mkdtemp(join(tmpdir(), "hb-reconnect-seed-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const config = join(home, "config.toml");
  const userConfig = '[mcp_servers.personal]\ncommand = "personal-command"\n[mcp_servers.personal.env]\nCUSTOM = "unchanged"\n';
  await writeFile(config, `${userConfig}\n[mcp_servers.apiary]\ncommand = "old"\nrequired = true\nstartup_timeout_sec = 60\n`);
  const gateways = [{ name: "apiary", shim: { command: "/current/node", args: ["/current/apiary.mjs"] }, env: {} }];
  const order: string[] = [];
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const first = seedGatewayMcp(home, "codex", { gateways, failOnError: true, afterSeed: async targets => {
    assert.deepEqual(targets, ["apiary"]);
    assert.match(await readFile(config, "utf8"), /\/current\/apiary.mjs/);
    assert.ok((await readFile(join(home, ".hive-gateways.lock"), "utf8")).length > 0);
    order.push("first"); entered(); await barrier;
    // Native config/value/write adds this table. The normal spawn seeder must retain it.
    await writeFile(config, `${await readFile(config, "utf8")}\n[mcp_servers.apiary.env]\nHONEYBEE_MCP_RECONNECT_NONCE = "command-1"\n`);
    order.push("released");
  } });
  await ready;
  const second = seedGatewayMcp(home, "codex", { gateways, failOnError: true, afterSeed: async () => { order.push("second"); } });
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first", "released", "second"]);
  const result = await readFile(config, "utf8");
  assert.ok(result.startsWith(userConfig));
  assert.match(result, /required = true/);
  assert.match(result, /startup_timeout_sec = 60/);
  assert.match(result, /HONEYBEE_MCP_RECONNECT_NONCE = "command-1"/);
  await assert.rejects(seedGatewayMcp(home, "codex", { gateways, failOnError: true, afterSeed: async () => { throw new Error("native reload refused"); } }), /native reload refused/);
  assert.equal((await seedGatewayMcp(home, "codex", { gateways })).status, "seeded", "failure releases the lock");
});

test("retiring a managed gateway removes its owned nonce table but preserves user nested settings", async t => {
  const home = await mkdtemp(join(tmpdir(), "hb-reconnect-retire-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const config = join(home, "config.toml");
  const gateways = [{ name: "apiary", shim: { command: "/node", args: [] }, env: {} }];
  await seedGatewayMcp(home, "codex", { gateways });
  await writeFile(config, `${await readFile(config, "utf8")}\n[mcp_servers.apiary.env]\nHONEYBEE_MCP_RECONNECT_NONCE = "one"\n`);
  await seedGatewayMcp(home, "codex", { gateways: [] });
  assert.doesNotMatch(await readFile(config, "utf8"), /mcp_servers\.apiary/);
  await seedGatewayMcp(home, "codex", { gateways });
  await writeFile(config, `${await readFile(config, "utf8")}\n[mcp_servers.apiary.env]\nCUSTOM = "keep"\nHONEYBEE_MCP_RECONNECT_NONCE = "two"\n`);
  await seedGatewayMcp(home, "codex", { gateways: [] });
  const text = await readFile(config, "utf8");
  assert.match(text, /command = "\/node"/);
  assert.match(text, /CUSTOM = "keep"/);
});

test("account seeding waits beyond the generic lock timeout for an in-flight reconnect", { timeout: 60_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), "hb-reconnect-lock-wait-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const gateways = [{ name: "apiary", shim: { command: "/node", args: [] }, env: {} }];
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const reconnect = seedGatewayMcp(home, "codex", { gateways, failOnError: true, afterSeed: async () => {
    entered();
    await new Promise<void>(resolve => setTimeout(resolve, 11_000));
  } });
  await ready;
  const activation = seedGatewayMcp(home, "codex", { gateways, failOnError: true });
  const results = await Promise.all([reconnect, activation]);
  assert.ok(results.every(result => result.status === "seeded"));
});
