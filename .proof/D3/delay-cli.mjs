import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
const original = cp.execFile;
function delayedExecFile(...args) { return original(...args); }
delayedExecFile[promisify.custom] = (...args) => new Promise((resolve, reject) => {
 const commandArgs = args[1];
 const delay = Array.isArray(commandArgs) && commandArgs.includes("credentials") && commandArgs[3] === "refresh" ? 2200 : 0;
 original(...args, (error, stdout, stderr) => {
  const done = () => error ? reject(error) : resolve({ stdout, stderr });
  if (delay) setTimeout(done, delay); else done();
 });
});

cp.execFile = delayedExecFile;
syncBuiltinESMExports();
