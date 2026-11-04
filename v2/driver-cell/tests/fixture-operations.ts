import { readdirSync } from "node:fs";
import { join } from "node:path";
import * as wip from "../src/wip.ts";
import * as remove from "../src/remove.ts";
import * as landed from "../src/landed.ts";
import {fixtureCellGit} from "./helpers.ts";
export * from "../src/wip.ts";
export * from "../src/remove.ts";
export * from "../src/landed.ts";

function identityForWrapper(wrapper:string) {
  try {const name=readdirSync(wrapper).find(name=>name.includes("-space-"));return name?fixtureCellGit(join(wrapper,name)):undefined;}catch{return undefined;}
}
export const dirtyReport: typeof remove.dirtyReport=(wrapper,opts={})=>remove.dirtyReport(wrapper,{...opts,cellGit:opts.cellGit??identityForWrapper(wrapper)});
export const dirtyReportDetailed: typeof remove.dirtyReportDetailed=(wrapper,opts={})=>remove.dirtyReportDetailed(wrapper,{...opts,cellGit:opts.cellGit??identityForWrapper(wrapper)});
export const deleteCell: typeof remove.deleteCell=(wrapper,opts={})=>remove.deleteCell(wrapper,{...opts,cellGit:opts.cellGit??identityForWrapper(wrapper)});
export const submodulesWithLocalState: typeof remove.submodulesWithLocalState=(space,identity)=>remove.submodulesWithLocalState(space,identity??fixtureCellGit(space));
export const snapshotWip: typeof wip.snapshotWip=(space,box,id,now,max,identity)=>wip.snapshotWip(space,box,id,now,max,identity??fixtureCellGit(space));
export const operationInProgress: typeof wip.operationInProgress=(space,identity)=>wip.operationInProgress(space,identity??fixtureCellGit(space));
export const pushWip: typeof wip.pushWip=(origin,space,node,id,sha,timeout,identity)=>wip.pushWip(origin,space,node,id,sha,timeout,identity??fixtureCellGit(space));
export const restoreWip: typeof wip.restoreWip=(space,origin,node,id,sha,identity)=>wip.restoreWip(space,origin,node,id,sha,identity??fixtureCellGit(space));
export const unlandedCommitsByTip: typeof landed.unlandedCommitsByTip=req=>landed.unlandedCommitsByTip({...req,cellGit:req.cellGit??fixtureCellGit(req.spaceDir)});
export const describeCommits: typeof landed.describeCommits=(space,shas,identity)=>landed.describeCommits(space,shas,identity??fixtureCellGit(space));
import * as retention from "../src/retention.ts";
export * from "../src/retention.ts";
export const classifyIgnored: typeof retention.classifyIgnored=(space,patterns,identity)=>retention.classifyIgnored(space,patterns,identity??fixtureCellGit(space));
export const listIgnoredEnvFiles: typeof retention.listIgnoredEnvFiles=(space,identity)=>retention.listIgnoredEnvFiles(space,identity??fixtureCellGit(space));
export const preserveEnvFiles: typeof retention.preserveEnvFiles=(root,space,files)=>retention.preserveEnvFiles(root,space,files??listIgnoredEnvFiles(space));
export const inspectCellWrapper: typeof retention.inspectCellWrapper=(wrapper,opts={})=>retention.inspectCellWrapper(wrapper,{...opts,cellGit:opts.cellGit??identityForWrapper(wrapper)});
export const evictCellWrapper: typeof retention.evictCellWrapper=(root,wrapper,opts={})=>retention.evictCellWrapper(root,wrapper,{...opts,cellGit:opts.cellGit??identityForWrapper(wrapper)});
export const verifyParkPaths: typeof retention.verifyParkPaths=(wrapper,paths,mode,opts={})=>retention.verifyParkPaths(wrapper,paths,mode,{...opts,cellGit:opts.cellGit??identityForWrapper(wrapper)});
export const verifyTrimPaths: typeof retention.verifyTrimPaths=(wrapper,paths,opts={})=>retention.verifyTrimPaths(wrapper,paths,{...opts,cellGit:opts.cellGit??identityForWrapper(wrapper)});
export const planParkPaths: typeof retention.planParkPaths=(wrapper,mode,opts={})=>retention.planParkPaths(wrapper,mode,{...opts,cellGit:opts.cellGit??identityForWrapper(wrapper)});
export const parkCellWrapper: typeof retention.parkCellWrapper=(root,wrapper,mode,opts={})=>retention.parkCellWrapper(root,wrapper,mode,{...opts,cellGit:opts.cellGit??identityForWrapper(wrapper)});
export const trimCellWrapper: typeof retention.trimCellWrapper=(root,wrapper,paths,opts={})=>retention.trimCellWrapper(root,wrapper,paths,{...opts,cellGit:opts.cellGit??identityForWrapper(wrapper)});
