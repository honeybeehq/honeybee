import assert from "node:assert/strict";
import { test } from "node:test";
import { cp, mkdir, mkdtemp, readFile, writeFile, rm, symlink, readlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { build } from "esbuild";

const exec = promisify(execFile);
const base = resolve("..", "base");
const baseline = "0507721a5f3f80a83c18d51144eca4cb04210171";
const banner = { js: 'import { createRequire as a1FixtureRequire } from "node:module"; const require = a1FixtureRequire(import.meta.url);' };
async function bundle(source: string, outfile: string, contents: string) {
  await build({ stdin: { contents, resolveDir: source, loader: "ts" }, bundle: true, platform: "node", format: "esm", outfile, banner, external: ["node-pty"], alias: { "jsonc-parser": join(source, "node_modules/jsonc-parser/lib/esm/main.js") }, logLevel: "silent" });
}
async function caught(operation: () => Promise<unknown>): Promise<Error> {
  try { await operation(); } catch (error) { assert.ok(error instanceof Error); return error; }
  return assert.fail("expected refusal");
}
function facts(error: Error) { return { name: error.name, code: Reflect.get(error, "code"), errcode: Reflect.get(error, "errcode"), message: error.message }; }

test("A1: actual 0507721a CLI selects busy offline fallback with live 0507721a owner; fixed CLI restores live admission", async () => {
  const config = JSON.parse(await readFile(resolve("..", "config.json"), "utf8"));
  assert.equal(config.shas.base, baseline);
  const root = await mkdtemp(join(tmpdir(), "hb-a1-")), fixture = join(root, "fixture"), runtime = join(root, "runtime"), data = join(root, "v2"), repo = join(root, "repo");
  const sha = "a".repeat(40), previous = "b".repeat(40), dir = join(runtime, sha), cli = join(dir, "dist/v2/cli.js");
  const identity = { schemaVersion: 1, component: "honeybee", version: "0.0.1", packageVersion: "0.0.1", sourceRevision: sha, dirty: false, release: true, target: `${process.platform}-${process.arch}` };
  let cleanup: (() => Promise<void>) | undefined;
  try {
    await mkdir(join(fixture, "dist/v2"), { recursive: true }); await mkdir(join(dir, "dist/v2"), { recursive: true }); await mkdir(data); await mkdir(repo);
    await cp(join(base, "contracts"), join(fixture, "contracts"), { recursive: true });
    await cp(join(base, "contracts"), join(dir, "contracts"), { recursive: true });
    await writeFile(join(fixture, "dist/build-identity.json"), JSON.stringify(identity)); await writeFile(join(dir, "dist/build-identity.json"), JSON.stringify(identity));
    await symlink(sha, join(runtime, "current"));
    await exec("git", ["init", "-q", repo]); await writeFile(join(repo, "test"), "one"); await exec("git", ["-C", repo, "add", "."]); await exec("git", ["-C", repo, "-c", "user.name=lab", "-c", "user.email=lab@test", "commit", "-qm", "one"]);
    const ownerOut = join(fixture, "dist/v2/owner.mjs"), deployOut = join(fixture, "dist/v2/deploy.mjs");
    await bundle(base, ownerOut, `export {HiveDaemon} from ${JSON.stringify(join(base, "v2/daemon/src/daemon.ts"))}; export {RpcServer} from ${JSON.stringify(join(base, "v2/daemon/src/rpc.ts"))}; export {RpcClient} from ${JSON.stringify(join(base, "v2/cli/src/client.ts"))}; export {openCoreStore} from ${JSON.stringify(join(base, "v2/core/src/index.ts"))};`);
    await bundle(base, deployOut, `export {deployVersion,rollbackDeploy} from ${JSON.stringify(join(base, "src/deployRuntime.ts"))};`);
    const api = await import(pathToFileURL(ownerOut).href), deploy = await import(pathToFileURL(deployOut).href);
    const store = api.openCoreStore(join(data, "core.sqlite3"), { ephemeral: true }), daemon = Object.create(api.HiveDaemon.prototype);
    daemon.cfg = { dataDir: data, storePath: join(data, "core.sqlite3") }; daemon.store = store; daemon.stopping = false;
    let statusCalls = 0;
    const socket = join(data, "hived.sock"), server = new api.RpcServer({ socketPath: socket, log() {}, dispatch: (verb: string, params: Record<string, unknown>, conn: unknown) => { if (verb === "update.status") statusCalls++; return daemon.dispatch(verb, params, conn); } });
    await server.listen(); cleanup = async () => { await server.close(); store.close(); };
    const args = [cli, "update-owner", "status", "--data-dir", data, "--socket", socket];
    await bundle(base, cli, `import {runV2Cli} from ${JSON.stringify(join(base, "v2/cli/src/main.ts"))}; process.exitCode = await runV2Cli(process.argv.slice(2));`);
    const cliError = await caught(() => exec(process.execPath, args)); assert.match(cliError.message, /expected status, reserve, or release/); assert.equal(statusCalls, 0);
    const hooks = { async buildArtifact(): Promise<never> { throw new Error("FIXED_LIVE_BUILD_REACHED"); }, async restartDaemon() {} };
    const deployError = await caught(() => deploy.deployVersion({ root: runtime, repoRoot: repo, allowNonDescendant: true, hooks }));
    const rollbackError = await caught(() => deploy.rollbackDeploy({ root: runtime, hooks }));
    for (const error of [deployError, rollbackError]) assert.match(error.message, /locked|busy/i);
    assert.equal(statusCalls, 0); assert.equal(await readlink(join(runtime, "current")), sha); assert.equal(existsSync(join(runtime, "deploys.json")), false);
    console.log(JSON.stringify({ A1: "baseline", source: baseline, owner: "0507721a HiveDaemon dispatch + live openCoreStore", cli: facts(cliError), guardReadPath: "CLI subprocess fails before RPC; offline read of live EXCLUSIVE store", deploy: facts(deployError), rollback: facts(rollbackError), refusedBusy: true, statusCalls, currentUnchanged: true, historyUnchanged: true }));
    const direct = await api.RpcClient.connect(socket);
    try {
      const observed = await direct.request("update.status"); assert.equal(observed.reservation.epoch, 0);
      console.log(JSON.stringify({ A1: "direct-RPC-control", source: baseline, result: "live status succeeds without CLI or offline fallback", statusCalls }));
    } finally { direct.close(); }
    statusCalls = 0;
    await bundle(process.cwd(), cli, `import {runV2Cli} from ${JSON.stringify(resolve("v2/cli/src/main.ts"))}; process.exitCode = await runV2Cli(process.argv.slice(2));`);
    const status = JSON.parse((await exec(process.execPath, args)).stdout); assert.equal(status.reservation.epoch, 0); assert.equal(statusCalls, 1);
    const fixedDeploy = await caught(() => deploy.deployVersion({ root: runtime, repoRoot: repo, allowNonDescendant: true, hooks })); assert.equal(fixedDeploy.message, "FIXED_LIVE_BUILD_REACHED"); assert.equal(statusCalls, 2); assert.equal(await readlink(join(runtime, "current")), sha);
    await mkdir(join(runtime, previous, "dist"), { recursive: true }); await writeFile(join(runtime, previous, "dist/cli.js"), "console.log('previous');");
    await writeFile(join(runtime, "deploys.json"), JSON.stringify({ schemaVersion: 1, entries: [{ sha: previous, at: "2026-01-01T00:00:00Z", artifactHash: "lab", by: "lab" }, { sha, at: "2026-01-02T00:00:00Z", artifactHash: "lab", by: "lab" }] }));
    let restarts = 0;
    const rolled = await deploy.rollbackDeploy({ root: runtime, hooks: { async restartDaemon() { restarts++; } } });
    assert.equal(rolled.sha, previous); assert.equal(restarts, 1); assert.equal(statusCalls, 3);
    console.log(JSON.stringify({ A1: "fixed-CLI-only", deployAndRollback: "unmodified 0507721a", guardReadPath: "live CLI/RPC response; no offline fallback", statusCalls, deploy: "admitted through guard to builder; injected stop before effects", rollback: "admitted; fake restart hook reached and target switched", cliParseFixConfirmed: true }));
  } finally { await cleanup?.(); await rm(root, { recursive: true, force: true }); }
});
