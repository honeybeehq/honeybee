// M-H7 scratch-daemon driver (proof evidence, not a test). Run from the repo root:
//   HB_M_H7_LOG=.proof/m-h7/recorded-run.md node scripts/with-fixture-warden.mjs node --experimental-strip-types .proof/m-h7/m-h7-driver.ts
// Every daemon has its own data dir, socket, store root and HOME under the fixture base; nothing touches ~/.hive, ~/.claude or ~/.codex.
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { RpcClient } from "../../v2/cli/src/client.ts";
import { runV2Cli } from "../../v2/cli/src/main.ts";
import { RpcError, type AccountImportResult, type AuditTailResult, type DeployInfoResult, type GatewayRegisterResult, type SkillsInstallResult, type SpawnResult, type ViewResult } from "../../v2/daemon/src/protocol.ts";
import { localTrustMessage, type LocalTrustChallenge } from "../../v2/daemon/src/localRpcTrust.ts";
import { readSkillTreeFromDirectory, readSkillsManifest } from "../../v2/daemon/src/skills.ts";
import { makeDaemonDir, startDaemon, forceStopTestDaemon, waitFor, type DaemonHandle } from "../../v2/daemon/tests/helpers.ts";

for (const key of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME", "KIMI_CODE_HOME", "OPENCODE_CONFIG_DIR", "CURSOR_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "HIVE_V2_DATA_DIR", "HIVE_V2_SOCKET_PATH", "HIVE_STORE_ROOT"]) delete process.env[key];
const log = process.env.HB_M_H7_LOG;
const note = (line: string) => { console.log(line); if (log) appendFileSync(log, `${line}\n`); };
const show = (label: string, value: unknown) => note(`\n## ${label}\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``);
const code = async (p: Promise<unknown>): Promise<string> => { try { await p; return "ok"; } catch (e) { return e instanceof RpcError ? `${e.code}${e.details?.reason !== undefined ? ` (${String(e.details.reason)}${e.details?.index !== undefined ? ` #${String(e.details.index)}` : ""})` : ""}` : String(e); } };
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const fakeJwt = (expSeconds: number): string => { const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url"); return `${b64({ alg: "none", typ: "JWT" })}.${b64({ exp: expSeconds, sub: "fixture" })}.FIXTURESIG`; };
const exp = Math.floor(Date.now() / 1000) + 8 * 24 * 3600;
const trustOn = (dir: string) => { const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")); cfg.rpcLocalTrust = { requireObservationCaller: true, registrationKeyFile: join(dir, "rpc-private", "registration.key") }; writeFileSync(join(dir, "config.json"), JSON.stringify(cfg)); };
const register = async (client: RpcClient, dir: string, nodeId: string) => {
  const challenge = await client.request<LocalTrustChallenge>("rpc.localTrust.challenge");
  const key = readFileSync(join(dir, "rpc-private", "registration.key"));
  const token = createHmac("sha256", key).update(localTrustMessage(challenge)).digest("hex"); key.fill(0);
  await client.request("rpc.localTrust.register", { pid: challenge.pid, challengeId: challenge.challengeId, token, nodeId });
};
const seedCodex = (dir: string, id: string) => { const vault = join(dir, "vault", "codex", id); mkdirSync(vault, { recursive: true }); writeFileSync(join(vault, "auth.json"), JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: "id-fixture", access_token: fakeJwt(exp), refresh_token: `FIXTURE-REFRESH-${id}`, account_id: "acct" } })); };
const seedClaude = (dir: string, id: string) => { const vault = join(dir, "vault", "claude", id); mkdirSync(vault, { recursive: true }); writeFileSync(join(vault, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: `sk-ant-oat01-FIXTURE-${id}`, refreshToken: `sk-ant-ort01-FIXTURE-${id}`, expiresAt: Date.now() + 36_000_000, scopes: ["user:inference"] } })); };
const spawnOn = async (client: RpcClient, name: string, agent: string, account: string, cwd: string) => {
  const spawned = await client.request<SpawnResult>("spawn", { name, agent, cwd, account, tags: ["autoswap=false"] });
  await waitFor(async () => ["running", "idle"].includes((await client.request<ViewResult>("view", { beeId: spawned.beeId })).view.runtimeState ?? "") ? true : null, `${name} running`, 60_000);
  return spawned.beeId;
};
const auditCount = async (client: RpcClient, kind: string) => (await client.request<AuditTailResult>("audit.tail", { limit: 2000 })).rows.filter(r => r.kind === kind).length;
const writeTree = (dir: string, files: Record<string, string | { text: string; executable: true }>) => { for (const [path, value] of Object.entries(files)) { mkdirSync(join(dir, path, ".."), { recursive: true }); const text = typeof value === "string" ? value : value.text; writeFileSync(join(dir, path), text); if (typeof value !== "string") chmodSync(join(dir, path), 0o755); } };
const listHomeSkills = (home: string): Record<string, string> => { const out: Record<string, string> = {}; const walk = (rel: string) => { for (const entry of readdirSync(join(home, "skills", rel), { withFileTypes: true })) { const p = rel ? `${rel}/${entry.name}` : entry.name; if (entry.isDirectory()) walk(p); else out[p] = sha(join(home, "skills", p)).slice(0, 12); } }; if (existsSync(join(home, "skills"))) walk(""); return out; };
const fakeClaude = join(process.cwd(), "v2/driver-hsr/test-agent/fake-claude.mjs"), fakeCodex = join(process.cwd(), "v2/driver-hsr/test-agent/fake-codex.mjs");
const agents = { claude: { command: process.execPath, args: [fakeClaude], adapter: "claude" }, codex: { command: process.execPath, args: [fakeCodex], adapter: "codex" } };
const p50 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!.toFixed(2);

