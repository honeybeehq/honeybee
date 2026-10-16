import assert from "node:assert/strict";
import { test } from "node:test";
import { cp, mkdir, mkdtemp, readFile, writeFile, rm, symlink, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { build } from "esbuild";
import { deployVersion, rollbackDeploy, DeployReservationHeldError } from "../src/deployRuntime.js";
import { readUpdateReservation } from "../src/readUpdateReservation.js";

const exec = promisify(execFile);
const base = resolve("..", "base");
const banner = { js: 'import { createRequire as fixtureRequire } from "node:module"; const require = fixtureRequire(import.meta.url);' };
async function bundle(source: string, outfile: string, contents: string) {
  await build({ stdin: { contents, resolveDir: source, loader: "ts" }, bundle: true, platform: "node", format: "esm", outfile, banner, external: ["node-pty"], alias: { "jsonc-parser": join(source, "node_modules/jsonc-parser/lib/esm/main.js") }, logLevel: "silent" });
}

test("guard uses direct RPC with a released-era live owner, excludes reservations and fails closed", async () => {
  const config = JSON.parse(await readFile(resolve("..", "config.json"), "utf8"));
  assert.ok(["ef5e9e67", "0507721a"].some(prefix => config.shas.base.startsWith(prefix)));
  const root = await mkdtemp(join(tmpdir(), "hb-rpc-")), fixture = join(root, "fixture"), runtime = join(root, "runtime"), data = join(root, "v2"), repo = join(root, "repo");
  const sha = "a".repeat(40), dir = join(runtime, sha), socket = join(data, "hived.sock");
  const identity = { schemaVersion: 1, component: "honeybee", version: "0.0.1", packageVersion: "0.0.1", sourceRevision: sha, dirty: false, release: true, target: `${process.platform}-${process.arch}` };
  let cleanup: (() => Promise<void>) | undefined;
  try {
    await mkdir(join(fixture, "dist/v2"), { recursive: true }); await mkdir(join(dir, "dist/v2"), { recursive: true }); await mkdir(data); await mkdir(repo);
    await cp(join(base, "contracts"), join(fixture, "contracts"), { recursive: true });
    await writeFile(join(fixture, "dist/build-identity.json"), JSON.stringify(identity));
    await writeFile(join(dir, "dist/v2/cli.js"), "throw new Error('INSTALLED_CLI_MUST_NOT_RUN');");
    await writeFile(join(dir, "dist/cli.js"), "console.log('previous');");
    await symlink(sha, join(runtime, "current"));
    await writeFile(join(runtime, "deploys.json"), JSON.stringify({ schemaVersion: 1, entries: [{ sha, at: "2026-01-01T00:00:00Z", artifactHash: "lab", by: "lab" }] }));
    await exec("git", ["init", "-q", repo]); await writeFile(join(repo, "test"), "one"); await exec("git", ["-C", repo, "add", "."]); await exec("git", ["-C", repo, "-c", "user.name=lab", "-c", "user.email=lab@test", "commit", "-qm", "one"]);
    const ownerOut = join(fixture, "dist/v2/owner.mjs");
    await bundle(base, ownerOut, `export {HiveDaemon} from ${JSON.stringify(join(base, "v2/daemon/src/daemon.ts"))}; export {RpcServer} from ${JSON.stringify(join(base, "v2/daemon/src/rpc.ts"))}; export {openCoreStore} from ${JSON.stringify(join(base, "v2/core/src/index.ts"))};`);
    const api = await import(pathToFileURL(ownerOut).href);
    const store = api.openCoreStore(join(data, "core.sqlite3"), { ephemeral: true }), daemon = Object.create(api.HiveDaemon.prototype);
    daemon.cfg = { dataDir: data, storePath: join(data, "core.sqlite3") }; daemon.store = store; daemon.stopping = false;
    const calls: string[] = [];
    const server = new api.RpcServer({ socketPath: socket, log() {}, dispatch: (verb: string, params: Record<string, unknown>, conn: unknown) => { calls.push(verb); return daemon.dispatch(verb, params, conn); } });
    await server.listen(); let closed = false;
    cleanup = async () => { if (!closed) await server.close(); store.close(); };
    let builds = 0, restarts = 0;
    const hooks = {
      async buildArtifact({ workDir }: { workDir: string }) {
        builds++; const artifactDir = join(workDir, "stage"); await mkdir(join(artifactDir, "dist"), { recursive: true });
        await writeFile(join(artifactDir, "dist/cli.js"), "console.log('candidate');"); return { artifactDir };
      },
      async restartDaemon() { restarts++; },
    };
    const deployed = await deployVersion({ root: runtime, repoRoot: repo, allowNonDescendant: true, hooks });
    assert.equal(builds, 1); assert.equal(restarts, 1); assert.equal(await readlink(join(runtime, "current")), deployed.sha);
    const rolled = await rollbackDeploy({ root: runtime, hooks });
    assert.equal(rolled.sha, sha); assert.equal(restarts, 2); assert.equal(calls.filter(v => v === "update.status").length, 2);
    console.log(JSON.stringify({ ownerSource: config.shas.base, noReservation: "deploy and rollback completed with injected build/restart hooks", readPath: "direct live RPC", installedCli: "throws if executed", statusCalls: 2 }));
    const cli = join(fixture, "dist/v2/candidate-cli.js");
    await bundle(process.cwd(), cli, `import {runV2Cli} from ${JSON.stringify(resolve("v2/cli/src/main.ts"))}; process.exitCode = await runV2Cli(process.argv.slice(2));`);
    const cliArgs = ["--data-dir", data, "--socket", socket];
    const status = JSON.parse((await exec(process.execPath, [cli, "update-owner", "status", ...cliArgs])).stdout); assert.equal(status.reservation.epoch, 0);
    const request = { id: "rpc-lab-owner", expectedEpoch: 0, recoverySubjectDigest: `sha256:${"b".repeat(64)}` }, requestFile = join(root, "reserve.json");
    await writeFile(requestFile, JSON.stringify(request));
    await exec(process.execPath, [cli, "update-owner", "reserve", requestFile, ...cliArgs]);
    assert.ok(calls.includes("update.reserve"));
    for (const operation of [() => deployVersion({ root: runtime, repoRoot: repo, allowNonDescendant: true, hooks }), () => rollbackDeploy({ root: runtime, hooks })]) {
      await assert.rejects(operation, error => error instanceof DeployReservationHeldError && error.reservationId === request.id && error.epoch === 1);
    }
    assert.equal(builds, 1); assert.equal(restarts, 2);
    await writeFile(requestFile, JSON.stringify({ id: request.id, epoch: 1, recoverySubjectDigest: request.recoverySubjectDigest }));
    await assert.rejects(exec(process.execPath, [cli, "update-owner", "release", requestFile, ...cliArgs]), /Running identity does not match completion receipt/);
    assert.ok(calls.includes("update.release"));
    console.log(JSON.stringify({ ownerSource: config.shas.base, activeReservation: "deploy and rollback refused before hooks", cliStatusReserveRelease: "all positional verbs reached RPC" }));
    await server.close(); closed = true;
    for (const operation of [() => deployVersion({ root: runtime, repoRoot: repo, allowNonDescendant: true, hooks }), () => rollbackDeploy({ root: runtime, hooks })]) await assert.rejects(operation, /locked|busy/i);
    console.log(JSON.stringify({ ownerSource: config.shas.base, unreachableSocket: "refused: database is locked; live EXCLUSIVE store cannot be used as stale fallback" }));
    store.close(); cleanup = undefined;
    const malformed = createServer(connection => { connection.end("not-json\n"); });
    await new Promise<void>((resolve, reject) => { malformed.once("error", reject); malformed.listen(socket, resolve); });
    try {
      for (const operation of [() => deployVersion({ root: runtime, repoRoot: repo, allowNonDescendant: true, hooks }), () => rollbackDeploy({ root: runtime, hooks })]) await assert.rejects(operation, /server hello is not json/);
      await assert.rejects(readUpdateReservation(runtime), /server hello is not json/);
      assert.equal(builds, 1); assert.equal(restarts, 2);
      console.log(JSON.stringify({ ownerSource: config.shas.base, malformedResponse: "refused protocol error; no offline fallback even with readable database" }));
    } finally { await new Promise<void>((resolve, reject) => malformed.close(error => error ? reject(error) : resolve())); }
  } finally { await cleanup?.(); await rm(root, { recursive: true, force: true }); }
});
