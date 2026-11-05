// D3 lab: one scratch hived (started directly, stopped by its own pid) proves runtime.install,
// runtime.status and runtime.prune and their typed refusals. MODE=d3 runs a scratch build with the
// scratch key compiled in; MODE=envkey runs the committed build with HIVE_TEST_RELEASE_KEYS set and
// expects it ignored; MODE=baseline times the origin/main build.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const REPO = resolve(process.env.REPO ?? ".");
const DIST = resolve(process.env.CLI_DIST ?? join(REPO, "dist", "cli.js"));
const MODE = process.env.MODE ?? "d3";
const OUT = resolve(process.env.OUT ?? join(REPO, ".proof", "D3", `${MODE}-lab.jsonl`));
const ENV_KEY_HEX = process.env.ENV_KEY_HEX ?? "";
const ARCHIVE = process.env.ARCHIVE ? resolve(process.env.ARCHIVE) : "";
const DESCRIPTOR = process.env.DESCRIPTOR ? resolve(process.env.DESCRIPTOR) : "";
const SIGN = process.env.SIGN_SCRIPT ? resolve(process.env.SIGN_SCRIPT) : "";
const PRIVATE_KEY = process.env.PRIVATE_KEY ? resolve(process.env.PRIVATE_KEY) : "";
const STAGE = process.env.STAGE ? resolve(process.env.STAGE) : "";
const NODE = process.execPath;

const { RpcClient } = await import(join(REPO, "v2", "cli", "src", "client.ts"));
const { readLiveEndpointRecord } = await import(join(REPO, "v2", "daemon", "src", "endpointRecord.ts"));
const { artifactTreeDigest } = await import(join(REPO, "v2", "core", "src", "release", "strictUnpack.ts"));
const execFileAsync = promisify(execFile);

const runRoot = mkdtempSync("/var/tmp/hb-D3-");
const dataDir = join(runRoot, "v2");
const runtimeRoot = join(runRoot, "runtime");
const home = join(runRoot, "home");
for (const dir of [dataDir, home, join(runRoot, "tmp")]) mkdirSync(dir, { recursive: true });
writeFileSync(join(dataDir, "config.json"), JSON.stringify({ naming: { auto: false } }));
const lines = [];
const record = (entry) => { const row = { at: new Date().toISOString(), ...entry }; lines.push(row); writeFileSync(OUT, lines.map((l) => JSON.stringify(l)).join("\n") + "\n"); console.log(JSON.stringify(row)); };

const env = {
  PATH: process.env.PATH, HOME: home, TMPDIR: join(runRoot, "tmp"), NO_COLOR: "1", TERM: "dumb",
  HIVE_V2_DATA_DIR: dataDir, HIVE_NODE_PATH: NODE, HIVE_NO_KEYCHAIN: "1", HIVE_GATEWAYS_DISABLE: "1",
  HIVE_CLAUDE_USAGE_URL: "http://127.0.0.1:9/api/oauth/usage", HIVE_CLAUDE_PROFILE_URL: "http://127.0.0.1:9/api/oauth/profile",
  HIVE_CLAUDE_OAUTH_TOKEN_URL: "http://127.0.0.1:9/v1/oauth/token", HIVE_CODEX_OAUTH_TOKEN_URL: "http://127.0.0.1:9/oauth/token",
  HIVE_GROK_OAUTH_TOKEN_URL: "http://127.0.0.1:9/oauth/token", HIVE_TEST_META_URL: "http://127.0.0.1:9",
  ...(ENV_KEY_HEX ? { HIVE_TEST_RELEASE_KEYS: ENV_KEY_HEX } : {}),
};
const bootStarted = performance.now();
const daemon = spawn(NODE, [DIST, "v2", "daemon", "run", "--data-dir", dataDir], { env, stdio: ["ignore", "pipe", "pipe"] });
let daemonOut = "";
daemon.stdout.on("data", (c) => (daemonOut += c)); daemon.stderr.on("data", (c) => (daemonOut += c));
let socketPath = join(dataDir, "hived.sock");
const deadline = Date.now() + 60_000;
let client = null;
while (!client) {
  if (daemon.exitCode !== null) throw new Error(`daemon exited early: ${daemonOut}`);
  if (Date.now() > deadline) throw new Error(`daemon did not listen: ${daemonOut}`);
  const live = readLiveEndpointRecord(dataDir);
  if (live) socketPath = live.socketPath;
  try { client = await RpcClient.connect(socketPath, 500); } catch { await new Promise((r) => setTimeout(r, 50)); }
}
record({ step: "daemon.started", pid: daemon.pid, bootMs: Math.round(performance.now() - bootStarted), socketPath, dist: DIST, protocol: client.protocol ?? null,
  capabilities: { count: client.capabilities.length, runtimeUpdate: client.capabilities.includes("runtime.update.v1"), reservationTags: client.capabilities.filter((c) => c.startsWith("update.")) } });

