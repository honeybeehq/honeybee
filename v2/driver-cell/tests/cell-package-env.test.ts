import assert from "node:assert/strict";
import {test} from "node:test";
import {writeFileSync,readFileSync} from "node:fs";
import {join,dirname} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {stubAdapter} from "../../adapters/src/index.ts";
import {fixtureRuntimeIdentity} from "../../driver-hsr/tests/helpers.ts";
import {composeCellHost,makeRig} from "./helpers.ts";

test("unconfined v2 Cell child receives disabled implicit package confirmation",async()=>{
  const rig=makeRig(),receipt=join(rig.root,"env.json"),agent=join(rig.root,"agent.mjs");
  const stub=join(dirname(fileURLToPath(import.meta.url)),"../../driver-hsr/test-agent/agent.mjs");
  writeFileSync(agent,`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(receipt)},JSON.stringify({yes:process.env.npm_config_yes,offline:process.env.npm_config_offline,cell:process.env.HIVE_CELL}));await import(${JSON.stringify(pathToFileURL(stub).href)});`);
  const driver=composeCellHost({cellsRoot:rig.cellsRoot,nodeKind:"workstation",disableCow:true,
    resolveCell:()=>({sandbox:false,provision:{beeId:"bee",originRepo:rig.origin.repo,sha:rig.origin.sha,wrapper:"bee",repoName:"fixture",cellId:"cell"}})},
    {runtimeIdentity:fixtureRuntimeIdentity(rig.root),sessionLogDir:join(rig.root,"logs"),stopKillGraceMs:100,
    resolveHarness:()=>({adapter:stubAdapter,command:process.execPath,args:[agent],env:{PATH:dirname(process.execPath)+":/usr/bin:/bin",HOME:rig.root,npm_config_yes:"true",STUB_TURN_MS:"5"}})});
  try {
    driver.start("bee",1);
    const deadline=Date.now()+10000;
    for(;;){if(driver.observe().some(event=>event.kind==="booted"))break;assert.ok(Date.now()<deadline,"fixture boot timed out");await new Promise(resolve=>setTimeout(resolve,10));}
    const env=JSON.parse(readFileSync(receipt,"utf8"));
    assert.equal(env.yes,"false");
    assert.equal(env.offline,undefined);
    assert.equal(env.cell,"1");
  } finally {driver.disposeAll();await new Promise(resolve=>setTimeout(resolve,100));rig.cleanup();}
});
