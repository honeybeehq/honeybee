import {readFileSync, realpathSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {legacyProcessCandidate, inspectProcess, sameProcess, type ProcessIdentity} from "./psutil.ts";

const sourceEntry = fileURLToPath(new URL("./runner-host-main.ts", import.meta.url));

/** Generation evidence only; the caller must also authenticate the socket peer. */
export function legacyRunnerArgvMatches(argv: string[], configPath: string): boolean {
  const args = argv.slice(1);
  if (args[0] === "--experimental-strip-types") args.shift();
  if (args.length !== 2 || args[1] !== configPath) return false;
  return args[0] === sourceEntry || /^\/.*\/lib\/node_modules\/honeybee\/dist\/v2\/runner-host\.js$/.test(args[0]!);
}

export function legacyRunnerCommandProof(identity: ProcessIdentity, stamp: number, configPath: string, statusPath: string): boolean {
  if (process.platform !== "linux") return false;
  try {
    if (readFileSync(statusPath, "utf8").length !== 0) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  const before = legacyProcessCandidate(identity.pid, stamp);
  if (!before || !sameProcess(identity, before)) return false;
  try {
    // Never read environ. Exact argv is independently tied to the birth before
    // and after this read, then to the connected peer by SO_PEERCRED.
    const raw = readFileSync(`/proc/${identity.pid}/cmdline`, "utf8");
    if (!raw.endsWith("\0")) return false;
    const argv = raw.slice(0, -1).split("\0");
    if (realpathSync(`/proc/${identity.pid}/exe`) !== realpathSync(argv[0]!)) return false;
    return legacyRunnerArgvMatches(argv, configPath) && sameProcess(identity, inspectProcess(identity.pid));
  } catch { return false; }
}
