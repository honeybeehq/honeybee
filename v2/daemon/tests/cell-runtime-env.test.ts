import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openCoreStore, type BeeRow } from "../../core/src/index.ts";
import { HiveDaemon } from "../src/daemon.ts";
import { loadNodeConfig, type AgentSpecConfig } from "../src/config.ts";
import { cellDaemonEnvironment } from "../../driver-cell/src/runtimeEnvironment.ts";
import { sandboxEnvironment } from "../../driver-cell/src/sandbox.ts";

const routes = ["HIVE_SOCKET", "HIVE_DATA_DIR", "HIVE_V2_SOCKET_PATH", "HIVE_V2_DATA_DIR", "HIVE_TMUX_SOCKET", "HIVE_TMUX_SOCKET_PATH"];

test("Cell daemon inheritance is default deny, including identity-like secrets", () => {
  const names: string[] = [];
  const selected = cellDaemonEnvironment({PATH:"fixture",LANG:"fixture",LC_ALL:"fixture",LC_CTYPE:"fixture",TZ:"fixture",TERM:"fixture",HOME:"fixture",USER:"fixture",LOGNAME:"fixture",TMPDIR:"fixture",LC_UNEXPECTED_SECRET:"fixture",HIVE_UNKNOWN_SECRET:"fixture",APIARY_AGENT_TOKEN:"fixture",OPENAI_API_KEY:"fixture",UNKNOWN_SECRET:"fixture"}, dropped => names.push(...dropped));
  assert.deepEqual(Object.keys(selected).sort(), ["PATH","LANG","LC_ALL","LC_CTYPE","TZ","TERM","HOME","USER","LOGNAME","TMPDIR"].sort());
  assert.deepEqual(names, ["APIARY_AGENT_TOKEN","HIVE_UNKNOWN_SECRET","LC_UNEXPECTED_SECRET","OPENAI_API_KEY","UNKNOWN_SECRET"]);
});

test("Cell runtime keeps explicit harness, account and stamped identity env while host substrates keep inheritance", () => {
  const root = mkdtempSync(join(tmpdir(), "hb-cell-env-"));
  const store = openCoreStore(join(root, "fixture.sqlite"));
  const config = loadNodeConfig(root);
  const daemon = new HiveDaemon(config);
  const internal = daemon as unknown as {
    store: typeof store;
    accounts: {homeEnvOf(): Record<string,string>; credentialEnvOf(): Record<string,string>; nativeBeeEnv(account: unknown, env: Record<string,string>): Record<string,string>};
    runtimeEnvOf(bee: BeeRow, spec: AgentSpecConfig, label: string): Record<string,string>;
  };
  internal.store = store;
  internal.accounts = {homeEnvOf: () => ({}), credentialEnvOf: () => ({CURSOR_API_KEY: "fixture-account"}), nativeBeeEnv: (_account, env) => ({...env})};
  const account = store.createAccount({id:"codex-native",harness:"codex",label:"fixture",homePath:join(root,"account"),native:true});
  const bee = store.createBee({name:"fixture",agent:"stub",substrate:"cell",cwd:root,account:account.id,parentId:null,env:{BEE_SETTING:"fixture-bee",APIARY_AGENT_TOKEN:"fixture-agent",HIVE_V2_SOCKET_PATH:join(root,"hived.sock")}}).bee;
  const spec = {command:process.execPath,env:{SPEC_SETTING:"fixture-spec",APIARY_GATEWAY_URL:"fixture-url",APIARY_SESSION_ID:"fixture-session",HIVE_BEE_ID:"spoofed",HIVE_DATA_DIR:root}};
  const previous = {canary:process.env.T11J_CANARY_SECRET,debug:process.env.HIVE_DEBUG_CELL_ENV};
  const canary = randomBytes(24).toString("hex");
  process.env.T11J_CANARY_SECRET = canary;
  process.env.HIVE_DEBUG_CELL_ENV = "1";
  try {
    const cell = internal.runtimeEnvOf(bee,spec,"fixture");
    assert.equal(Object.hasOwn(cell,"T11J_CANARY_SECRET"),false);
    for (const name of ["SPEC_SETTING","BEE_SETTING","APIARY_GATEWAY_URL","APIARY_SESSION_ID","APIARY_AGENT_TOKEN","CURSOR_API_KEY"]) assert.equal(Object.hasOwn(cell,name),true,name);
    assert.ok(cell.CODEX_HOME === account.homePath);
    assert.ok(cell.HIVE_BEE_ID === bee.id);
    assert.ok(cell.HIVE_BEE === bee.name);
    assert.equal(Object.hasOwn(cell,"HIVE_PARENT"),false);
    for (const name of routes) assert.equal(Object.hasOwn(cell,name),false,name);
    const child = internal.runtimeEnvOf({...bee,parentId:"fixture-parent"},spec,"fixture");
    assert.ok(child.HIVE_PARENT === "fixture-parent");
    for (const substrate of ["hsr","tmux"]) {
      const host = internal.runtimeEnvOf({...bee,substrate},spec,"fixture");
      assert.ok(host.T11J_CANARY_SECRET === canary);
      assert.ok(host.HIVE_V2_DATA_DIR === root);
      assert.ok(host.HIVE_V2_SOCKET_PATH === config.socketPath);
    }
    const log = readFileSync(config.logPath,"utf8");
    assert.ok(log.includes("debug.cell_env.dropped"));
    assert.ok(log.includes("T11J_CANARY_SECRET"));
    assert.equal(log.includes(canary),false);
    const privateEnv = sandboxEnvironment(root,{...cell,HOME:root,HIVE_SOCKET:join(root,"hived.sock")});
    assert.ok(privateEnv.HOME?.startsWith(join(root,"sandbox-state")+"/"));
    for (const name of routes) assert.equal(Object.hasOwn(privateEnv,name),false,name);
    const plainCell = sandboxEnvironment(root,cell,false);
    assert.ok(plainCell.TMPDIR?.startsWith(join(root,"sandbox-state")+"/"));
  } finally {
    for (const [key,value] of [["T11J_CANARY_SECRET",previous.canary],["HIVE_DEBUG_CELL_ENV",previous.debug]] as const) {if(value===undefined)delete process.env[key];else process.env[key]=value;}
    store.close();
    const trash = join(tmpdir(),"honeybee-test-trash");mkdirSync(trash,{recursive:true});renameSync(root,join(trash,root.split("/").at(-1)!));
  }
});


