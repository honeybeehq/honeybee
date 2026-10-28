import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mock, test } from "node:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { ConfigError } from "../src/config.ts";
import { parseDaemonRunArgs, resolveDaemonConfig, runDaemon } from "../src/main.ts";

async function fixture(fn: (root: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "hb-vault-isolation-"));
  const keys = ["HOME", "HIVE_V2_DATA_DIR", "HIVE_V2_SOCKET_PATH", "HIVE_V2_VAULT_DIR", "HIVE_V2_INSTALLED_SERVICE", "HIVE_V2_SERVICE_LABEL"] as const;
  const saved = keys.map(key => process.env[key]);
  for (const key of keys) delete process.env[key];
  process.env.HOME = root;
  const vault = join(root, ".hive", "vault");
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, "sentinel"), "untouched");
  const owner = mock.method(childProcess, "execFileSync", () => process.platform === "darwin" ? `pid = ${process.env.HIVE_V2_INSTALLED_SERVICE === "1" ? process.pid : 1}` : String(process.env.HIVE_V2_INSTALLED_SERVICE === "1" ? process.pid : 1));
  syncBuiltinESMExports();
  try { await fn(root); }
  finally {
    owner.mock.restore();
    syncBuiltinESMExports();
    assert.deepEqual(readdirSync(vault), ["sentinel"]);
    assert.equal(readFileSync(join(vault, "sentinel"), "utf8"), "untouched");
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
    rmSync(root, { recursive: true, force: true });
  }
}

const required = (error: unknown): boolean => error instanceof ConfigError && "code" in error && error.code === "vault_root_required";

for (const mode of ["foreground", "data flag", "data env", "socket flag", "socket env", "config socket"] as const) {
  test(`implicit vault refused for ${mode} before startup writes`, () => fixture(async root => {
    const args: { dataDir?: string; socketPath?: string; configPath?: string } = {};
    if (mode !== "foreground") process.env.HIVE_V2_INSTALLED_SERVICE = "1";
    if (mode === "data flag") args.dataDir = join(root, "custom");
    if (mode === "data env") process.env.HIVE_V2_DATA_DIR = join(root, "custom");
    if (mode === "socket flag") args.socketPath = join(root, "custom.sock");
    if (mode === "socket env") process.env.HIVE_V2_SOCKET_PATH = join(root, "custom.sock");
    if (mode === "config socket") {
      args.configPath = join(root, "config.json");
      writeFileSync(args.configPath, JSON.stringify({ socketPath: join(root, "custom.sock") }));
    }
    assert.throws(() => resolveDaemonConfig(args), required);
    const before = readdirSync(root, { recursive: true });
    const argv: string[] = Object.entries(args).flatMap(([key, value]) => [key === "dataDir" ? "--data-dir" : key === "socketPath" ? "--socket" : "--config", value ?? ""]);
    await assert.rejects(runDaemon(argv), required);
    assert.deepEqual(readdirSync(root, { recursive: true }), before);
  }));
}

test("installed service with default paths retains default vault", () => fixture(root => {
  process.env.HIVE_V2_INSTALLED_SERVICE = "1";
  assert.equal(resolveDaemonConfig({}).accounts.vaultDir, join(root, ".hive", "vault"));
}));

for (const source of ["flag", "env", "config"] as const) test(`explicit vault from ${source} accepted for custom daemon`, () => fixture(root => {
  const args: { dataDir: string; vaultDir?: string; configPath?: string } = { dataDir: join(root, "data") };
  const vault = join(root, "isolated-vault");
  if (source === "flag") args.vaultDir = vault;
  if (source === "env") process.env.HIVE_V2_VAULT_DIR = vault;
  if (source === "config") {
    args.configPath = join(root, "config.json");
    writeFileSync(args.configPath, JSON.stringify({ accounts: { vaultDir: vault } }));
  }
  assert.equal(resolveDaemonConfig(args).accounts.vaultDir, vault);
}));

test("vault flag overrides environment and config", () => fixture(root => {
  process.env.HIVE_V2_VAULT_DIR = join(root, "env-vault");
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({ accounts: { vaultDir: join(root, "config-vault") } }));
  const args = parseDaemonRunArgs(["--config", configPath, "--vault-dir", join(root, "flag-vault")]);
  assert.equal(resolveDaemonConfig(args).accounts.vaultDir, join(root, "flag-vault"));
}));

