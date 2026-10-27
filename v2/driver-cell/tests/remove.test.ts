/**
 * Spec 05 test tier 1 — dirty-cell delete + --force (A2), shape-checked
 * paths, ENOTEMPTY retry.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureWork } from "../src/capture.ts";
import { readLedger, writeLedger } from "../src/ledger.ts";
import { provisionCell } from "../src/provision.ts";
import { CellBackupRequiredError, CellDeleteRefused, CellShapeError, deleteCell, dirtyReport } from "../src/remove.ts";
import { commitInCell, makeRig } from "./helpers.ts";

function provisioned(rig: ReturnType<typeof makeRig>, beeId = "bee-1", cellId = "c1") {
  return provisionCell(
    rig.cellsRoot,
    {
      beeId,
      originRepo: rig.origin.repo,
      sha: rig.origin.sha,
      wrapper: beeId,
      repoName: "fixture",
      cellId,
    },
    "cmd-1",
    { disableCow: true },
  );
}

for(const scenario of ["clean","uncommitted","unpushed","landed","origin-gone","half-provisioned"]){
  test("delete owner authority is required for "+scenario+" even with force",()=>{
    const rig=makeRig();try{
      const cell=provisioned(rig);
      if(scenario==="uncommitted")writeFileSync(join(cell.paths.spaceDir,"wip.ts"),"unique work");
      if(scenario==="unpushed"||scenario==="landed")commitInCell(cell.paths.spaceDir,"work.ts","work","unique commit");
      if(scenario==="landed")assert.equal(captureWork({originRepo:rig.origin.repo,cellSpaceDir:cell.paths.spaceDir,targetBranch:"work",mode:"merge",opId:"land"}).status,"landed");
      if(scenario==="origin-gone"){const ledger=readLedger(cell.paths.ledgerPath)!;ledger.origin=join(rig.root,"gone");writeLedger(cell.paths.ledgerPath,ledger);assert.equal(dirtyReport(cell.paths.wrapperDir).originUnknown,true);}
      for(const force of [false,true])assert.throws(()=>deleteCell(cell.paths.wrapperDir,{force}),CellBackupRequiredError);
      assert.ok(existsSync(cell.paths.spaceDir));
    }finally{rig.cleanup();}
  });
}
test("delete never grants authority for arbitrary or absent paths",()=>{
  const rig=makeRig();try{for(const path of [rig.origin.repo,join(rig.root,"absent")])assert.throws(()=>deleteCell(path,{force:true}),CellBackupRequiredError);assert.ok(existsSync(rig.origin.repo));}finally{rig.cleanup();}
});
