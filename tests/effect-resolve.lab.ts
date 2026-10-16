import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { build } from "esbuild";
import { openCoreStore } from "../v2/core/src/index.ts";
import { EffectKeyError } from "../v2/core/src/effectResolve.ts";
import { RpcClient } from "../v2/cli/src/client.ts";

const base = resolve("..", "base");
for (const mode of ["clean-pruned", "unclean-pruned", "fenced-then-legacy-pruned"] as const) {
  test(`effect resolve real old owner upgrade downgrade spawn reupgrade: ${mode}`, async () => {
    assert.ok(existsSync(join(base, "v2/core/src/store.ts")), "requires masked gate base export");
    const config = JSON.parse(await readFile(resolve("..", "config.json"), "utf8"));
    assert.ok(["0507721a5f3f80a83c18d51144eca4cb04210171", "c4a7480b"].some(sha => config.shas.base.startsWith(sha)));
    const dir = await mkdtemp(join(tmpdir(), "eff-old-")), path = join(dir, "core.sqlite3"), socket = join(dir, "s");
    let store = openCoreStore(path, { ephemeral: true }), client: RpcClient | undefined;
    let child: ReturnType<typeof fork> | undefined;
    try {
      const previous = store.effectCoverage(), key = `effect-v1:${previous.coverageId}:original`;
      if (mode === "fenced-then-legacy-pruned") assert.equal(store.resolveEffect(key, "spawn").status, "never_seen_fenced");
      store.close();
      const out = join(dir, "old.mjs");
      await build({ stdin: { contents: `export {openCoreStore} from ${JSON.stringify(join(base,"v2/core/src/index.ts"))}; export {HiveDaemon} from ${JSON.stringify(join(base,"v2/daemon/src/daemon.ts"))}; export {RpcServer} from ${JSON.stringify(join(base,"v2/daemon/src/rpc.ts"))};`, resolveDir: base, loader: "ts" }, outfile: out, bundle: true, platform: "node", format: "esm", external: ["node-pty"], banner: { js: 'import {createRequire as effectCreateRequire} from "node:module";const require=effectCreateRequire(import.meta.url);' }, alias: { "jsonc-parser": resolve("node_modules/jsonc-parser/lib/esm/main.js") }, logLevel: "silent" });
      const worker = join(dir, "worker.mjs");
      await writeFile(worker, `import {openCoreStore,HiveDaemon,RpcServer} from './old.mjs';
const store=openCoreStore(${JSON.stringify(path)},{ephemeral:true,maxRpcIdempotencyRows:1});
const d=Object.create(HiveDaemon.prototype);Object.assign(d,{store,cfg:{dataDir:${JSON.stringify(dir)},logPath:${JSON.stringify(join(dir,"old.log"))},agents:{stub:{adapter:'stub'}}},stopping:false,opLog:[],deps:{},refusedClaims:new Map()});
const server=new RpcServer({socketPath:${JSON.stringify(socket)},log(){},dispatch:(v,p,c)=>d.dispatch(v,p,c)});await server.listen();process.send({ready:true});
process.on('message',async()=>{await server.close();store.close();process.exit(0);});`);
      const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
      child = fork(worker, [], { env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      let errors = ""; child.stderr?.on("data", chunk => { errors += String(chunk); });
      const ready = await Promise.race([once(child, "message", { signal: AbortSignal.timeout(30_000) }), once(child, "exit").then(() => { throw new Error(`old owner exited: ${errors}`); })]);
      assert.equal((ready[0] as { ready: boolean }).ready, true);
      client = await RpcClient.connect(socket);
      assert.equal(client.capabilities.includes("rpc-effect-resolve.v1"), false);
      const spawned = await client.request<{ beeId: string }>("spawn", { name: "legacy-original", agent: "stub", account: null, cwd: dir, idempotencyKey: key });
      assert.equal(typeof spawned.beeId, "string");
      for (let i = 0; i < 3; i++) await client.request("spawn", { name: `prune-${i}`, agent: "stub", account: null, cwd: dir, idempotencyKey: `legacy-padding-${i}` });
      client.close(); client = undefined;
      const exited = once(child, "exit");
      if (mode === "unclean-pruned") child.kill("SIGKILL"); else child.send("close");
      await exited;
      store = openCoreStore(path, { ephemeral: true });
      assert.notEqual(store.effectCoverage().coverageId, previous.coverageId);
      assert.equal(store.getBee(spawned.beeId)?.name, "legacy-original");
      assert.throws(() => store.resolveEffect(key, "spawn"), error => error instanceof EffectKeyError && error.code === "rpc_effect_history_unknown");
      console.log(JSON.stringify({ oldOwnerSource: config.shas.base, mode, result: "rpc_effect_history_unknown", neverSeenFenced: false, oldRpcReceiptPruned: true, oldSpawnCommitted: true }));
    } finally {
      client?.close();
      if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
      store.close(); await rm(dir, { recursive: true, force: true });
    }
  });
}