for (const argv of [["--vault-dir"], ["--vault-dir", ""], ["--vault-dir", "--socket"]]) test(`invalid vault flag ${JSON.stringify(argv)}`, () => {
  assert.throws(() => parseDaemonRunArgs(argv), ConfigError);
});

test("direct daemon startup refuses implicit vault before effects", () => fixture(async root => {
  const { HiveDaemon } = await import("../src/daemon.ts");
  const { loadNodeConfig } = await import("../src/config.ts");
  const daemon = new HiveDaemon(loadNodeConfig(join(root, "data")));
  const before = readdirSync(root, { recursive: true });
  await assert.rejects(daemon.start(), required);
  assert.deepEqual(readdirSync(root, { recursive: true }), before);
}));

test("an inherited service marker cannot authorize a foreground process", () => fixture(root => {
  process.env.HIVE_V2_INSTALLED_SERVICE = "1";
  const owner = mock.method(childProcess, "execFileSync", () => process.platform === "darwin" ? "pid = 1" : "1");
  syncBuiltinESMExports();
  try { assert.throws(() => resolveDaemonConfig({}), required); }
  finally { owner.mock.restore(); syncBuiltinESMExports(); }
}));

for (const source of ["flag", "env"] as const) test(`CLI refuses implicit vault with custom ${source} socket and typed JSON error`, () => fixture(async root => {
  const { runV2Cli } = await import("../../cli/src/main.ts");
  const out: string[] = [];
  const socket = join(root, "custom.sock");
  if (source === "env") process.env.HIVE_V2_SOCKET_PATH = socket;
  const argv = ["daemon", "run", "--data-dir", join(root, "data"), "--json", ...(source === "flag" ? ["--socket", socket] : [])];
  const result = await runV2Cli(argv, { out: line => out.push(line), err: () => undefined });
  assert.equal(result, 1);
  const line = out[0];
  assert.ok(line);
  assert.equal(JSON.parse(line).error.code, "vault_root_required");
}));

for (const vaultDir of ["", " \t "]) test(`empty config vault ${JSON.stringify(vaultDir)} is refused`, () => fixture(root => {
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({ accounts: { vaultDir } }));
  assert.throws(() => resolveDaemonConfig({ configPath }), (error: unknown) => error instanceof ConfigError && /vaultDir.*non-empty/.test(error.message));
}));

for (const failure of ["unavailable", "timeout"]) test(`service ownership ${failure} fails closed`, () => fixture(() => {
  const owner = mock.method(childProcess, "execFileSync", () => { throw Object.assign(new Error(failure), { code: failure === "timeout" ? "ETIMEDOUT" : "ENOENT" }); });
  syncBuiltinESMExports();
  try { assert.throws(() => resolveDaemonConfig({}), required); }
  finally { owner.mock.restore(); syncBuiltinESMExports(); }
}));

test("custom socket refuses implicit vault without a service manager query", () => fixture(root => {
  const owner = mock.method(childProcess, "execFileSync", () => { throw new Error("unexpected service manager query"); });
  syncBuiltinESMExports();
  try {
    assert.throws(() => resolveDaemonConfig({ socketPath: join(root, "custom.sock") }), required);
    assert.equal(owner.mock.callCount(), 0);
  } finally { owner.mock.restore(); syncBuiltinESMExports(); }
}));

test("explicit isolated vault never makes an inherited socket the listen target", () => fixture(root => {
  process.env.HIVE_V2_SOCKET_PATH = join(root, "inherited.sock");
  const dataDir = join(root, "data");
  assert.equal(resolveDaemonConfig({ dataDir, vaultDir: join(root, "vault") }).socketPath, join(dataDir, "hived.sock"));
}));

function explicitVaultArgs(root: string, source: "flag" | "env" | "config", vault: string) {
  if (source === "flag") return parseDaemonRunArgs(["--vault-dir", vault]);
  if (source === "env") { process.env.HIVE_V2_VAULT_DIR = vault; return {}; }
  const configPath = join(root, "explicit-vault-config.json");
  writeFileSync(configPath, JSON.stringify({ accounts: { vaultDir: vault } }));
  return { configPath };
}

