// Lab run: the REAL runner host and HSR driver start a stub agent through the prototype wrapper.
// The agent writes a literal /tmp path and starts processes that leave its process group; then driver.stop().
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stubAdapter } from "../../../v2/adapters/src/index.ts";
import { RuntimeHost, type SpawnSpec } from "../../../v2/driver-hsr/src/index.ts";
import { defaultWritablePaths } from "../../../v2/driver-cell/src/sandbox.ts";
import { confinedSessionArgs, openSessionArgs } from "./sessionScratch.ts";

const LAB = process.env.LAB!;
const STUB = join(import.meta.dirname, "../../../v2/driver-cell/test-agent/agent.mjs");
const TAG = String(process.pid % 9000 + 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const survivors = (n: string) => Number(spawnSync("pgrep", ["-fc", `sleep 6${TAG}${n}[0-9]`], { encoding: "utf8" }).stdout.trim() || "0");

async function run(mode: "today" | "open" | "confined", n: string): Promise<void> {
  const root = join(LAB, mode);
  const scratch = join(root, "tmp", "bee-1");
  const cell = join(root, "cell");
  const socketDir = process.env.SOCK_DIR ?? join(root, "run");
  for (const d of [join(scratch, ".var-tmp"), cell, socketDir, join(root, "logs")]) mkdirSync(d, { recursive: true });
  const env = { ...(process.env as Record<string, string>), HIVE_BEE_ID: "bee-1", TMPDIR: scratch, HIVE_SCRATCH: scratch };
  const plain: SpawnSpec = { adapter: stubAdapter, command: process.execPath, args: [STUB], cwd: cell, env };
  const s = { scratchDir: scratch, shmBytes: 64 * 1024 * 1024 };
  const spec: SpawnSpec =
    mode === "today" ? plain
    : mode === "open" ? { ...plain, command: "bwrap", args: openSessionArgs(s, plain.command, plain.args) }
    : { ...plain, command: "bwrap", args: confinedSessionArgs({ cellDir: root, writablePaths: defaultWritablePaths() }, s, plain.command, plain.args) };
  const driver = new RuntimeHost({ sessionLogDir: join(root, "logs"), socketDir, stopKillGraceMs: 1500, resolve: () => spec });
  const events: string[] = [];
  const drain = () => { for (const e of driver.observe()) events.push(e.kind); };
  driver.start("bee-1", 1);
  // today: the literal path would land in the host's shared /tmp, so the stub is told to use $TMPDIR (the floor that exists).
  const target = mode === "today" ? "$TMPDIR" : "/tmp";
  const body = `@sh echo captured > ${target}/literal.txt; echo "TMPDIR=$TMPDIR HIVE_SCRATCH=$HIVE_SCRATCH pid=$$" > ${target}/env.txt; (setsid nohup sleep 6${TAG}${n}1 >/dev/null 2>&1 &); setsid nohup sleep 6${TAG}${n}2 >/dev/null 2>&1 & nohup sleep 6${TAG}${n}3 >/dev/null 2>&1 & echo started`;
  const deadline = Date.now() + 20_000;
  let accepted = false;
  let mark = 0;
  let why = "";
  while (Date.now() < deadline && !(accepted && events.slice(mark).includes("turn_ended"))) {
    if (!accepted) { const o = driver.deliver("bee-1", 1, 1, body); accepted = o.accepted; why = JSON.stringify(o); if (accepted) mark = events.length; }
    await sleep(200); drain();
  }
  if (!accepted) console.log(`[${mode}] delivery never accepted: ${why}`);
  const sockets = readdirSync(socketDir);
  console.log(`[${mode}] turn: ${events.join(",")}`);
  console.log(`[${mode}] file on the owner's side: ${existsSync(join(scratch, "literal.txt")) ? join("<lab>", mode, "tmp/bee-1/literal.txt") : "MISSING"}`);
  console.log(`[${mode}] the session saw: ${existsSync(join(scratch, "env.txt")) ? readFileSync(join(scratch, "env.txt"), "utf8").trim().replaceAll(LAB, "<lab>") : "-"}`);
  console.log(`[${mode}] runner socket lives in: <lab>/${mode}/run/${sockets.join(",")} (daemon reaches it; it is not in any /tmp)`);
  console.log(`[${mode}] processes alive before stop: ${survivors(n)}`);
  if (process.env.DEBUG_LAB) for (const f of readdirSync(join(root, "logs"))) console.log(f, readFileSync(join(root, "logs", f), "utf8").slice(0, 1500));
  const hostPid = driver.snapshotLive().find((x: { beeId: string }) => x.beeId === "bee-1")?.pid;
  let how = "driver.stop()";
  try { driver.stop("bee-1", 1, "stopped_by_user"); }
  catch (e) {
    // The lab lane has no process-identity proof; send exactly what stop sends (driver.ts signalGroup): TERM to -hostPid, KILL after the grace.
    how = `stop's own signals by hand (driver.stop refused: ${(e as { code?: string }).code})`;
    process.kill(-hostPid!, "SIGTERM"); await sleep(1500); try { process.kill(-hostPid!, "SIGKILL"); } catch {}
  }
  for (let i = 0; i < 30 && !events.includes("exited"); i += 1) { await sleep(200); drain(); }
  await sleep(500);
  const left = survivors(n);
  console.log(`[${mode}] after ${how}: exited=${events.includes("exited")} survivors=${left}`);
  console.log(`[${mode}] left behind in the socket dir after a clean stop: ${readdirSync(socketDir).map((d) => `${d}/ (${readdirSync(join(socketDir, d)).length} entries)`).join(",") || "nothing"}`);
  spawnSync("pkill", ["-KILL", "-f", `sleep 6${TAG}${n}[0-9]`]);
  try { await driver.disposeAllAndWait?.(); } catch {}
}

console.log(`node ${process.version}; bwrap ${spawnSync("bwrap", ["--version"], { encoding: "utf8" }).stdout?.trim() ?? "absent"}`);
const modes = (process.env.MODES ?? "today,open,confined").split(",");
if (modes.includes("today")) await run("today", "1");
if (modes.includes("open")) await run("open", "2");
if (modes.includes("confined")) await run("confined", "3");
process.exit(0);