test("host HSR child still receives an unknown daemon environment variable", {timeout:30000}, async t => {
  const {makeDaemonDir,startDaemon,waitFor} = await import("./helpers.ts");
  const rig = makeDaemonDir({cells:{sandbox:true}});
  const receipt = join(rig.dir,"env-receipt.json");
  const script = join(rig.dir,"host-probe.mjs");
  writeFileSync(script, `import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(receipt)},JSON.stringify({hasCanary:Object.hasOwn(process.env,'T11J_CANARY_SECRET')}));
console.log(JSON.stringify({event:'ready',sessionId:'host-env-'+process.pid}));
process.stdin.resume();`);
  const configPath = join(rig.dir,"config.json");
  const config = JSON.parse(readFileSync(configPath,"utf8"));
  config.agents.envProbe = {command:process.execPath,args:[script],adapter:"stub"};
  writeFileSync(configPath,JSON.stringify(config));
  const daemon = await startDaemon(rig.dir,{env:{T11J_CANARY_SECRET:randomBytes(24).toString("hex")}});
  const client = await daemon.client();
  t.after(async () => {client.close();await daemon.stop();const trash=join(dirname(rig.dir),"honeybee-test-trash");mkdirSync(trash,{recursive:true});renameSync(rig.dir,join(trash,rig.dir.split("/").at(-1)!));});
  await client.request("spawn",{name:"host-env",agent:"envProbe",substrate:"hsr",cwd:rig.dir,account:null});
  await waitFor(()=>existsSync(receipt),"host env receipt",10000);
  assert.equal(JSON.parse(readFileSync(receipt,"utf8")).hasCanary,true);
});

test("Cell driver without a supplied harness env filters its independent daemon fallback", {timeout:30000}, async () => {
  const {makeRig} = await import("../../driver-cell/tests/helpers.ts");
  const {CellDriver} = await import("../../driver-cell/src/driver.ts");
  const {stubAdapter} = await import("../../adapters/src/index.ts");
  const {fixtureRuntimeIdentity} = await import("../../driver-hsr/tests/helpers.ts");
  const {waitFor} = await import("./helpers.ts");
  const rig = makeRig();
  const receipt = join(rig.root,"fallback-receipt.json");
  const script = join(rig.root,"fallback.mjs");
  writeFileSync(script,`import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(receipt)},JSON.stringify({canaryAbsent:!Object.hasOwn(process.env,'T11J_CANARY_SECRET'),privateHome:process.env.HOME?.includes('/sandbox-state/home')}));
console.log(JSON.stringify({event:'ready',sessionId:'cell-env-'+process.pid}));process.stdin.resume();`);
  const driver = new CellDriver({
    cellsRoot:rig.cellsRoot,nodeKind:"workstation",disableCow:true,
    resolveHarness:()=>({adapter:stubAdapter,command:process.execPath,args:[script]}),
    resolveCell:()=>({provision:{beeId:"fallback",originRepo:rig.origin.repo,sha:rig.origin.sha,wrapper:"fallback",repoName:"fixture",cellId:"fallback"},sandbox:false}),
    hsr:{runtimeIdentity:fixtureRuntimeIdentity(rig.root),sessionLogDir:join(rig.root,"logs"),stopKillGraceMs:300},
  });
  const saved = process.env.T11J_CANARY_SECRET;
  process.env.T11J_CANARY_SECRET = randomBytes(24).toString("hex");
  try {
    driver.start("fallback",1);
    await waitFor(()=>{driver.observe();return existsSync(receipt);},"Cell fallback env receipt",10000);
    const result=JSON.parse(readFileSync(receipt,"utf8"));
    assert.equal(result.canaryAbsent,true);
    assert.equal(result.privateHome,true);
  } finally {
    if(saved===undefined)delete process.env.T11J_CANARY_SECRET;else process.env.T11J_CANARY_SECRET=saved;
    driver.disposeAll();
    const trash=join(dirname(rig.root),"honeybee-test-trash");mkdirSync(trash,{recursive:true});renameSync(rig.root,join(trash,rig.root.split("/").at(-1)!));
  }
});
