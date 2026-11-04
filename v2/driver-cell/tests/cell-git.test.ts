import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { readFileSync, writeFileSync, renameSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { cellGit, withCellGit, CellGitRefused, type CellGitIdentity } from "../src/cellGit.ts";
import { provisionCell } from "../src/provision.ts";
import { g, makeRig } from "./helpers.ts";

function fixture() {
  const rig = makeRig();
  const cell = provisionCell(rig.cellsRoot, { beeId: "bee", originRepo: rig.origin.repo, sha: rig.origin.sha, wrapper: "bee", repoName: "fixture", cellId: "cell" }, "cmd", { disableCow: true });
  const identity: CellGitIdentity = { cellsRoot: rig.cellsRoot, wrapper: "bee", spaceDir: cell.paths.spaceDir, sandboxed: true, independentInodes: true };
  identity.wrapper = cell.paths.wrapperDir.slice(rig.cellsRoot.length + 1);
  return {rig, identity, git: join(identity.spaceDir, ".git")};
}

test("Cell Git uses trusted context and retains ordinary operations", () => {
  const {rig, identity} = fixture();
  try {
    writeFileSync(join(identity.spaceDir,".git/config"), readFileSync(join(identity.spaceDir,".git/config"),"utf8") + '\n[remote "origin.mirror"]\nurl = file:///fixture\nfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main.topic"]\nremote = origin.mirror\nmerge = refs/heads/main\n[filter "lfs"]\nclean = false\nsmudge = false\nprocess = false\nrequired = true\n[commit]\ngpgsign = true\n[user]\nsigningkey = fixture\n[core]\neditor = false\npager = false\n');
    assert.equal(cellGit(identity, ["rev-parse", "HEAD"]).stdout.trim(), rig.origin.sha);
    assert.equal(cellGit(identity, ["status", "--porcelain"]).status, 0);
    assert.equal(cellGit({...identity, sandboxed:false, independentInodes:false}, ["rev-list", "HEAD"]).status, 0);
    assert.throws(() => cellGit({...identity, independentInodes:false}, ["rev-list", "HEAD"]), CellGitRefused);
    assert.throws(() => cellGit({...identity, wrapper:"another"}, ["rev-parse", "HEAD"]), CellGitRefused);
    assert.throws(() => cellGit(identity, ["-C", rig.origin.repo, "status"]), CellGitRefused);
    assert.throws(() => cellGit(identity, ["status"], {timeoutMs:0}), CellGitRefused);
  } finally {rig.cleanup();}
});

test("Cell Git refuses repository indirection and executable configuration", () => {
  for (const mutation of ["pointer", "symlink", "commondir", "alternates", "include", "uploadpack"]) {
    const {rig, identity, git} = fixture();
    try {
      if (mutation === "pointer") {renameSync(git, git+"-saved");writeFileSync(git, `gitdir: ${git}-saved\n`);}
      if (mutation === "symlink") {renameSync(git, git+"-saved");symlinkSync(git+"-saved",git);}
      if (mutation === "commondir") writeFileSync(join(git,"commondir"),"../other\n");
      if (mutation === "alternates") writeFileSync(join(git,"objects/info/alternates"),join(rig.origin.repo,".git/objects")+"\n");
      if (mutation === "include") writeFileSync(join(git,"config"),readFileSync(join(git,"config"),"utf8")+'\n[include]\npath = /dev/null\n');
      if (mutation === "uploadpack") writeFileSync(join(git,"config"),readFileSync(join(git,"config"),"utf8")+'\n[remote "fixture"]\nuploadpack = false\n');
      assert.throws(() => cellGit(identity,["rev-list","HEAD"]), CellGitRefused, mutation);
    } finally {rig.cleanup();}
  }
});

test("Cell Git detects directory replacement at its operation fence", () => {
  const {rig, identity, git} = fixture();
  try {
    assert.throws(() => withCellGit(identity, () => {const objects=join(git,"objects");renameSync(objects,objects+"-saved");mkdirSync(objects);}), CellGitRefused);
  } finally {rig.cleanup();}
});


test("unconfined linked worktrees proceed and unknown config reports a warning", () => {
  const {rig, identity} = fixture();
  try {
    rmSync(identity.spaceDir,{recursive:true});
    g(rig.origin.repo,["worktree","add","--detach",identity.spaceDir,rig.origin.sha]);
    const warnings: string[] = [];
    const trusted = {...identity,sandboxed:false,independentInodes:false,onWarning:(message:string)=>warnings.push(message)};
    writeFileSync(join(rig.origin.repo,".git/config"),readFileSync(join(rig.origin.repo,".git/config"),"utf8")+'\n[fixture]\nunknown = true\n');
    assert.equal(cellGit(trusted,["rev-parse","HEAD"]).stdout.trim(),rig.origin.sha);
    assert.ok(warnings.length>0);
    assert.throws(()=>cellGit(identity,["rev-parse","HEAD"]),CellGitRefused);
  } finally {rig.cleanup();}
});

test("missing objects refuse without changing refs or attempting hydration", () => {
  const {rig, identity,git} = fixture();
  try {
    const head = join(git,"HEAD"), missing="a".repeat(40)+"\n";
    writeFileSync(head,missing);
    const result=cellGit(identity,["rev-list","HEAD"]);
    assert.notEqual(result.status,0);
    assert.equal(result.missingObjects,true);
    assert.equal(readFileSync(head,"utf8"),missing);
  } finally {rig.cleanup();}
});


test("sandboxed control indirection must be absent even when empty", () => {
  for (const file of ["commondir","objects/info/alternates","objects/info/http-alternates","config.worktree"]) {
    const {rig,identity,git}=fixture();
    try {writeFileSync(join(git,file),"");assert.throws(()=>cellGit(identity,["rev-list","HEAD"]),CellGitRefused);}
    finally {rig.cleanup();}
  }
});

test("Cell Git rejects asynchronous operation callbacks", () => {
  const {rig,identity}=fixture();
  try {assert.throws(()=>withCellGit(identity,()=>Promise.resolve("done")),CellGitRefused);}
  finally {rig.cleanup();}
});


test("sandboxed submodule context refuses and unconfined paths cannot escape", () => {
  const {rig,identity}=fixture();
  try {
    assert.throws(()=>cellGit(identity,["rev-parse","HEAD"],{submodulePath:"vendor/lib"}),CellGitRefused);
    assert.throws(()=>cellGit({...identity,sandboxed:false},["rev-parse","HEAD"],{submodulePath:"../other"}),CellGitRefused);
  } finally {rig.cleanup();}
});

test("Cell Git disables transport except an explicit local-file operation",()=>{
  const {rig,identity}=fixture();
  try {
    g(rig.origin.repo,["commit","--allow-empty","-m","next fixture"]);
    const next=g(rig.origin.repo,["rev-parse","HEAD"]);
    const refused=cellGit(identity,["fetch","--no-tags",rig.origin.repo,next]);
    assert.notEqual(refused.status,0);
    assert.match(refused.stderr,/transport.*not allowed/i);
    const allowed=cellGit(identity,["fetch","--no-tags",rig.origin.repo,next],{allowFileTransport:true});
    assert.equal(allowed.status,0);
    assert.equal(cellGit(identity,["rev-parse","HEAD"]).stdout.trim(),rig.origin.sha);
  } finally {rig.cleanup();}
});
