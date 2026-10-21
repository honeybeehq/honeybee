import { createInterface } from "node:readline";
import { hostname } from "node:os";
import { join } from "node:path";
import { inspectProcess } from "../../../harness/src/processIdentity.ts";
import { BridgeEngine } from "./engine.ts";
import { BridgeState } from "./state.ts";
import { parseInput, type OutputFrame } from "./protocol.ts";
import { fakeSdk } from "./fake.ts";
import { realSdk } from "./sdk.ts";
import { assertStudio, PINNED_ACCOUNT, readPolicy, runtimeEnv, LaunchRefusal } from "./policy.ts";

const options = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) options.set(process.argv[i]!, process.argv[i + 1]!);
const emit = (frame: OutputFrame): void => { process.stdout.write(`${JSON.stringify(frame)}\n`); };
let state: BridgeState | undefined;
try {
  const home = options.get("--home"), beeId = options.get("--bee"), ownerNode = options.get("--node");
  const generation = Number(options.get("--generation"));
  if (!home || !beeId || !ownerNode || !Number.isSafeInteger(generation) || generation < 1) throw new Error("invalid_input");
  const fixture = options.get("--sdk") === "fixture";
  const policyPath = options.get("--policy");
  const policy = fixture ? null : readPolicy(policyPath ?? "");
  if (!fixture) assertStudio(process.platform, hostname(), options.get("--account") ?? null, options.get("--autoswap") === "false");
  const identity = inspectProcess(process.pid);
  if (identity.kind !== "present" && !fixture) throw new Error("state_error");
  state = new BridgeState(home, { ownerNode, beeId, generation, pid: process.pid, birth: identity.kind === "present" ? `${identity.bootId}:${identity.birth}` : `fixture:${process.pid}` });
  const env = policy ? runtimeEnv(process.env, options.get("--config-dir") ?? "", join(home, "tmp")) : {};
  if (policy && (!env.CLAUDE_CONFIG_DIR || options.get("--account") !== PINNED_ACCOUNT)) throw new Error("invalid_input");
  const engine = new BridgeEngine(state, policy ? realSdk(policy, env) : fakeSdk, policy?.identity ?? "You are a Champion, an assistant accountable to your owner.", emit);
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    clearInterval(watch);
    input.close();
    await engine.stop();
    state?.close();
    process.stdin.destroy();
  };
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const watch = setInterval(() => {
    if (!policyPath) return;
    try { readPolicy(policyPath); } catch { void close(); }
  }, 250);
  watch.unref();
  input.on("line", line => {
    try { engine.input(parseInput(line)); }
    catch { emit({ v: 1, type: "fatal", code: "invalid_input" }); void close(); process.exitCode = 1; }
  });
  input.on("close", () => { if (!closing) void engine.settled().then(close); });
  process.on("SIGTERM", () => { void close(); });
  process.on("SIGINT", () => { void close(); });
  engine.start();
} catch (error) {
  const code = error instanceof LaunchRefusal ? "launch_refused" : error instanceof Error && error.message === "writer_conflict" ? "writer_conflict" : "state_error";
  emit({ v: 1, type: "fatal", code });
  state?.close();
  process.exitCode = 1;
}
