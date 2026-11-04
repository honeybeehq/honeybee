import assert from "node:assert/strict";
import {test} from "node:test";
import {tryGit,revParse,hasCommit} from "../src/git.ts";
import {confirmWip,wipRefFor} from "../src/wip.ts";
import {describeCommits,unlandedCommitsByTip} from "./fixture-operations.ts";
import {g,makeRig} from "./helpers.ts";

test("missing Git object probes stay nonthrowing and preserve conservative results",()=>{
  const rig=makeRig(),missing="a".repeat(40);
  try {
    assert.equal(revParse(rig.origin.repo,"refs/heads/absent"),null);
    assert.equal(hasCommit(rig.origin.repo,missing),false);
    const result=tryGit(rig.origin.repo,["rev-list",missing]);
    assert.notEqual(result.status,0);
    assert.equal(result.missingObjects,true);
    assert.deepEqual(describeCommits(rig.origin.repo,[missing]),[{sha:missing,subject:""}]);
    assert.deepEqual(unlandedCommitsByTip({spaceDir:rig.origin.repo,originRepo:rig.origin.repo,tips:[missing],base:null}).get(missing),[missing]);
    const blob=tryGit(rig.origin.repo,["hash-object","-w","--stdin"],{input:"fixture blob"}).stdout.trim();
    g(rig.origin.repo,["update-ref",wipRefFor("fixture","cell"),blob]);
    assert.equal(confirmWip(rig.origin.repo,"fixture","cell",blob),false);
  } finally {rig.cleanup();}
});
