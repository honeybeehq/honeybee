import { persistNodePin, probeNativeNode } from "../src/nodeRuntime.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { restartDeployedDaemon } from "../src/commands/deploy.js";

test("fresh verified activation executes installed current v2 CLI with scoped data directory", { skip: process.platform !== "darwin" && process.platform !== "linux" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "hon8-restart-"));
  const previousServiceDir = process.env.HIVE_V2_SERVICE_DIR;
  const previousHome = process.env.HOME;
  const previousNodeOptions = process.env.NODE_OPTIONS;
  const previousElectron = process.env.ELECTRON_RUN_AS_NODE;
  process.env.NODE_OPTIONS = "--no-warnings";
  process.env.ELECTRON_RUN_AS_NODE = "parent-runtime-only";
  process.env.HOME = join(dir, "home");
  process.env.HIVE_V2_SERVICE_DIR = join(process.env.HOME, "units");
  assert.ok(process.env.HIVE_V2_SERVICE_DIR.startsWith(process.env.HOME + "/"));
  try {
    const root = join(dir, "runtime"), calls = join(dir, "calls.jsonl");
    await mkdir(join(root, "current", "dist"), { recursive: true });
    const pinnedNode = join(dir, "node-24-pinned");
    await copyFile(process.execPath, pinnedNode);
    persistNodePin(join(dir, "v2"), probeNativeNode(pinnedNode));
    await writeFile(join(root, "current", "dist", "cli.js"), `require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args: process.argv.slice(2), interpreter: process.execPath, nodeOptions: process.env.NODE_OPTIONS, electron: process.env.ELECTRON_RUN_AS_NODE })+'\\n'); if(process.argv[4] === 'status') console.log(JSON.stringify({running:true}));`);
    await restartDeployedDaemon({ root, installedDir: join(root, "current"), sha: "a".repeat(40), runtime: "v2", log() {} });
    assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n").map(line => JSON.parse(line)),
      ["install", "stop", "start", "status"].map(verb => ({ args: ["v2", "daemon", verb, "--data-dir", join(dir, "v2"), ...(verb === "status" ? ["--json"] : [])], interpreter: pinnedNode })));
  } finally {
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previousNodeOptions;
    if (previousElectron === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = previousElectron;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousServiceDir === undefined) delete process.env.HIVE_V2_SERVICE_DIR;
    else process.env.HIVE_V2_SERVICE_DIR = previousServiceDir;
    await rm(dir, { recursive: true, force: true });
  }
});

for (const absent of [false, true]) {
  test(`restart after stop failure ${absent ? "requires confirmed absence" : "refuses a still-loaded service"}`, { skip: process.platform !== "darwin" && process.platform !== "linux" }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "hon8-stop-"));
    const previousServiceDir = process.env.HIVE_V2_SERVICE_DIR;
    const previousHome = process.env.HOME;
    process.env.HOME = join(dir, "home");
    process.env.HIVE_V2_SERVICE_DIR = join(process.env.HOME, "units");
    assert.ok(process.env.HIVE_V2_SERVICE_DIR.startsWith(process.env.HOME + "/"));
    try {
      const root = join(dir, "runtime"), calls = join(dir, "calls.jsonl");
      await mkdir(join(root, "current", "dist"), { recursive: true });
    persistNodePin(join(dir, "v2"), probeNativeNode(process.execPath));
      await writeFile(join(root, "current", "dist", "cli.js"), `
        require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2))+'\\n');
        if (process.argv[4] === 'stop') process.exit(1);
        if (process.argv[4] === 'start') require('node:fs').writeFileSync(${JSON.stringify(join(dir, "started"))}, 'yes');
        if (process.argv[4] === 'status') console.log(JSON.stringify(require('node:fs').existsSync(${JSON.stringify(join(dir, "started"))}) ? {running:true} : ${JSON.stringify({ running: !absent, service: { installed: !absent, running: !absent } })}));
      `);
      const result = restartDeployedDaemon({ root, installedDir: join(root, "current"), sha: "a".repeat(40), runtime: "v2", log() {} });
      if (absent) await result;
      else await assert.rejects(result, /exited/);
      const verbs = (await readFile(calls, "utf8")).trim().split("\n").map(line => JSON.parse(line)[2]);
      assert.deepEqual(verbs, absent ? ["install", "stop", "status", "start", "status"] : ["install", "stop", "status"]);
    } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousServiceDir === undefined) delete process.env.HIVE_V2_SERVICE_DIR;
    else process.env.HIVE_V2_SERVICE_DIR = previousServiceDir;
    await rm(dir, { recursive: true, force: true });
  }
  });
}

