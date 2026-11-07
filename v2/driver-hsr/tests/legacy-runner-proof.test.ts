import assert from "node:assert/strict";
import {test} from "node:test";
import {fileURLToPath} from "node:url";
import {legacyRunnerArgvMatches, legacyRunnerCommandProof} from "../src/legacyRunnerProof.ts";
import {inspectProcess} from "../src/psutil.ts";

const entry = fileURLToPath(new URL("../src/runner-host-main.ts", import.meta.url));
const config = "/fixture/runners/bee.11.json";
test("legacy generation argv evidence rejects other generations, wrappers, flags and trailing arguments", () => {
  assert.equal(legacyRunnerArgvMatches([process.execPath, "--experimental-strip-types", entry, config], config), true);
  const installed = "/fixture/runtime/old/lib/node_modules/honeybee/dist/v2/runner-host.js";
  assert.equal(legacyRunnerArgvMatches([process.execPath, installed, config], config), true);
  for (const argv of [
    [process.execPath, entry, "/fixture/runners/bee.12.json"],
    [process.execPath, "/untrusted/runner-host.js", config],
    [process.execPath, "-e", entry, config],
    [process.execPath, entry, config, "extra"],
    [process.execPath, installed, config + ".extra"],
  ]) assert.equal(legacyRunnerArgvMatches(argv, config), false);
});
test("a live unrelated process cannot supply runner generation evidence", () => {
  const value = inspectProcess(process.pid); assert.equal(value.kind, "present");
  if (value.kind !== "present") return;
  assert.equal(legacyRunnerCommandProof(value, value.startedAtMs, config, "/nonexistent-status"), false);
  assert.equal(legacyRunnerCommandProof({...value, birth: "linux:1"}, value.startedAtMs, config, "/nonexistent-status"), false);
  assert.equal(legacyRunnerCommandProof(value, value.startedAtMs - 5001, config, "/nonexistent-status"), false);
});
