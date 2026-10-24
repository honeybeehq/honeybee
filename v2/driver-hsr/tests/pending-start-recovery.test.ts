import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, writeFileSync, renameSync, rmSync} from "node:fs";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {openCoreStore} from "../../core/src/index.ts";
import {stubAdapter} from "../../adapters/src/index.ts";
import {HsrDriver} from "../src/index.ts";
import {inspectProcess, sameProcess} from "../src/psutil.ts";
import {AGENT_PATH, drainUntil, ofKind, sleep} from "./helpers.ts";

for (const scenario of ["recover", "stamp", "bee", "generation", "host", "journal", "stopped-race", "bound-race", "socket-peer", "birth-race"] as const) {
  test(`pending start recovery: ${scenario}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-pending-"));
    const store = openCoreStore(join(dir, "core.sqlite3"), {ephemeral: true});
    const {bee} = store.createBee({name: "pending", agent: "stub", substrate: "hsr", cwd: dir});
    const hooks = store.runtimeIdentityHooks();
    const driver = () => new HsrDriver({
      runtimeIdentity: hooks,
      sessionLogDir: join(dir, "logs"),
      resolve: () => ({adapter: stubAdapter, command: process.execPath, args: [AGENT_PATH], cwd: dir, env: {STUB_TURN_MS: "5"}}),
    });
    const first = driver();
    let second: HsrDriver | undefined;
    let impostor: ReturnType<typeof createServer> | undefined;
    let socketPath: string | undefined;
    try {
      first.start(bee.id, 1);
      await drainUntil(first, events => ofKind(events, "booted").length > 0);
      const proc = first.procOf(bee.id, 1)!;
      assert.ok(proc.processIdentity);
      const statusPath = join(dir, "runners", `${bee.id}.1.status.json`);
      const status = JSON.parse(readFileSync(statusPath, "utf8"));
      const childBefore = inspectProcess(status.agentPid);
      assert.equal(childBefore.kind, "present");
      store.recordRuntimeProc(bee.id, 1, {pid: proc.pid, pidStartedAt: proc.pidStartedAt});
      first.detachAll();
      assert.deepEqual(hooks.read(bee.id, 1), {kind: "unavailable", reason: "pending-new-start"});
      if (scenario === "bee") status.beeId = "another-bee";
      if (scenario === "generation") status.generation = 2;
      if (scenario === "host") status.hostPid = process.pid;
      if (scenario === "journal") status.observationError = "unreadable";
      if (["bee", "generation", "host", "journal"].includes(scenario)) writeFileSync(statusPath, JSON.stringify(status));
      if (scenario === "socket-peer") {
        socketPath = JSON.parse(readFileSync(join(dir, "runners", `${bee.id}.1.json`), "utf8")).socketPath;
        renameSync(socketPath!, `${socketPath}.saved`);
        impostor = createServer(socket => socket.on("error", () => undefined));
        await new Promise<void>(resolve => impostor!.listen(socketPath, resolve));
      }
      second = driver();
      const adopted = second.adopt(bee.id, 1, proc.pid, proc.pidStartedAt + (scenario === "stamp" ? 10000 : 0), "booting", 0);
      const rejectedBeforeConnect = ["stamp", "bee", "generation", "host", "journal"].includes(scenario);
      assert.equal(adopted, !rejectedBeforeConnect);
      if (scenario === "stopped-race") store.updateRuntimeState(bee.id, 1, "stopped", {exitCause: "clean"});
      if (scenario === "bound-race") assert.equal(hooks.bindPendingStart!(bee.id, 1, proc.pidStartedAt, proc.processIdentity), true);
      if (scenario === "birth-race") {
        const procs = (second as unknown as {procs: Map<string, {pendingStartIdentity: {birth: string}}>}).procs;
        procs.get(bee.id)!.pendingStartIdentity.birth = process.platform === "darwin" ? "darwin:1:0" : "linux:1";
      }
      if (scenario === "recover") {
        const events = await drainUntil(second, observed => ofKind(observed, "booted").length > 0, 5000);
        assert.ok(ofKind(events, "booted").length);
        assert.equal(second.isDegraded(bee.id, 1), false);
        assert.deepEqual(hooks.read(bee.id, 1), {kind: "bound", identity: proc.processIdentity, pidStartedAt: proc.pidStartedAt});
        assert.equal(second.procOf(bee.id, 1)!.pid, proc.pid);
        assert.ok(sameProcess(proc.processIdentity, inspectProcess(proc.pid)));
        assert.ok(childBefore.kind === "present" && sameProcess(childBefore, inspectProcess(status.agentPid)));
        assert.equal(second.deliver(bee.id, 1, 123, "recovered without restart").accepted, true);
        await drainUntil(second, observed => ofKind(observed, "turn_ended").length > 0, 5000);
        assert.ok(readFileSync(join(dir, "logs", `${bee.id}.jsonl`), "utf8").includes("recovered without restart"));
        assert.equal(store.auditTail(0, 1000).filter(row => row.kind === "runtime.pending_start_bound").length, 1);
      } else {
        await sleep(150);
        assert.deepEqual(second.observe(), []);
        assert.equal(second.deliver(bee.id, 1, 123, "must stay queued").accepted, false);
        assert.ok(sameProcess(proc.processIdentity, inspectProcess(proc.pid)));
        assert.equal(hooks.read(bee.id, 1).kind, scenario === "bound-race" ? "bound" : "unavailable");
        assert.equal(second.procOf(bee.id, 1)?.processIdentity, undefined);
        assert.equal(store.auditTail(0, 1000).filter(row => row.kind === "runtime.pending_start_bound").length, scenario === "bound-race" ? 1 : 0);
      }
    } finally {
      second?.detachAll();
      if (impostor) await new Promise<void>(resolve => impostor!.close(() => resolve()));
      if (socketPath) renameSync(`${socketPath}.saved`, socketPath);
      first.disposeAll();
      store.close();
      rmSync(dir, {recursive: true, force: true});
    }
  });
}