if (log) writeFileSync(log, `# M-H7 recorded run ${new Date().toISOString()}\nscratch daemons under the fixture base, each with its own data dir, socket, store root and HOME; fake claude/codex harnesses\n`);
const dirs: Array<{ dir: string; cleanup: () => void }> = [], handles: DaemonHandle[] = [], clients: RpcClient[] = [];
const cleanup = async () => { clients.forEach(c => c.close()); await Promise.allSettled(handles.map(forceStopTestDaemon)); dirs.forEach(d => d.cleanup()); };

try {
  // ───────────────────────────── A. gateway.register ─────────────────────────────
  note("\n# A. gateway.register: Honeybee stores the endpoint and writes gateways/apiary.json itself; spawned bees are seeded with the URL");
  const da = makeDaemonDir({ agents }); dirs.push(da); trustOn(da.dir);
  const storeRoot = join(da.dir, "store-root"); mkdirSync(join(storeRoot, "gateways"), { recursive: true });
  const envA = { HIVE_STORE_ROOT: storeRoot, HIVE_GATEWAYS_DISABLE: "0" };
  let a = await startDaemon(da.dir, { env: envA, stopTimeoutMs: 30_000 }); handles.push(a);
  let A = await a.client(); clients.push(A);
  const info = await A.request<DeployInfoResult>("deployInfo");
  show("A1 deployInfo: the two capability tags, no gateway, no skill tree", { capabilities: info.capabilities.filter(c => c === "gateway.register.v1" || c === "skills.install.v1"), gateways: info.gateways, skills: info.skills, nodeId: info.nodeId });
  assert.ok(info.capabilities.includes("gateway.register.v1") && info.capabilities.includes("skills.install.v1")); assert.deepEqual(info.gateways, []); assert.equal(info.skills, null);
  const url1 = "http://127.0.0.1:7788/mcp";
  const relay = await RpcClient.connect(a.socketPath, 3000, "node_relay"); clients.push(relay);
  const gate = { "unregistered local caller": await code(A.request("gateway.register", { url: url1 })), "relay lane": await code(relay.request("gateway.register", { url: url1 })), "unregistered skills.install": await code(A.request("skills.install", { tree: { digest: "0".repeat(64), entries: [] } })) };
  show("A2 only the registered local Apiary authority on a direct Unix socket may call the verbs", gate);
  for (const [k, v] of Object.entries(gate)) assert.ok(v.startsWith("caller_not_trusted"), `${k}: ${v}`);
  await register(A, da.dir, "apiary-node-a");
  const reg1 = await A.request<GatewayRegisterResult>("gateway.register", { url: url1, tokenIssuer: "apiary-spawn-token-v1", idempotencyKey: "m-h7-register-1" });
  const file1 = JSON.parse(readFileSync(reg1.file, "utf8"));
  show("A3 register: the row, the file Honeybee wrote under <storeRoot>/gateways, deployInfo", { result: reg1, file: file1, deployInfo: (await A.request<DeployInfoResult>("deployInfo")).gateways });
  assert.equal(reg1.changed, true); assert.equal(reg1.gateway.name, "apiary"); assert.equal(reg1.gateway.url, url1); assert.equal(reg1.file, join(storeRoot, "gateways", "apiary.json")); assert.equal(file1.gatewayRev, 2); assert.equal(file1.transport, "http"); assert.equal(file1.url, url1); assert.equal(file1.tokenIssuer, "apiary-spawn-token-v1");
  const refusals = {
    "ftp://host/mcp": await code(A.request("gateway.register", { url: "ftp://host/mcp" })),
    "http://user:pw@host/mcp": await code(A.request("gateway.register", { url: "http://user:pw@host/mcp" })),
    "relative/path": await code(A.request("gateway.register", { url: "relative/path" })),
    "http://host/mcp#frag": await code(A.request("gateway.register", { url: "http://host/mcp#frag" })),
    "url with a space": await code(A.request("gateway.register", { url: "http://host/m cp" })),
    "name 'Bad Name'": await code(A.request("gateway.register", { url: url1, name: "Bad Name" })),
    "tokenIssuer of 2000 chars": await code(A.request("gateway.register", { url: url1, tokenIssuer: "x".repeat(2000) })),
    "tokenIssuer with a newline": await code(A.request("gateway.register", { url: url1, tokenIssuer: "a\nb" })),
  };
  show("A4 typed refusals", refusals);
  for (const [k, v] of Object.entries(refusals)) assert.ok(v.startsWith("invalid_request"), `${k}: ${v}`);
  const before = await auditCount(A, "gateway.registered");
  const again = await A.request<GatewayRegisterResult>("gateway.register", { url: url1, tokenIssuer: "apiary-spawn-token-v1" });
  const replay = await A.request<GatewayRegisterResult>("gateway.register", { url: url1, tokenIssuer: "apiary-spawn-token-v1", idempotencyKey: "m-h7-register-1" });
  show("A5 the same registration again is quiet (changed:false, no new audit row); the idempotency key replays", { again: { changed: again.changed, replaced: again.replaced }, replay: { deduped: replay.deduped, changed: replay.changed }, auditRowsBefore: before, auditRowsAfter: await auditCount(A, "gateway.registered") });
  assert.equal(again.changed, false); assert.equal(replay.deduped, true); assert.equal(await auditCount(A, "gateway.registered"), before);
  writeFileSync(join(storeRoot, "gateways", "foundation.json"), JSON.stringify({ name: "foundation", protocol: "mcp", gatewayRev: 1, startedAt: new Date().toISOString(), stateless: true, shim: { command: process.execPath, args: ["foundation-fixture.mjs", "mcp"] }, env: {} }));
  seedCodex(da.dir, "codex-lx"); await A.request("account.add", { harness: "codex", label: "lx", importExisting: true });
  seedClaude(da.dir, "claude-cy"); await A.request("account.add", { harness: "claude", label: "cy", importExisting: true });
  const codexBee = await spawnOn(A, "codex-bee", "codex", "codex-lx", da.dir);
  const claudeBee = await spawnOn(A, "claude-bee", "claude", "claude-cy", da.dir);
  const codexHome = join(da.dir, "homes", "codex-lx"), claudeHome = join(da.dir, "homes", "claude-cy");
  const toml = readFileSync(join(codexHome, "config.toml"), "utf8");
  const claudeJson = JSON.parse(readFileSync(join(claudeHome, ".claude.json"), "utf8"));
  show("A6 a codex bee and a claude bee spawned on their accounts: the homes' native MCP configs point at the registered URL; the stdio file gateway (foundation) is still seeded beside it", {
    codexConfigToml: toml.split("\n").filter(l => l.startsWith("[mcp_servers") || l.startsWith("url") || l.startsWith("command") || l.startsWith("args")),
    codexStamp: JSON.parse(readFileSync(join(codexHome, ".hive-gateways.json"), "utf8")),
    claudeMcpServers: claudeJson.mcpServers,
  });
  assert.ok(toml.includes(`[mcp_servers.apiary]\nurl = ${JSON.stringify(url1)}`), toml); assert.ok(toml.includes("[mcp_servers.foundation]\ncommand = "));
  assert.deepEqual(claudeJson.mcpServers.apiary, { type: "http", url: url1 }); assert.equal(claudeJson.mcpServers.foundation.command, process.execPath);
  const baselineSpawnMs: number[] = [];
  for (let i = 0; i < 8; i++) { const t0 = performance.now(); const id = await spawnOn(A, `base-${i}`, "codex", "codex-lx", da.dir); baselineSpawnMs.push(performance.now() - t0); await A.request("stop", { beeId: id }); await waitFor(async () => (await A.request<ViewResult>("view", { beeId: id })).view.runtimeState === "stopped" ? true : null, "stopped", 30_000); }
  const url2 = "https://apiary.local:7443/mcp/v2";
  const reg2 = await A.request<GatewayRegisterResult>("gateway.register", { url: url2 });
  await A.request("stop", { beeId: codexBee }); await A.request("stop", { beeId: claudeBee });
  await waitFor(async () => (await A.request<ViewResult>("view", { beeId: codexBee })).view.runtimeState === "stopped" ? true : null, "codex bee stopped", 30_000);
  await spawnOn(A, "codex-bee-2", "codex", "codex-lx", da.dir); await spawnOn(A, "claude-bee-2", "claude", "claude-cy", da.dir);
  const toml2 = readFileSync(join(codexHome, "config.toml"), "utf8"), claudeJson2 = JSON.parse(readFileSync(join(claudeHome, ".claude.json"), "utf8"));
  show("A7 re-registering a new URL: the populated homes converge on the next activation", { result: { changed: reg2.changed, replaced: reg2.replaced, url: reg2.gateway.url }, codexApiaryLine: toml2.split("\n").find(l => l.startsWith("url")), claudeApiary: claudeJson2.mcpServers.apiary, foundationStill: claudeJson2.mcpServers.foundation !== undefined });
  assert.equal(reg2.replaced?.url, url1); assert.ok(toml2.includes(`[mcp_servers.apiary]\nurl = ${JSON.stringify(url2)}`)); assert.deepEqual(claudeJson2.mcpServers.apiary, { type: "http", url: url2 });
  writeFileSync(join(storeRoot, "gateways", "apiary.json"), JSON.stringify({ name: "apiary", protocol: "mcp", gatewayRev: 1, startedAt: new Date().toISOString(), stateless: true, shim: { command: process.execPath, args: ["old-apiary-shim.mjs"] }, env: {} }));
  await a.stop();
  a = await startDaemon(da.dir, { env: envA, stopTimeoutMs: 30_000 }); handles.push(a); A = await a.client(); clients.push(A);
  const fileAfterBoot = JSON.parse(readFileSync(join(storeRoot, "gateways", "apiary.json"), "utf8"));
  show("A8 a pre-C6 Apiary clobbers apiary.json with its stdio record; the next daemon boot rewrites Honeybee's record from the row, and the row survived the restart", { fileAfterBoot, deployInfo: (await A.request<DeployInfoResult>("deployInfo")).gateways });
  assert.equal(fileAfterBoot.gatewayRev, 2); assert.equal(fileAfterBoot.url, url2); assert.equal((await A.request<DeployInfoResult>("deployInfo")).gateways?.[0]?.url, url2);

  // ───────────────────────────── B. skills.install ─────────────────────────────
  note("\n# B. skills.install: a content-hashed tree lands in every Honeybee-owned home now and in every home activated later");
  await register(A, da.dir, "apiary-node-a");
  const trees = join(da.dir, "trees"); const t1 = join(trees, "one"), t2 = join(trees, "two");
  writeTree(t1, { "hello/SKILL.md": "# hello\nsay hello\n", "hello/scripts/run.sh": { text: "#!/bin/sh\necho hello\n", executable: true }, "review/SKILL.md": "# review\nreview the diff\n", "review/references/checklist.md": "- read it\n" });
  const tree1 = readSkillTreeFromDirectory(t1);
  const bad = {
    "digest off by one": await code(A.request("skills.install", { tree: { ...tree1, digest: tree1.digest.replace(/^./, c => c === "a" ? "b" : "a") } })),
    "one file's sha256 lies": await code(A.request("skills.install", { tree: { ...tree1, entries: tree1.entries.map((e, i) => i === 0 ? { ...e, sha256: "0".repeat(64) } : e) } })),
    "size disagrees with content": await code(A.request("skills.install", { tree: { ...tree1, entries: tree1.entries.map((e, i) => i === 1 ? { ...e, size: e.size + 1 } : e) } })),
    "path escapes with ..": await code(A.request("skills.install", { tree: { ...tree1, entries: tree1.entries.map((e, i) => i === 2 ? { ...e, path: "../escape.md" } : e) } })),
    "absolute path": await code(A.request("skills.install", { tree: { ...tree1, entries: tree1.entries.map((e, i) => i === 2 ? { ...e, path: "/etc/x" } : e) } })),
    "reserved .hive- name": await code(A.request("skills.install", { tree: { ...tree1, entries: tree1.entries.map((e, i) => i === 2 ? { ...e, path: ".hive-skills.json" } : e) } })),
    "content not base64": await code(A.request("skills.install", { tree: { ...tree1, entries: tree1.entries.map((e, i) => i === 3 ? { ...e, content: "%%%not base64%%%" } : e) } })),
  };
  show("B1 a tree that does not hash to what it claims is refused typed, before anything is written", { ...bad, nodeCopyExists: existsSync(join(da.dir, "skills")), skills: (await A.request<DeployInfoResult>("deployInfo")).skills });
  for (const [k, v] of Object.entries(bad)) assert.ok(v.startsWith("invalid_request"), `${k}: ${v}`); assert.equal(existsSync(join(da.dir, "skills")), false);
  const in1 = await A.request<SkillsInstallResult>("skills.install", { tree: tree1, idempotencyKey: "m-h7-install-1" }, 60_000);
  const copyDir = join(da.dir, "skills", tree1.digest);
  show("B2 install: the node keeps its copy under <dataDir>/skills/<digest>; both existing homes get the files; manifests carry the digest", {
    result: in1, nodeCopy: readSkillsManifest(copyDir)?.digest, codexHome: { files: listHomeSkills(codexHome), manifestDigest: readSkillsManifest(join(codexHome, "skills"))?.digest }, claudeHome: { files: listHomeSkills(claudeHome), manifestDigest: readSkillsManifest(join(claudeHome, "skills"))?.digest },
    executableBit: (await import("node:fs")).statSync(join(codexHome, "skills", "hello", "scripts", "run.sh")).mode & 0o111 ? "set" : "unset",
  });
  assert.equal(in1.changed, true); assert.equal(in1.tree.digest, tree1.digest); assert.equal(in1.tree.files, 4); assert.deepEqual(in1.homes.map(h => `${h.account}:${h.status}`).sort(), ["claude-cy:installed", "codex-lx:installed"]);
  for (const home of [codexHome, claudeHome]) { assert.equal(readSkillsManifest(join(home, "skills"))?.digest, tree1.digest); for (const e of tree1.entries) assert.equal(sha(join(home, "skills", e.path)), e.sha256); }
  assert.equal(readSkillsManifest(copyDir)?.digest, tree1.digest);
  const replayed = await A.request<SkillsInstallResult>("skills.install", { tree: tree1, idempotencyKey: "m-h7-install-1" }, 60_000);
  const same = await A.request<SkillsInstallResult>("skills.install", { tree: tree1 }, 60_000);
  show("B3 the same tree again: idempotency replay is deduped; a fresh call is changed:false with every home unchanged", { replay: { deduped: replayed.deduped }, again: { changed: same.changed, homes: same.homes.map(h => `${h.account}:${h.status}`) }, audits: await auditCount(A, "skills.installed") });
  assert.equal(replayed.deduped, true); assert.equal(same.changed, false); assert.ok(same.homes.every(h => h.status === "unchanged")); assert.equal(await auditCount(A, "skills.installed"), 1);
  seedCodex(da.dir, "codex-zz"); await A.request("account.add", { harness: "codex", label: "zz", importExisting: true });
  const zzHome = join(da.dir, "homes", "codex-zz");
  const zzSkillsBefore = existsSync(join(zzHome, "skills"));
  await spawnOn(A, "codex-zz-bee", "codex", "codex-zz", da.dir);
  const hivedLog = () => readFileSync(join(da.dir, "hived.log"), "utf8");
  show("B4 an account added after the install: its home has no skills until its first spawn activates it; then it carries the tree with the same digest and the daemon log names it", { skillsDirExistedBeforeSpawn: zzSkillsBefore, files: listHomeSkills(zzHome), manifestDigest: readSkillsManifest(join(zzHome, "skills"))?.digest, mcpApiary: readFileSync(join(zzHome, "config.toml"), "utf8").split("\n").find(l => l.startsWith("url")), logLine: hivedLog().split("\n").find(l => l.includes("account.activate.skills account=codex-zz")) ?? null });
  assert.equal(zzSkillsBefore, false); assert.equal(readSkillsManifest(join(zzHome, "skills"))?.digest, tree1.digest); for (const e of tree1.entries) assert.equal(sha(join(zzHome, "skills", e.path)), e.sha256);
  assert.ok(hivedLog().includes(`account.activate.skills account=codex-zz digest=${tree1.digest}`));
  mkdirSync(join(codexHome, "skills", "mine"), { recursive: true }); writeFileSync(join(codexHome, "skills", "mine", "SKILL.md"), "# mine\nnot Honeybee's\n");
  writeTree(t2, { "hello/SKILL.md": "# hello v2\nsay hello twice\n", "hello/scripts/run.sh": { text: "#!/bin/sh\necho hello\n", executable: true }, "perf/SKILL.md": "# perf\nmeasure first\n" });
  const tree2 = readSkillTreeFromDirectory(t2);
  const in2 = await A.request<SkillsInstallResult>("skills.install", { tree: tree2 }, 60_000);
  show("B5 a second tree: a changed file is rewritten, a removed skill is gone, a new one appears, a file Honeybee never installed stays, the old node copy is removed", {
    result: { changed: in2.changed, replaced: in2.replaced, homes: in2.homes.map(h => `${h.account}:${h.status}`) }, codexHome: listHomeSkills(codexHome), oldCopyGone: !existsSync(copyDir), newCopy: readSkillsManifest(join(da.dir, "skills", tree2.digest))?.digest,
  });
  assert.equal(in2.replaced, tree1.digest); assert.equal(existsSync(join(codexHome, "skills", "review")), false); assert.equal(sha(join(codexHome, "skills", "hello", "SKILL.md")), tree2.entries.find(e => e.path === "hello/SKILL.md")!.sha256); assert.ok(existsSync(join(codexHome, "skills", "perf", "SKILL.md"))); assert.ok(existsSync(join(codexHome, "skills", "mine", "SKILL.md"))); assert.equal(existsSync(copyDir), false);
  const machineHome = join(da.dir, "machine-home"); mkdirSync(join(machineHome, ".codex"), { recursive: true });
  writeFileSync(join(machineHome, ".codex", "auth.json"), JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: fakeJwt(exp), refresh_token: `STANDIN-CODEX-${randomUUID()}`, id_token: "fixture", account_id: "fixture" } }), { mode: 0o600 });
  await a.stop();
  a = await startDaemon(da.dir, { env: { ...envA, HOME: machineHome }, stopTimeoutMs: 30_000 }); handles.push(a); A = await a.client(); clients.push(A);
  await register(A, da.dir, "apiary-node-a");
  const imported = await A.request<AccountImportResult>("account.import", { harness: "codex" });
  const in3 = await A.request<SkillsInstallResult>("skills.install", { tree: tree2 }, 60_000);
  show("B6 after a restart the tree row persists; a native (imported) account's vendor home is never written", { skillsAfterRestart: (await A.request<DeployInfoResult>("deployInfo")).skills?.digest, imported: { id: imported.account.id, home: imported.account.homePath, native: imported.account.nativeLogin !== null }, homesTouched: in3.homes.map(h => h.account), vendorSkillsDir: existsSync(join(machineHome, ".codex", "skills")) });
  assert.equal((await A.request<DeployInfoResult>("deployInfo")).skills?.digest, tree2.digest); assert.ok(!in3.homes.some(h => h.account === imported.account.id)); assert.equal(existsSync(join(machineHome, ".codex", "skills")), false);
  seedCodex(da.dir, "codex-ww"); await A.request("account.add", { harness: "codex", label: "ww", importExisting: true });
  await spawnOn(A, "codex-ww-bee", "codex", "codex-ww", da.dir);
  const wwHome = join(da.dir, "homes", "codex-ww");
  show("B7 a home activated after the restart gets the tree from the node's own copy (no Apiary call)", { manifestDigest: readSkillsManifest(join(wwHome, "skills"))?.digest, files: listHomeSkills(wwHome) });
  assert.equal(readSkillsManifest(join(wwHome, "skills"))?.digest, tree2.digest);

  // ───────────────────────────── C. CLI edges ─────────────────────────────
  note("\n# C. CLI edges (in-process runV2Cli against the scratch daemon)");
  const cli = async (args: string[]) => { const out: string[] = [], err: string[] = []; const rc = await runV2Cli(["--data-dir", da.dir, ...args], { out: l => out.push(l), err: l => err.push(l) }); return { rc, out, err }; };
  const c1 = await cli(["gateway", "register", "http://127.0.0.1:9999/mcp", "--name", "apiary", "--register"]);
  const c2 = await cli(["gateway", "list"]);
  const c3 = await cli(["skills", "install", t1, "--register"]);
  const c4 = await cli(["skills", "status"]);
  const c5 = await cli(["gateway", "register", "ftp://nope"]);
  show("C1 hive gateway register / list, hive skills install / status", { register: c1, list: c2, install: c3, status: c4, refused: { rc: c5.rc, err: c5.err } });
  assert.equal(c1.rc, 0); assert.equal(c2.rc, 0); assert.ok(c2.out.some(l => l.includes("http://127.0.0.1:9999/mcp"))); assert.equal(c3.rc, 0); assert.equal(c4.rc, 0); assert.ok(c4.out.some(l => l.includes(tree1.digest))); assert.notEqual(c5.rc, 0);

  // ───────────────────────────── D. timing ─────────────────────────────
  note("\n# D. timing on the scratch daemon (ms)");
  const regTimes: number[] = []; for (let i = 0; i < 100; i++) { const t = performance.now(); await A.request("gateway.register", { url: "http://127.0.0.1:9999/mcp" }); regTimes.push(performance.now() - t); }
  const bigSrc = join(process.env.HIVE_TEST_INVOKING_HOME ?? process.env.HOME!, ".hive", "homes", "claude-tormod-arbeidsark.no", "skills");
  let big: ReturnType<typeof readSkillTreeFromDirectory> | null = null;
  if (existsSync(bigSrc)) { const stage = join(trees, "big"); mkdirSync(stage, { recursive: true }); (await import("node:fs")).cpSync(bigSrc, stage, { recursive: true, filter: (src) => !src.includes("/.apiary-skill-") }); big = readSkillTreeFromDirectory(stage); }
  const timing: Record<string, unknown> = { "gateway.register p50 (unchanged row, file rewritten)": p50(regTimes), "spawn→running p50 on a populated home with no skill tree (measured in section A, same build)": p50(baselineSpawnMs) };
  const spawnMs = async (prefix: string, n: number) => { const xs: number[] = []; for (let i = 0; i < n; i++) { const t0 = performance.now(); const id = await spawnOn(A, `${prefix}-${i}`, "codex", "codex-lx", da.dir); xs.push(performance.now() - t0); await A.request("stop", { beeId: id }); await waitFor(async () => (await A.request<ViewResult>("view", { beeId: id })).view.runtimeState === "stopped" ? true : null, "stopped", 30_000); } return xs; };
  timing["spawn→running p50 on a populated home with the 4-file tree installed (manifest check only)"] = p50(await spawnMs("t-small", 8));
  if (big) {
    const t = performance.now(); const r = await A.request<SkillsInstallResult>("skills.install", { tree: big }, 300_000); const installMs = performance.now() - t;
    timing["skills.install of this node's real skill tree"] = { files: big.entries.length, bytes: r.tree.bytes, homes: r.homes.length, ms: installMs.toFixed(0), wireBytes: JSON.stringify(big).length };
    const t2b = performance.now(); await A.request<SkillsInstallResult>("skills.install", { tree: big }, 300_000); timing["skills.install of the same tree again (unchanged everywhere)"] = (performance.now() - t2b).toFixed(0);
    timing["spawn→running p50 on a populated home with the 915-file tree installed (manifest check only)"] = p50(await spawnMs("t-with", 8));
    const t3 = performance.now(); seedCodex(da.dir, "codex-fresh"); await A.request("account.add", { harness: "codex", label: "fresh", importExisting: true }); await spawnOn(A, "fresh-bee", "codex", "codex-fresh", da.dir); timing["account.add + first spawn→running of a fresh home that receives the 900-file tree at activation"] = (performance.now() - t3).toFixed(0);
  }
  show("D1 timings", timing);
  await a.stop();
  note("\nALL CHECKS PASSED");
} finally { await cleanup(); }
