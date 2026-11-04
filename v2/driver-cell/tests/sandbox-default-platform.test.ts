import assert from "node:assert/strict";
import { test } from "node:test";
import { sandboxDefaultFor, sandboxEnabled, NODE_KINDS } from "../src/sandbox.ts";

test("Cell sandbox defaults exempt Darwin satellites and fail closed on unknown platforms", () => {
  for (const os of ["darwin", "linux", "unknown-future-platform"]) for (const kind of NODE_KINDS) {
    const expected = kind === "satellite" && os !== "darwin";
    assert.equal(sandboxDefaultFor(kind, os), expected);
    for (const override of [null, undefined]) assert.equal(sandboxEnabled(kind, override, os), expected);
    assert.equal(sandboxEnabled(kind, true, os), true);
    assert.equal(sandboxEnabled(kind, false, os), false);
  }
});

test("Cell sandbox default matches this native runner", () => {
  assert.equal(sandboxDefaultFor("satellite"), process.platform !== "darwin");
  assert.equal(sandboxEnabled("satellite", null), process.platform !== "darwin");
});
