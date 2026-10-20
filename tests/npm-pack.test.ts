import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseNpmPackResult } from "../src/npmPack.js";

const packed = { name: "honeybee", version: "0.0.1", filename: "honeybee-0.0.1.tgz", files: [{ path: "package.json", size: 12, mode: 420 }] };

test("npm pack accepts the npm 11 array and npm 12 package-name object", () => {
  for (const output of [[packed], { honeybee: packed }]) {
    assert.deepEqual(parseNpmPackResult(JSON.stringify(output), "honeybee"), {
      name: "honeybee", filename: packed.filename, files: [{ path: "package.json" }],
    });
  }
});

test("npm pack refuses unsupported, mixed and multiple result records", () => {
  for (const output of [null, false, [], [packed, packed], packed, { 0: packed },
    { honeybee: packed, error: {} }, { other: packed }, [{ ...packed, name: "other" }],
    [{ ...packed, version: null }], [{ ...packed, filename: "other-0.0.1.tgz" }],
    { honeybee: [packed] }, [{ ...packed, filename: "../bad.tgz" }],
    [{ ...packed, filename: "bad\\name.tgz" }], [{ ...packed, filename: "bad\n.tgz" }],
    [{ ...packed, files: [] }], [{ ...packed, files: [{ path: "../escape" }] }],
    [{ ...packed, files: [{ path: "/absolute" }] }], [{ ...packed, files: [null] }],
    [{ ...packed, files: [{ path: "package.json" }, { path: "package.json" }] }]]) {
    assert.throws(() => parseNpmPackResult(JSON.stringify(output), "honeybee"));
  }
  assert.throws(() => parseNpmPackResult("not JSON", "honeybee"));
});

test("npm toolchain declares npm 11 and an error on major-version drift", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(manifest.packageManager, "npm@11.16.0");
  assert.deepEqual(manifest.devEngines.packageManager, { name: "npm", version: ">=11 <12", onFail: "error" });
});
