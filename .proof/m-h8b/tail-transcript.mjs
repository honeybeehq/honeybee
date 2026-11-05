#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
const root = resolve(option("--root", "."));
const beforeRoot = resolve(option("--before", "/tmp/hb-h8b-before"));
const outDir = resolve(option("--out", ".proof/m-h8b/tail-transcript"));
mkdirSync(outDir, { recursive: true });

const local = (file) => import(pathToFileURL(join(root, file)).href);
const { makeDaemonDir, startDaemon, waitFor } = await local("v2/daemon/tests/helpers.ts");

const agentDir = join(root, "v2", "driver-hsr", "test-agent");
const scratch = mkdtempSync(join(tmpdir(), "hb-m-h8b-tail-"));
const codexHome = join(scratch, "codex-home");
mkdirSync(codexHome, { recursive: true });
const museRecorded = join(scratch, "muse-recorded.jsonl");
{
  const fixture = readFileSync(join(root, "v2", "adapters", "tests", "fixtures", "muse-usage-changed.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const [usageLine] = fixture;
  usageLine.params = { ...usageLine.params, observedAtMs: Date.now() - 60_000, window: { ...usageLine.params.window, resetsAtMs: Date.now() + 3_600_000 } };
  writeFileSync(museRecorded, `${JSON.stringify(usageLine)}\n`);
}

const { dir, cleanup } = makeDaemonDir({
  tickMs: 200,
  stubEnv: { STUB_TURN_MS: "50" },
  agents: {
    claude: { command: process.execPath, args: [join(agentDir, "fake-claude.mjs"), "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"], adapter: "claude" },
    codex: { command: process.execPath, args: [join(agentDir, "fake-codex.mjs")], adapter: "codex", env: { CODEX_HOME: codexHome } },
    muse: { command: process.execPath, args: [join(agentDir, "fake-muse.mjs"), "serve"], adapter: "muse", env: { MUSE_NO_AUTO_UPDATE: "1", FAKE_MUSE_RECORDED: museRecorded } },
  },
});

const cli = (treeRoot, argv) => {
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", join(treeRoot, "v2", "cli", "src", "bin.ts"), ...argv, "--data-dir", dir], {
    encoding: "utf8", env: { ...process.env, NO_COLOR: "1", HIVE_V2_DATA_DIR: dir },
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
};

const daemon = await startDaemon(dir, {});
const client = await daemon.client();
const view = (beeId) => client.request("view", { beeId });
const waitState = (beeId, state, label) => waitFor(async () => (await view(beeId)).view.runtimeState === state, label, 30_000, 50);
const report = { timestamp: new Date().toISOString(), hostname: hostname(), node: process.version, root, beforeRoot, dataDir: dir, bees: [], ok: true };
try {
  const bees = [];
  const spawnAndTalk = async (harness, spawnParams, bodies) => {
    const name = `${harness}-bee`;
    const { beeId } = await client.request("spawn", { name, agent: harness, cwd: scratch, ...spawnParams });
    await waitState(beeId, "idle", `${name} boots`);
    for (const body of bodies) {
      const sent = await client.request("send", { beeId, body });
      await waitFor(async () => (await client.request("mailbox", { beeId })).messages.find((m) => m.id === sent.messageId)?.deliveredAt != null, `${name} delivered`, 30_000, 50);
      await waitState(beeId, "idle", `${name} turn ended`);
    }
    bees.push({ harness, name, beeId });
  };
  await spawnAndTalk("stub", {}, ["hello stub", "second message for stub"]);
  await spawnAndTalk("claude", { account: null }, ["hello claude", "second message for claude"]);
  await spawnAndTalk("codex", { account: null }, ["hello codex", "second message for codex"]);
  {
    const id = "muse-sub";
    const credential = JSON.stringify({ schema_version: 1, providers: { meta: { api_key: "fixture-key" } } });
    for (const base of [join(dir, "homes", id, "muse"), join(dir, "vault", "muse", id, "muse")]) {
      mkdirSync(base, { recursive: true });
      writeFileSync(join(base, "auth.json"), credential);
    }
    await client.request("account.add", { harness: "muse", label: "sub", importExisting: true });
    await spawnAndTalk("muse", { account: id, tags: ["autoswap=false"] }, ["hello muse", "second message for muse"]);
  }
  for (const bee of bees) {
    await client.request("stop", { beeId: bee.beeId });
    await waitState(bee.beeId, "stopped", `${bee.name} stopped`);
  }
  const verbs = [
    ["tail", (name) => ["tail", name]],
    ["tail-n2", (name) => ["tail", name, "-n", "2"]],
    ["tail-raw", (name) => ["tail", name, "--raw"]],
    ["transcript", (name) => ["transcript", name]],
    ["transcript-n3", (name) => ["transcript", name, "-n", "3"]],
    ["transcript-raw", (name) => ["transcript", name, "--raw"]],
    ["transcript-json", (name) => ["transcript", name, "--json"]],
    ["last", (name) => ["last", name]],
  ];
  for (const bee of bees) {
    const v = await view(bee.beeId);
    const logPath = v.bee?.sessionLogPath;
    const logName = `${bee.harness}-${bee.beeId.slice(0, 8)}.jsonl`;
    if (logPath) copyFileSync(logPath, join(outDir, logName));
    const results = {};
    for (const [label, argv] of verbs) {
      const before = cli(beforeRoot, argv(bee.name));
      const after = cli(root, argv(bee.name));
      writeFileSync(join(outDir, `${bee.harness}.${label}.before.txt`), before.stdout);
      writeFileSync(join(outDir, `${bee.harness}.${label}.after.txt`), after.stdout);
      const identical = before.status === after.status && before.stdout === after.stdout;
      results[label] = { exit: after.status, lines: after.stdout.split("\n").filter(Boolean).length, identical, ...(identical ? {} : { beforeExit: before.status, beforeStderr: before.stderr.slice(-400), afterStderr: after.stderr.slice(-400) }) };
      if (!identical) report.ok = false;
      console.log(`${identical ? "ok  " : "FAIL"} ${bee.harness} ${label} exit=${after.status} lines=${results[label].lines}`);
    }
    report.bees.push({ ...bee, sessionLog: logName, results });
  }
  const manifest = Object.fromEntries(report.bees.map((b) => [b.sessionLog, b.harness]));
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
} finally {
  client.close();
  await daemon.stop().catch(() => {});
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  cleanup();
}
console.log(JSON.stringify({ ok: report.ok, out: join(outDir, "report.json") }));
assert.ok(report.ok, "tail/transcript output differs between trees");
