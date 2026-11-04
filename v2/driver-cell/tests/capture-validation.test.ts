import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { captureWork } from "../src/capture.ts";
import { provisionCell } from "../src/provision.ts";
import { commitInCell, fingerprintOrigin, g, makeRig } from "./helpers.ts";

function placeObject(repo: string, hash: string, object: Buffer): void {
  const path = join(repo, ".git", "objects", hash.slice(0, 2), hash.slice(2));
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.fixture`;
  writeFileSync(temporary, deflateSync(object), { flag: "wx" });
  renameSync(temporary, path);
}

for (const variant of ["existing_blob", "new_blob", "malformed_commit", "destination_blob"] as const) {
  test(`capture.validation: ${variant} refuses with unchanged refs`, () => {
    const rig = makeRig();
    try {
      const cell = provisionCell(rig.cellsRoot, { beeId: "bee", originRepo: rig.origin.repo, sha: rig.origin.sha, wrapper: "bee", repoName: "fixture", cellId: "cell" }, "cmd", { disableCow: true });
      const space = cell.paths.spaceDir;
      const work = commitInCell(space, "work.txt", "work\n", "work");
      g(rig.origin.repo, ["branch", "target", rig.origin.sha]);
      const before = fingerprintOrigin(rig.origin.repo);
      if (variant === "existing_blob" || variant === "destination_blob") {
        const hash = g(space, ["rev-parse", "HEAD:README.md"]);
        placeObject(variant === "existing_blob" ? space : rig.origin.repo, hash, Buffer.from("blob 7\0altered"));
        if (variant === "existing_blob") assert.equal(g(rig.origin.repo, ["cat-file", "-p", hash]), "# fixture");
      } else if (variant === "new_blob") {
        placeObject(space, g(space, ["rev-parse", "HEAD:work.txt"]), Buffer.from("blob 7\0altered"));
      } else {
        const body = Buffer.from(`tree ${g(space, ["rev-parse", "HEAD^{tree}"])}\nparent ${work}\nauthor Invalid\ncommitter Invalid\n\nfixture\n`);
        const object = Buffer.concat([Buffer.from(`commit ${body.length}\0`), body]);
        const hash = createHash("sha1").update(object).digest("hex");
        placeObject(space, hash, object);
        g(space, ["update-ref", "--no-deref", "HEAD", hash]);
      }
      const result = captureWork({ originRepo: rig.origin.repo, cellSpaceDir: space, targetBranch: "target", mode: "merge", opId: variant });
      assert.equal(result.status, "refused");
      assert.equal(result.reason, "invalid_objects");
      assert.deepEqual(fingerprintOrigin(rig.origin.repo), before);
      assert.equal(g(rig.origin.repo, ["for-each-ref", "--format=%(refname)", "refs/hive/capture"]), "");
    } finally { rig.cleanup(); }
  });
}