const vaultShapes = ["literal", "trailing slash", "relative", "symlink", "symlink parent"] as const;
function defaultVaultAlias(root: string, shape: (typeof vaultShapes)[number]): string {
  const vault = join(root, ".hive", "vault");
  if (shape === "trailing slash") return `${vault}/`;
  if (shape === "relative") return relative(process.cwd(), vault);
  if (shape === "symlink") { const alias = join(root, "vault-alias"); symlinkSync(vault, alias); return alias; }
  if (shape === "symlink parent") { const alias = join(root, "hive-alias"); symlinkSync(join(root, ".hive"), alias); return join(alias, "vault"); }
  return vault;
}

for (const source of ["flag", "env", "config"] as const) {
  for (const shape of vaultShapes) {
    for (const mode of ["foreground", "custom data", "custom socket"] as const) {
      test(`explicit default vault ${source}/${shape}/${mode} refuses before writes`, () => fixture(async root => {
        const args = explicitVaultArgs(root, source, defaultVaultAlias(root, shape));
        if (mode !== "foreground") process.env.HIVE_V2_INSTALLED_SERVICE = "1";
        const selected = { ...args, ...(mode === "custom data" ? { dataDir: join(root, "custom-data") } : {}), ...(mode === "custom socket" ? { socketPath: join(root, "custom.sock") } : {}) };
        const before = readdirSync(root, { recursive: true });
        assert.throws(() => resolveDaemonConfig(selected), required);
        const argv = Object.entries(selected).flatMap(([key, value]) => [key === "vaultDir" ? "--vault-dir" : key === "dataDir" ? "--data-dir" : key === "socketPath" ? "--socket" : "--config", value ?? ""]);
        await assert.rejects(runDaemon(argv), required);
        assert.deepEqual(readdirSync(root, { recursive: true }), before);
      }));
    }
    test(`default service accepts explicit canonical vault ${source}/${shape}`, () => fixture(root => {
      process.env.HIVE_V2_INSTALLED_SERVICE = "1";
      const args = explicitVaultArgs(root, source, defaultVaultAlias(root, shape));
      assert.doesNotThrow(() => resolveDaemonConfig(args));
    }));
  }
  for (const shape of ["symlink parent", "dangling symlink"] as const) test(`nonexistent default vault leaf via ${source}/${shape} cannot bypass guard`, () => fixture(root => {
    const vault = join(root, ".hive", "vault");
    rmSync(vault, { recursive: true });
    const alias = join(root, "missing-alias");
    if (shape === "symlink parent") symlinkSync(join(root, ".hive"), alias);
    else symlinkSync(vault, alias);
    try {
      const args = explicitVaultArgs(root, source, shape === "symlink parent" ? join(alias, "vault") : alias);
      const before = readdirSync(root, { recursive: true });
      assert.throws(() => resolveDaemonConfig(args), required);
      assert.deepEqual(readdirSync(root, { recursive: true }), before);
    } finally {
      mkdirSync(vault);
      writeFileSync(join(vault, "sentinel"), "untouched");
    }
  }));
}

test("spoofed service label cannot authorize the default vault", () => fixture(root => {
  process.env.HIVE_V2_SERVICE_LABEL = "dev.honeybee.spoof";
  const calls: string[][] = [];
  const owner = mock.method(childProcess, "execFileSync", (_file: string, args: readonly string[]) => {
    calls.push([...args]);
    const spoof = args.some(arg => arg.includes("dev.honeybee.spoof"));
    return process.platform === "darwin" ? `pid = ${spoof ? process.pid : 1}` : String(spoof ? process.pid : 1);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => resolveDaemonConfig({ vaultDir: join(root, ".hive", "vault") }), required);
    assert.equal(calls.length, 1);
    assert.ok(calls[0]?.some(arg => arg.includes("dev.honeybee.hive.v2")));
  } finally { owner.mock.restore(); syncBuiltinESMExports(); }
}));

test("custom service with an isolated explicit vault needs no default-service authority", () => fixture(root => {
  process.env.HIVE_V2_SERVICE_LABEL = "dev.honeybee.custom";
  const owner = mock.method(childProcess, "execFileSync", () => { throw new Error("unexpected service manager query"); });
  syncBuiltinESMExports();
  try {
    assert.doesNotThrow(() => resolveDaemonConfig({ dataDir: join(root, "custom-data"), vaultDir: join(root, "isolated-vault") }));
    assert.equal(owner.mock.callCount(), 0);
  } finally { owner.mock.restore(); syncBuiltinESMExports(); }
}));