const hive = async (...args) => {
  const started = performance.now();
  const result = await execFileAsync(NODE, [DIST, ...args, "--data-dir", dataDir], { env, maxBuffer: 64 * 1024 * 1024 }).then((r) => ({ ok: true, ...r }), (error) => ({ ok: false, stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code }));
  return { ...result, ms: Math.round((performance.now() - started) * 10) / 10 };
};
const rpc = async (verb, params = {}, timeout = 600_000) => {
  const started = performance.now();
  try { const result = await client.request(verb, params, timeout); return { ok: true, result, ms: Math.round((performance.now() - started) * 10) / 10 }; }
  catch (error) { return { ok: false, code: error.code, reason: error.details?.reason ?? null, details: error.details ?? null, message: error.message, ms: Math.round((performance.now() - started) * 10) / 10 }; }
};
const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]; };
const timeRpc = async (verb, n) => { const samples = []; for (let i = 0; i < n; i += 1) { const r = await rpc(verb); if (!r.ok) throw new Error(`${verb} failed: ${r.message}`); samples.push(r.ms); } return { n, p50: percentile(samples, 0.5), p95: percentile(samples, 0.95), max: Math.max(...samples) }; };
const timeCli = async (n, ...args) => { const samples = []; let last; for (let i = 0; i < n; i += 1) { last = await hive(...args); if (!last.ok) throw new Error(`hive ${args.join(" ")} failed: ${last.stderr}`); samples.push(last.ms); } return { n, p50: percentile(samples, 0.5), max: Math.max(...samples), bytes: last.stdout.length }; };

