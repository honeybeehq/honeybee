import { spawn } from "node:child_process";
import { testConcurrency, testEnv } from "./test-env.mjs";
import { signalExitCode, terminateTestProcessTree } from "./test-process-control.mjs";

const args = process.argv.slice(2);
if (args.length === 0) throw new Error("Expected Node test file patterns");
const concurrency = testConcurrency();
console.error(`node test file concurrency=${concurrency}`);
const child = spawn(process.execPath, ["--test", `--test-concurrency=${concurrency}`, ...args], {
  stdio: "inherit",
  detached: process.platform !== "win32",
  env: testEnv(),
});
let requestedSignal;
let termination;
const forward = signal => {
  requestedSignal ??= signal;
  termination ??= terminateTestProcessTree(child, signal);
};
const interrupt = () => forward("SIGINT");
const terminate = () => forward("SIGTERM");
const hangup = () => forward("SIGHUP");
process.once("SIGINT", interrupt);
process.once("SIGTERM", terminate);
process.once("SIGHUP", hangup);
const result = await new Promise(resolve => {
  child.once("error", error => resolve({ error }));
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
process.removeListener("SIGINT", interrupt);
process.removeListener("SIGTERM", terminate);
process.removeListener("SIGHUP", hangup);
if (termination) await termination;
if (result.error) throw result.error;
process.exitCode = requestedSignal ? signalExitCode(requestedSignal)
  : result.signal ? signalExitCode(result.signal) : result.code ?? 1;
