import { persistNodePin, probeNativeNode } from "../src/nodeRuntime.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { restartDeployedDaemon } from "../src/commands/deploy.js";
import { DeployActivationHeldError, DeployRollbackError } from "../src/deployRuntime.js";
import { chmod } from "node:fs/promises";

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

for (const scenario of ["after-start", "after-stop", "compatible"] as const) {
  test(`restart recovery preserves a safe service and pin boundary: ${scenario}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "hb-recovery-order-"));
    const names = ["HOME", "PATH", "HIVE_V2_SERVICE_DIR", "HIVE_V2_SERVICE_LABEL"];
    const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
    const home = join(dir, "home"), units = join(home, "units"), root = join(home, "runtime"), bin = join(home, "bin");
    const label = "dev.honeybee.scratch-recovery", service = join(units, label + (process.platform === "darwin" ? ".plist" : ".service"));
    const marker = join(dir, "store-schema"), calls = join(dir, "calls.jsonl");
    await mkdir(join(root, "current", "dist"), { recursive: true });
    await mkdir(units, { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(service, "previous-service");
    await writeFile(marker, "44");
    for (const command of ["launchctl", "systemctl"]) {
      const file = join(bin, command);
      await writeFile(file, command === "launchctl" ? "#!/bin/sh\necho 'Could not find service' >&2\nexit 113\n" : "#!/bin/sh\necho 'ActiveState=inactive'\necho 'MainPID=0'\n");
      await chmod(file, 0o700);
    }
    process.env.HOME = home;
    process.env.PATH = bin + ":" + previous.PATH;
    process.env.HIVE_V2_SERVICE_DIR = units;
    process.env.HIVE_V2_SERVICE_LABEL = label;
    const pinFile = join(home, "node-runtime.json");
    persistNodePin(join(home, "v2"), probeNativeNode(process.execPath));
    const pin = await readFile(pinFile, "utf8");
    await writeFile(join(root, "current", "dist", "cli.js"), `
      const fs = require('node:fs'), verb = process.argv[3] === 'deploy-info' ? 'deploy-info' : process.argv[4];
      fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(verb)+'\\n');
      if(verb==='deploy-info') { if(fs.existsSync(${JSON.stringify(join(dir, "recovered"))}))console.log(JSON.stringify({pid:process.ppid,startedAt:1,nodeVersion:${JSON.stringify(process.version)},identity:{sourceRevision:'a'.repeat(40)}}));else process.exit(1); }
      if(verb==='install') { fs.writeFileSync(${JSON.stringify(service)},'candidate-service'); fs.writeFileSync(${JSON.stringify(pinFile)},'candidate-pin'); }
      if(verb==='start') { if(fs.readFileSync(${JSON.stringify(marker)},'utf8')==='51')fs.writeFileSync(${JSON.stringify(join(dir, "recovered"))},'yes');else fs.writeFileSync(${JSON.stringify(marker)},${JSON.stringify(scenario === "after-start" ? "51" : "started44")}); }
      if(verb==='stop'&&${JSON.stringify(scenario)}==='after-stop'&&fs.readFileSync(${JSON.stringify(marker)},'utf8')==='started44')fs.writeFileSync(${JSON.stringify(marker)},'51');
      if(verb==='status')console.log(JSON.stringify(fs.existsSync(${JSON.stringify(join(dir, "recovered"))})?{running:true}:{running:false,repair:{reason:'fixture refusal'}}));
    `);
    await mkdir(join(root, "current", "dist", "v2"));
    await writeFile(join(root, "current", "dist", "v2", "cli.js"), "var SCHEMA_VERSION = 51;\n");
    const assertRollbackSafe = async () => {
      if ((await readFile(marker, "utf8")) === "51") throw new DeployRollbackError("ROLLBACK_STORE_RESTORE_REQUIRED", "store51 cannot be opened by previous44");
    };
    const context = { root, installedDir: join(root, "current"), sha: "a".repeat(40), runtime: "v2" as const, log() {}, assertRollbackSafe,
      restorePrevious: async () => { await assertRollbackSafe(); return true; } };
    try {
      const outcome = restartDeployedDaemon(context);
      if (scenario === "compatible") await assert.rejects(outcome, /needs Node pin repair/);
      else await assert.rejects(outcome, error => error instanceof DeployActivationHeldError && error.serviceFilesRetained && (scenario !== "after-stop" || error.candidateReadiness === "ready"));
      const verbs = (await readFile(calls, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      assert.equal(verbs.filter(verb => verb === "stop").length, scenario === "after-start" ? 1 : 2);
      assert.equal(verbs.filter(verb => verb === "start").length, scenario === "after-stop" ? 2 : 1);
      assert.equal(await readFile(service, "utf8"), scenario === "compatible" ? "previous-service" : "candidate-service");
      assert.equal(await readFile(pinFile, "utf8"), scenario === "compatible" ? pin : "candidate-pin");
      if (scenario === "after-stop") assert.equal(await readFile(join(dir, "recovered"), "utf8"), "yes");
    } finally {
      for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
      await rm(dir, { recursive: true, force: true });
    }
  });
}
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
