import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDaemon } from "../src/daemon.ts";
import { sandboxEnabled } from "../../driver-cell/src/sandbox.ts";
import { deliveryContentRoot } from "../src/multilineFallback.ts";

test("stored Cell and node overrides reach the platform-aware delivery policy", () => {
  const root=mkdtempSync(join(tmpdir(),"sandbox-callers-")),spaceDir=join(root,"fixture-space-cell");
  mkdirSync(spaceDir);
  const owner=Object.create(HiveDaemon.prototype) as {store:unknown;cfg:unknown;resolveCellSpec(id:string):{sandbox:boolean|null}};
  try {
    for(const configured of [null,false,true]) for(const cellOverride of [null,false,true]) {
      owner.cfg={cellSandbox:configured,cellRetention:{wipPushOnTurnEnd:false}};
      owner.store={getBee:()=>({cellId:"cell"}),getCell:()=>({id:"cell",state:"active",spaceName:"fixture-space-cell",spaceDir,wrapper:"fixture",originRepo:root,sha:"a".repeat(40),sandbox:cellOverride})};
      const selected=owner.resolveCellSpec("bee").sandbox;
      assert.equal(selected,cellOverride??configured);
      for(const os of ["darwin","linux","future-platform"]) {
        const enabled=sandboxEnabled("satellite",selected,os);
        assert.equal(enabled,cellOverride??configured??(os!=="darwin"));
        assert.equal(deliveryContentRoot("/tmp/data","cell",enabled,"/fixture/runtime",os as NodeJS.Platform),os==="linux"&&enabled?"/fixture/runtime":"/tmp/data");
      }
    }
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("Darwin namespace observation returns before store access", () => {
  const descriptor=Object.getOwnPropertyDescriptor(process,"platform")!;
  const owner=Object.create(HiveDaemon.prototype) as {stopping:boolean;store:unknown;observeCellRuntimeNamespace(id:string,pid:number|null):void};
  let reads=0;
  owner.stopping=false;owner.store=new Proxy({}, {get(){reads++;throw Error("unexpected store access");}});
  try {
    Object.defineProperty(process,"platform",{...descriptor,value:"darwin"});
    assert.doesNotThrow(()=>owner.observeCellRuntimeNamespace("fixture",null));
    assert.equal(reads,0);
  } finally {Object.defineProperty(process,"platform",descriptor);}
});
