import { tsImport } from "tsx/esm/api";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

await promisify(execFile)(process.execPath, ["scripts/build-tests.mjs"]);
await tsImport("./guard-live-rpc.lab.ts", import.meta.url);
await import("../.test-dist/tests/deploy-runtime.test.js");
await import("../.test-dist/tests/deploy-artifact.test.js");