try {
  record({ step: "timing.deployInfo.rpc", ...(await timeRpc("deployInfo", 50)) });
  record({ step: "timing.deploy-info.cli", ...(await timeCli(5, "deploy-info", "--json")) });
  if (MODE === "baseline") {
    const refused = await rpc("runtime.status");
    record({ step: "baseline.runtime.status", ...refused });
  } else if (MODE === "envkey") {
    const good = { descriptor: JSON.parse(readFileSync(DESCRIPTOR, "utf8")), signature: JSON.parse(readFileSync(`${DESCRIPTOR}.sig`, "utf8")) };
    const status = await rpc("runtime.status");
    record({ step: "envkey.status", envVarSet: Boolean(ENV_KEY_HEX), keys: status.result.keys, pass: status.result.keys.trusted === 0 });
    const r = await rpc("runtime.install", { archive: ARCHIVE, ...good });
    record({ step: "envkey.install_refused", pass: !r.ok && r.code === "runtime_refused" && r.reason === "key_unknown", got: { ok: r.ok, code: r.code, reason: r.reason, details: r.details, message: r.message }, versionDirs: existsSync(runtimeRoot) ? (await import("node:fs")).readdirSync(runtimeRoot).filter((n) => /^[0-9a-f]{40}$/.test(n)) : [] });
    const cli = await hive("runtime", "status");
    record({ step: "envkey.cli.status", ok: cli.ok, keysLine: cli.stdout.split("\n").find((l) => l.startsWith("keys")) });
  } else {
    const sign = async (base, ...overrides) => {
      const { stdout } = await execFileAsync(NODE, ["--experimental-strip-types", SIGN, ARCHIVE, PRIVATE_KEY, base, ...overrides], { env: { ...process.env, BUILD_IDENTITY_JSON: join(STAGE, "dist", "build-identity.json") } });
      return { descriptor: JSON.parse(readFileSync(`${base}.json`, "utf8")), signature: JSON.parse(readFileSync(`${base}.json.sig`, "utf8")), out: JSON.parse(stdout) };
    };
    const good = { descriptor: JSON.parse(readFileSync(DESCRIPTOR, "utf8")), signature: JSON.parse(readFileSync(`${DESCRIPTOR}.sig`, "utf8")) };
    const sha = good.descriptor.identity.sourceRevision;
    const before = await rpc("runtime.status");
    record({ step: "status.before", ok: before.ok, current: before.result.current, previous: before.result.previous, installed: before.result.installed.length, journal: before.result.journal.length, keys: before.result.keys, store: before.result.store, nodePin: before.result.nodePin, root: before.result.root, envVarSet: Boolean(ENV_KEY_HEX) });
    if (before.result.keys.trusted !== 1) throw new Error(`expected exactly the one compiled-in scratch key, got ${JSON.stringify(before.result.keys)}`);
    if (before.result.root !== runtimeRoot) throw new Error(`runtime root ${before.result.root} != ${runtimeRoot}`);

    const refusals = [];
    const check = async (name, expectCode, expectReason, params) => {
      const r = await rpc("runtime.install", params);
      const pass = !r.ok && r.code === expectCode && (expectReason === null || r.reason === expectReason);
      refusals.push({ name, pass });
      record({ step: `refuse.${name}`, pass, expect: { code: expectCode, reason: expectReason }, got: { ok: r.ok, code: r.code, reason: r.reason, message: r.message, details: r.details }, ms: r.ms, versionDirs: existsSync(runtimeRoot) ? (await import("node:fs")).readdirSync(runtimeRoot).filter((n) => /^[0-9a-f]{40}$/.test(n)) : [] });
    };
    const scratch = join(runRoot, "scratch"); mkdirSync(scratch);
    const tampered = join(scratch, "tampered.tgz"); cpSync(ARCHIVE, tampered);
    { const bytes = readFileSync(tampered); bytes[Math.floor(bytes.length / 2)] ^= 0xff; writeFileSync(tampered, bytes); }
    await check("tampered_archive", "runtime_refused", "archive_digest_mismatch", { archive: tampered, ...good });
    const wrongTarget = await sign(join(scratch, "wrong-target"), "identity.target=darwin-arm64");
    await check("wrong_target", "runtime_refused", "target_mismatch", { archive: ARCHIVE, descriptor: wrongTarget.descriptor, signature: wrongTarget.signature });
    const unmetNode = await sign(join(scratch, "unmet-node"), "engines.node=>=99");
    await check("unmet_node_engine", "runtime_refused", "node_pin_unmet", { archive: ARCHIVE, descriptor: unmetNode.descriptor, signature: unmetNode.signature });
    const badSig = { ...good, signature: { ...good.signature, signature: Buffer.from(Buffer.from(good.signature.signature, "base64").map((b, i) => (i === 3 ? b ^ 0x01 : b))).toString("base64") } };
    await check("bad_signature", "runtime_refused", "signature_invalid", { archive: ARCHIVE, ...badSig });
    const edited = { ...good, descriptor: { ...good.descriptor, engines: { node: ">=0" } } };
    await check("edited_descriptor_same_signature", "runtime_refused", "signature_invalid", { archive: ARCHIVE, ...edited });
    const otherKey = join(scratch, "other.key");
    await execFileAsync(NODE, ["--experimental-strip-types", join(REPO, ".proof", "D3", "keygen.mjs"), otherKey]);
    const foreign = await (async () => { const { stdout } = await execFileAsync(NODE, ["--experimental-strip-types", SIGN, ARCHIVE, otherKey, join(scratch, "foreign")], { env: { ...process.env, BUILD_IDENTITY_JSON: join(STAGE, "dist", "build-identity.json") } }); return { descriptor: JSON.parse(readFileSync(join(scratch, "foreign.json"), "utf8")), signature: JSON.parse(readFileSync(join(scratch, "foreign.json.sig"), "utf8")), out: JSON.parse(stdout) }; })();
    await check("unknown_key", "runtime_refused", "key_unknown", { archive: ARCHIVE, descriptor: foreign.descriptor, signature: foreign.signature });
    const unsafe = join(scratch, "unsafe.tgz");
    await execFileAsync("python3", ["-I", "-c", `import tarfile,io\nt=tarfile.open(${JSON.stringify(unsafe)},'w:gz')\ni=tarfile.TarInfo('../escape.txt');d=b'x';i.size=1;t.addfile(i,io.BytesIO(d))\ni=tarfile.TarInfo('dist/cli.js');i.size=1;t.addfile(i,io.BytesIO(d))\nt.close()`]);
    const unsafeDigest = `sha256:${createHash("sha256").update(readFileSync(unsafe)).digest("hex")}`;
    const unsafeSigned = await sign(join(scratch, "unsafe"), `identity.artifact.sha256=${unsafeDigest}`);
    await check("unsafe_archive_entry", "runtime_refused", "archive_unsafe", { archive: unsafe, descriptor: unsafeSigned.descriptor, signature: unsafeSigned.signature });
    const empty = join(scratch, "empty.tgz");
    await execFileAsync("python3", ["-I", "-c", `import tarfile,io\nt=tarfile.open(${JSON.stringify(empty)},'w:gz')\ni=tarfile.TarInfo('package.json');d=b'{}';i.size=2;t.addfile(i,io.BytesIO(d))\nt.close()`]);
    const emptyDigest = `sha256:${createHash("sha256").update(readFileSync(empty)).digest("hex")}`;
    const emptySigned = await sign(join(scratch, "empty"), `identity.artifact.sha256=${emptyDigest}`);
    await check("archive_without_cli", "runtime_refused", "archive_invalid", { archive: empty, descriptor: emptySigned.descriptor, signature: emptySigned.signature });
    const otherSha = await sign(join(scratch, "other-sha"), `identity.sourceRevision=${"f".repeat(40)}`);
    await check("descriptor_sha_differs_from_build_identity", "runtime_refused", "archive_invalid", { archive: ARCHIVE, descriptor: otherSha.descriptor, signature: otherSha.signature });
    await check("relative_archive_path", "invalid_request", "archive", { archive: "release.tgz", ...good });
    await check("missing_signature", "invalid_request", "signature", { archive: ARCHIVE, descriptor: good.descriptor });
    await check("malformed_descriptor", "invalid_request", "descriptor", { archive: ARCHIVE, descriptor: { schemaVersion: 7 }, signature: good.signature });
    const relay = await RpcClient.connect(socketPath, 3000, "remote");
    try { const r = await relay.request("runtime.install", { archive: ARCHIVE, ...good }).then(() => ({ ok: true }), (error) => ({ ok: false, code: error.code, message: error.message })); const pass = !r.ok && (r.code === "caller_not_trusted" || r.code === "confined_peer_refused"); refusals.push({ name: "relayed_caller", pass }); record({ step: "refuse.relayed_caller", pass, got: r }); } finally { relay.close(); }
    const afterRefusals = await rpc("runtime.status");
    record({ step: "status.after_refusals", installed: afterRefusals.result.installed.length, journal: afterRefusals.result.journal.length, leftovers: (await import("node:fs")).readdirSync(runtimeRoot).filter((n) => n.startsWith(".install")) });

    const cliInstall = await hive("runtime", "install", ARCHIVE, "--descriptor", DESCRIPTOR, "--signature", `${DESCRIPTOR}.sig`, "--json");
    const installed = cliInstall.ok ? JSON.parse(cliInstall.stdout) : null;
    record({ step: "install.cli", ok: cliInstall.ok, ms: cliInstall.ms, stdout: cliInstall.stdout.trim().slice(0, 600), stderr: cliInstall.stderr.trim().slice(0, 600) });
    if (!installed) throw new Error("cli install failed");
    const installedDir = join(runtimeRoot, sha);
    const digestInstalled = await artifactTreeDigest(installedDir), digestStage = await artifactTreeDigest(STAGE);
    const { stdout: version } = await execFileAsync(NODE, [join(installedDir, "dist", "cli.js"), "deploy-info", "--json", "--data-dir", dataDir], { env }).catch((e) => ({ stdout: `error: ${e.message}` }));
    record({ step: "install.verified", installedDir, exists: existsSync(join(installedDir, "dist", "cli.js")), treeDigestMatchesStage: digestInstalled === digestStage, bytes: installed.bytes, keyId: installed.keyId, changed: installed.changed, installedCliDeployInfo: version.trim().slice(0, 300), currentLink: existsSync(join(runtimeRoot, "current")) ? readlinkSync(join(runtimeRoot, "current")) : null });
    const again = await rpc("runtime.install", { archive: ARCHIVE, ...good });
    record({ step: "install.again", ok: again.ok, changed: again.result?.changed, journalSeq: again.result?.journal?.seq, ms: again.ms });
    const keyed1 = await rpc("runtime.install", { archive: ARCHIVE, ...good, idempotencyKey: "d3-lab-key" });
    const keyed2 = await rpc("runtime.install", { archive: ARCHIVE, ...good, idempotencyKey: "d3-lab-key" });
    record({ step: "install.idempotency_key", first: { ok: keyed1.ok, deduped: keyed1.result?.deduped ?? false }, second: { ok: keyed2.ok, deduped: keyed2.result?.deduped ?? false } });
    const afterInstall = await rpc("runtime.status");
    record({ step: "status.after_install", current: afterInstall.result.current, previous: afterInstall.result.previous, installed: afterInstall.result.installed, journal: afterInstall.result.journal, keys: afterInstall.result.keys });

    const fakes = ["1".repeat(40), "2".repeat(40), "3".repeat(40), "4".repeat(40), "5".repeat(40)];
    fakes.forEach((fake, index) => {
      mkdirSync(join(runtimeRoot, fake, "dist"), { recursive: true });
      writeFileSync(join(runtimeRoot, fake, "dist", "cli.js"), `console.log(${JSON.stringify(fake)})\n`);
      const when = new Date(Date.now() - (10 - index) * 3_600_000);
      utimesSync(join(runtimeRoot, fake), when, when);
    });
    symlinkSync(fakes[0], join(runtimeRoot, "current"));
    writeFileSync(join(runtimeRoot, "deploys.json"), JSON.stringify({ schemaVersion: 1, entries: [{ sha: fakes[1], at: "2026-11-01T00:00:00.000Z", artifactHash: "x", by: "lab" }, { sha: fakes[0], at: "2026-11-02T00:00:00.000Z", artifactHash: "y", by: "lab" }] }));
    const seeded = await rpc("runtime.status");
    record({ step: "prune.seeded", current: seeded.result.current, previous: seeded.result.previous, order: seeded.result.installed.map((v) => `${v.sha.slice(0, 4)}${v.current ? "*" : ""}${v.previous ? "<" : ""}`) });
    const badKeep = await rpc("runtime.prune", { keep: 0 });
    record({ step: "prune.keep_zero_refused", ok: badKeep.ok, code: badKeep.code, reason: badKeep.reason });
    const pruned = await hive("runtime", "prune", "1", "--json");
    const pruneResult = pruned.ok ? JSON.parse(pruned.stdout) : null;
    const remaining = (await import("node:fs")).readdirSync(runtimeRoot).filter((n) => /^[0-9a-f]{40}$/.test(n)).sort();
    record({ step: "prune.keep1", ok: pruned.ok, ms: pruned.ms, removed: pruneResult?.removed, kept: pruneResult?.kept, remaining, currentKept: remaining.includes(fakes[0]), previousKept: remaining.includes(fakes[1]), newestKept: remaining.includes(sha), stderr: pruned.stderr.trim().slice(0, 300) });
    const prunedAgain = await rpc("runtime.prune", { keep: 1 });
    record({ step: "prune.again_quiet", ok: prunedAgain.ok, removed: prunedAgain.result?.removed, journalAdded: prunedAgain.result?.journal?.length });
    const afterPrune = await rpc("runtime.status");
    record({ step: "status.after_prune", current: afterPrune.result.current, previous: afterPrune.result.previous, installed: afterPrune.result.installed.map((v) => v.sha), journal: afterPrune.result.journal.map((e) => `${e.seq}:${e.event}:${e.sha.slice(0, 4)}`) });

    const cliStatus = await hive("runtime", "status");
    record({ step: "cli.runtime.status", ok: cliStatus.ok, ms: cliStatus.ms, stdout: cliStatus.stdout });
    const cliList = await hive("runtime", "list");
    record({ step: "cli.runtime.list", ok: cliList.ok, stdout: cliList.stdout });
    const cliUpdateOwner = await hive("update-owner", "status");
    record({ step: "cli.update-owner.gone", ok: cliUpdateOwner.ok, stderr: cliUpdateOwner.stderr.trim().slice(0, 200) });
    const cliDeployArtifact = await hive("deploy", "--artifact", ARCHIVE);
    record({ step: "cli.deploy-artifact.gone", ok: cliDeployArtifact.ok, stderr: cliDeployArtifact.stderr.trim().slice(0, 200) });
    for (const verb of ["update.status", "update.reserve", "update.apiarySwap.status"]) { const r = await rpc(verb); record({ step: `rpc.gone.${verb}`, ok: r.ok, code: r.code }); }
    const audit = await rpc("audit.tail", { limit: 50 });
    record({ step: "audit.runtime", entries: (audit.result?.entries ?? audit.result?.rows ?? []).filter((e) => String(e.kind ?? e.type ?? "").startsWith("runtime.")).map((e) => ({ kind: e.kind ?? e.type, sha: e.payload?.sha ?? e.data?.sha, seq: e.payload?.seq ?? e.data?.seq })), raw: Object.keys(audit.result ?? {}) });
    record({ step: "timing.runtime.status.rpc", ...(await timeRpc("runtime.status", 50)) });
    record({ step: "timing.runtime-status.cli", ...(await timeCli(5, "runtime", "status", "--json")) });
    record({ step: "refusals.summary", total: refusals.length, passed: refusals.filter((r) => r.pass).length, failed: refusals.filter((r) => !r.pass).map((r) => r.name) });
  }
} finally {
  client.close();
  const stopStarted = performance.now();
  daemon.kill("SIGTERM");
  await new Promise((resolve) => { daemon.once("exit", resolve); setTimeout(() => { daemon.kill("SIGKILL"); }, 15_000).unref(); });
  const hivedLog = existsSync(join(dataDir, "hived.log")) ? readFileSync(join(dataDir, "hived.log"), "utf8") : daemonOut;
  record({ step: "daemon.stopped", pid: daemon.pid, exitCode: daemon.exitCode, signal: daemon.signalCode, stopMs: Math.round(performance.now() - stopStarted), runRoot, log: hivedLog.split("\n").filter((l) => /runtime\.(install|prune)|rpc\.dedup|daemon\.(started|stop)/.test(l)).slice(-30) });
  if (process.env.KEEP_RUN_ROOT !== "1") rmSync(runRoot, { recursive: true, force: true });
}
