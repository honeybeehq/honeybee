import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(new URL("..", import.meta.url).pathname);
const { seatbeltProfile, defaultWritablePaths, defaultScratchPaths } = await import(pathToFileURL(join(root, "v2/driver-cell/src/sandbox.ts")).href);

const configPath = process.argv[2];
if (!configPath) {
  console.error("usage: node --experimental-strip-types scripts/sandbox-trace.mjs <config.json>");
  process.exit(2);
}
const config = JSON.parse(readFileSync(configPath, "utf8"));
if (process.platform !== "darwin") {
  console.error("sandbox-trace runs on darwin only");
  process.exit(2);
}

const home = homedir();
const work = resolve(config.workDir ?? join(home, ".cache", "honeybee-trace"));
mkdirSync(work, { recursive: true });
const confstr = (name) => spawnSync("getconf", [name], { encoding: "utf8" }).stdout.trim().replace(/\/$/, "");
const darwinDirs = { DARWIN_USER_TEMP_DIR: confstr("DARWIN_USER_TEMP_DIR"), DARWIN_USER_CACHE_DIR: confstr("DARWIN_USER_CACHE_DIR") };

function scratchFor(mode) {
  if (Array.isArray(mode)) return mode;
  if (mode === "current") return defaultScratchPaths("darwin");
  if (mode === "legacy") return ["/tmp", "/private/tmp", "/private/var/tmp", "/private/var/folders", "/dev"];
  if (mode === "none") return ["/dev"];
  if (mode === "shared-tmp") return ["/tmp", "/private/tmp", "/private/var/tmp", "/dev"];
  return defaultScratchPaths("darwin");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const denies = [];
const logProc = spawn("log", ["stream", "--style", "ndjson", "--level", "debug", "--predicate", '(sender == "Sandbox") OR (eventMessage CONTAINS "deny(")'], { stdio: ["ignore", "pipe", "inherit"] });
let buffer = "";
logProc.stdout.setEncoding("utf8");
logProc.stdout.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    try {
      const event = JSON.parse(line);
      const message = String(event.eventMessage ?? "");
      const match = /^(?:Sandbox: )?(\S+)\((\d+)\) deny\(\d+\) (\S+) (.*)$/.exec(message);
      if (match) denies.push({ at: Date.now(), proc: match[1], pid: Number(match[2]), op: match[3], target: match[4] });
    } catch {}
  }
});
await sleep(1500);

const report = { host: spawnSync("hostname", { encoding: "utf8" }).stdout.trim(), darwinDirs, runs: [] };
for (const run of config.runs) {
  const runDir = join(work, run.name);
  const cellDir = join(runDir, "cell");
  const beeTmp = join(runDir, "tmp");
  const compileCache = join(work, "node-compile-cache");
  for (const dir of [cellDir, beeTmp, compileCache]) mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: cellDir });
  const writablePaths = [
    ...defaultWritablePaths(home),
    realpathSync(beeTmp),
    realpathSync(compileCache),
    ...(run.extraWritable ?? config.extraWritable ?? []),
  ];
  const scratchPaths = scratchFor(run.scratch ?? config.scratch).map((p) => String(p).replaceAll("${DARWIN_USER_TEMP_DIR}", darwinDirs.DARWIN_USER_TEMP_DIR));
  const profilePath = join(runDir, "profile.sb");
  writeFileSync(profilePath, seatbeltProfile({ cellDir, writablePaths, scratchPaths }));
  const beeTmpReal = realpathSync(beeTmp);
  const fill = (value) => String(value).replaceAll("${BEE_TMP}", beeTmpReal).replaceAll("${DARWIN_USER_TEMP_DIR}", darwinDirs.DARWIN_USER_TEMP_DIR);
  const env = { ...process.env, ...Object.fromEntries(Object.entries(run.env ?? {}).map(([k, v]) => [k, fill(v)])), TMPDIR: beeTmpReal, NODE_COMPILE_CACHE: realpathSync(compileCache) };
  const started = Date.now();
  const result = await new Promise((done) => {
    const child = spawn("sandbox-exec", ["-f", profilePath, ...run.argv.map((a) => String(a).replaceAll("${BEE_TMP}", beeTmpReal))], { cwd: cellDir, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), (run.timeoutSec ?? 240) * 1000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      done({ code, signal, stdout, stderr });
    });
  });
  await sleep(2500);
  const ended = Date.now();
  const window = denies.filter((d) => d.at >= started && d.at <= ended);
  const grouped = new Map();
  for (const d of window) {
    const key = `${d.op} ${d.target}`;
    grouped.set(key, { op: d.op, target: d.target, proc: d.proc, count: (grouped.get(key)?.count ?? 0) + 1 });
  }
  report.runs.push({
    name: run.name,
    argv: run.argv,
    scratchPaths,
    exitCode: result.code,
    signal: result.signal,
    durationMs: ended - started,
    stdoutTail: result.stdout.slice(-1500),
    stderrTail: result.stderr.slice(-1500),
    writeDenies: [...grouped.values()].filter((d) => d.op.startsWith("file-write")),
    otherDenies: [...grouped.values()].filter((d) => !d.op.startsWith("file-write")).slice(0, 50),
  });
  console.error(`${run.name}: exit=${result.code} writeDenies=${report.runs.at(-1).writeDenies.length}`);
}
logProc.kill();
const out = config.out ?? join(work, "report.json");
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(out);
