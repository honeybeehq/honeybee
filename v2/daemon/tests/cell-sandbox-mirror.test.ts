import { test } from "node:test";
import assert from "node:assert/strict";
import type { CellRow } from "../../core/src/types.ts";
import { mirrorCellSandbox } from "../src/cellSandboxPolicy.ts";

test("mirrored Cell policy is a resolved boolean without changing the stored override", () => {
  for (const kind of ["workstation", "satellite", "cloud"] as const) {
    for (const configured of [null, false, true]) {
      for (const override of [null, false, true]) {
        const cell = {sandbox: override} as CellRow;
        const mirrored = mirrorCellSandbox(cell, kind, configured);
        assert.equal(mirrored.effectiveSandbox, override ?? configured ?? kind === "satellite");
        assert.equal(mirrored.sandbox, override);
        assert.equal(Object.hasOwn(cell, "effectiveSandbox"), false);
      }
    }
  }
});