import { RUNTIME_MODE_CONFIG } from "../src/cliRoute.js";

test("persisted v2 config selects the v2 service for an ordinary source restart", { skip: process.platform !== "darwin" && process.platform !== "linux" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "hon8-config-restart-"));
  const previousServiceDir = process.env.HIVE_V2_SERVICE_DIR;
  const previousHome = process.env.HOME;
  process.env.HOME = join(dir, "home");
  process.env.HIVE_V2_SERVICE_DIR = join(process.env.HOME, "units");
  assert.ok(process.env.HIVE_V2_SERVICE_DIR.startsWith(process.env.HOME + "/"));
  try {
    const root = join(dir, "runtime"), calls = join(dir, "calls.jsonl");
    await mkdir(join(root, "current", "dist"), { recursive: true });
    persistNodePin(join(dir, "v2"), probeNativeNode(process.execPath));
    await writeFile(join(root, RUNTIME_MODE_CONFIG), JSON.stringify({ schemaVersion: 1, runtime: "v2" }));
    await writeFile(join(root, "current", "dist", "cli.js"), `require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2))+'\\n'); if(process.argv[4] === 'status') console.log(JSON.stringify({running:true}));`);
    await restartDeployedDaemon({ root, installedDir: join(root, "current"), sha: "b".repeat(40), log() {} });
    assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n").map(line => JSON.parse(line)),
      ["install", "stop", "start", "status"].map(verb => ["v2", "daemon", verb, "--data-dir", join(dir, "v2"), ...(verb === "status" ? ["--json"] : [])]));
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousServiceDir === undefined) delete process.env.HIVE_V2_SERVICE_DIR;
    else process.env.HIVE_V2_SERVICE_DIR = previousServiceDir;
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy deployment refuses activation before selecting a service", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hb-legacy-deploy-refuse-"));
  try {
    await assert.rejects(restartDeployedDaemon({ root: dir, installedDir: dir, sha: "a".repeat(40), log() {} }), /legacy service activation is refused/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

import { assertBuildPin, buildPinFile, BuildPinMismatchError } from "../src/buildPin.ts";
import { writeNodeRuntimeState } from "../src/nodeRuntime.ts";

test("production restart checks the authenticated running report and accepts only an exact recorded override", async () => {
  for (const override of [false, true]) {
    const dir = await mkdtemp(join(tmpdir(), "hb-post-pin-")), root = join(dir, "runtime"), cli = join(root, "current", "dist", "cli.js");
    await mkdir(join(root, "current", "dist"), { recursive: true });
    const expected = { schemaVersion: 1, sourceRevision: "a".repeat(40), target: `${process.platform}-${process.arch}` };
    const running = { sourceRevision: "b".repeat(40), target: expected.target, distHash: "c".repeat(64), artifactSha256: null };
    writeNodeRuntimeState(buildPinFile(root), expected);
    persistNodePin(join(dir, "v2"), probeNativeNode(process.execPath));
    await writeFile(cli, `if(process.argv[3] === 'build-report') console.log(JSON.stringify({running:${JSON.stringify(running)}})); else if(process.argv[4] === 'status') console.log(JSON.stringify({running:true}));`);
    if (override) assertBuildPin(root, running, "fixture activation override");
    const attempt = restartDeployedDaemon({ root, installedDir: join(root, "current"), sha: running.sourceRevision, runtime: "v2", log() {} });
    if (override) await attempt;
    else await assert.rejects(attempt, BuildPinMismatchError);
  }
});
