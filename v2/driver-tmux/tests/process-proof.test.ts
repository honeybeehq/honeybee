import assert from "node:assert/strict";
import {test} from "node:test";
import {chmodSync, mkdtempSync, rmSync, symlinkSync, realpathSync} from "node:fs";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {legacyPaneProof, ownedSocketProof, sameSocketProof, socketOwnership} from "../src/processProof.ts";
import {harness, makeBee} from "../../core/tests/helpers.ts";
import type {DatabaseSync} from "node:sqlite";
import {makeRig, drainUntil} from "./helpers.ts";

test("legacy pane proof is exactly one pane tied to the persisted pid and derived session", () => {
  const row = "hive-v2-bee-g1\t0\t%42\t123";
  assert.deepEqual(legacyPaneProof(row, "hive-v2-bee-g1", 123), {paneId: "%42"});
  for (const text of ["", row + "\n" + row, row.replace("123", "124"), row.replace("%42", ""), row.replace("%42", "bad"), row.replace("-g1", "-g2"), row.replace("\t0\t", "\t1\t")]) assert.equal(legacyPaneProof(text, "hive-v2-bee-g1", 123), null);
});

test("legacy tmux binds derived single-pane proof to the stored pid once", {timeout: 15000}, async () => {
  const h = harness(), store = h.open(), rig = makeRig({runtimeIdentity: store.runtimeIdentityHooks()});
  const {bee} = makeBee(store), generation = store.currentRuntime(bee.id)!.generation;
  let sibling: ReturnType<typeof rig.makeSiblingDriver> | null = null;
  try {
    rig.configure(bee.id, "transcript"); rig.driver.start(bee.id, generation);
    await drainUntil(rig.driver, rows => rows.some(row => row.kind === "booted"));
    const proc = rig.driver.procOf(bee.id, generation)!;
    store.recordRuntimeProc(bee.id, generation, proc);
    (store as unknown as {db: DatabaseSync}).db.prepare("UPDATE runtimes SET process_identity=NULL WHERE bee_id=?").run(bee.id);
    sibling = rig.makeSiblingDriver();
    assert.equal(sibling.adopt(bee.id, generation, proc.pid, proc.pidStartedAt), true);
    const binding = store.runtimeProcessIdentity(bee.id, generation); assert.equal(binding.kind, "bound");
    if (binding.kind !== "bound") throw new Error("Legacy tmux binding missing");
    assert.equal(store.runtimeIdentityHooks().bindLegacy(bee.id, generation, proc.pidStartedAt, binding.identity, "owned-tmux-pane"), false);
  } finally {sibling?.disposeAll(); rig.cleanup(); store.close(); h.cleanup();}
});
test("socket proof refuses symlinks, directory mode changes and inode drift", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hb-proof-"))), path = join(root, "tmux.sock");
  const server = createServer();
  try {
    await new Promise<void>(resolve => server.listen(path, resolve));
    const proof = ownedSocketProof(path); assert.ok(proof);
    assert.equal(sameSocketProof(proof, ownedSocketProof(path)), true);
    assert.equal(sameSocketProof(proof, {...proof, ino: proof.ino + 1}), false);
    assert.equal(sameSocketProof(proof, {...proof, parentIno: proof.parentIno + 1}), false);
    symlinkSync(path, join(root, "alias.sock")); assert.equal(ownedSocketProof(join(root, "alias.sock")), null);
    chmodSync(root, 0o755); assert.equal(ownedSocketProof(path), null); chmodSync(root, 0o700);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, {recursive: true, force: true}); }
});
test("socket ownership refuses either wrong uid and any non-private directory", () => {
  const directory = {uid: 1000, mode: 0o700, isDirectory: () => true}, socket = {uid: 1000, isSocket: () => true};
  assert.equal(socketOwnership(directory, socket, 1000), true);
  assert.equal(socketOwnership(directory, {...socket, uid: 1001}, 1000), false);
  assert.equal(socketOwnership({...directory, uid: 1001}, socket, 1000), false);
  assert.equal(socketOwnership({...directory, mode: 0o755}, socket, 1000), false);
  assert.equal(socketOwnership({...directory, isDirectory: () => false}, socket, 1000), false);
  assert.equal(socketOwnership(directory, {...socket, isSocket: () => false}, 1000), false);
});

test("fresh tmux retries a transient unavailable capture through its retained socket and pane", {timeout: 15000}, async () => {
  const rig = makeRig();
  const driver = rig.driver as unknown as {captureProcessIdentity: (pid: number) => import("../../driver-hsr/src/psutil.ts").ProcessIdentity | null};
  const capture = driver.captureProcessIdentity.bind(rig.driver); let available = false;
  driver.captureProcessIdentity = pid => available ? capture(pid) : null;
  try {
    rig.configure("late-proof", "transcript"); rig.driver.start("late-proof", 1);
    await drainUntil(rig.driver, rows => rows.some(row => row.kind === "booted"));
    assert.equal(rig.driver.procOf("late-proof", 1)?.processIdentity, undefined);
    rig.driver.retryProcessIdentity("late-proof", 1);
    assert.equal(rig.driver.procOf("late-proof", 1)?.processIdentity, undefined);
    available = true;
    rig.driver.retryProcessIdentity("late-proof", 1);
    assert.ok(rig.driver.procOf("late-proof", 1)?.processIdentity);
    rig.driver.stop("late-proof", 1, "stopped_by_user");
    await drainUntil(rig.driver, rows => rows.some(row => row.kind === "exited"));
  } finally {rig.cleanup();}
});

test("exit cleanup retains a replacement pane instead of killing its session", {timeout: 15000}, async () => {
  const {TmuxServer, shQuote} = await import("../src/tmux.ts");
  const {sessionNameFor} = await import("../src/driver.ts");
  const rig = makeRig(), server = new TmuxServer({socketPath: rig.socketPath});
  try {
    rig.configure("replacement", "transcript"); rig.driver.start("replacement", 1);
    await drainUntil(rig.driver, rows => rows.some(row => row.kind === "booted"));
    const internals = rig.driver as unknown as {procs: Map<string, {paneId: string; pid: number}>; onExit(p: unknown): void};
    const original = internals.procs.get("replacement")!;
    server.run(["respawn-pane", "-k", "-t", original.paneId, `${shQuote(process.execPath)} -e ${shQuote("setInterval(()=>{},1000)")}`]);
    const replacement = server.run(["display-message", "-p", "-t", original.paneId, "#{pane_pid}"]);
    assert.notEqual(Number(replacement), original.pid);
    internals.onExit(original);
    assert.equal(server.run(["display-message", "-p", "-t", original.paneId, "#{pane_dead}"]), "0");
    assert.equal(server.run(["display-message", "-p", "-t", original.paneId, "#{session_name}"]), sessionNameFor("replacement", 1));
  } finally {rig.cleanup();}
});

test("retained cleanup becomes informational on socket loss and resolves after proven absence", {timeout: 15000}, async () => {
  const {TmuxServer, exactSession, shQuote} = await import("../src/tmux.ts");
  const {sessionNameFor} = await import("../src/driver.ts");
  const h = harness(), store = h.open(), rig = makeRig({cleanup: store.tmuxCleanupHooks()}), server = new TmuxServer({socketPath: rig.socketPath});
  try {
    const {bee} = makeBee(store);
    rig.configure(bee.id, "transcript"); rig.driver.start(bee.id, 1);
    await drainUntil(rig.driver, rows => rows.some(row => row.kind === "booted"));
    const extra = server.run(["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", exactSession(sessionNameFor(bee.id, 1)), `${shQuote(process.execPath)} -e ${shQuote("setInterval(()=>{},1000)")}`]);
    rig.driver.stop(bee.id, 1, "stopped_by_user");
    await drainUntil(rig.driver, rows => rows.some(row => row.kind === "exited"));
    assert.equal(server.run(["display-message", "-p", "-t", extra, "#{pane_dead}"]), "0");
    assert.deepEqual(store.tmuxCleanupCounts(), {retained: 1, informational: 0});
    const {renameSync} = await import("node:fs");
    const clock = rig.driver as unknown as {now: () => number};
    let now = Date.now(); clock.now = () => now;
    renameSync(rig.socketPath, rig.socketPath + ".held");
    now += 1001; rig.driver.observe();
    assert.deepEqual(store.tmuxCleanupCounts(), {retained: 0, informational: 1});
    renameSync(rig.socketPath + ".held", rig.socketPath);
    server.run(["new-session", "-d", "-s", "diagnostic-witness", `${shQuote(process.execPath)} -e ${shQuote("setInterval(()=>{},1000)")}`]);
    server.run(["kill-session", "-t", exactSession(sessionNameFor(bee.id, 1))]);
    now += 1001; rig.driver.observe();
    assert.deepEqual(store.tmuxCleanupCounts(), {retained: 0, informational: 0});
  } finally {rig.cleanup(); store.close(); h.cleanup();}
});

test("late capture refuses wrong scope, pid, pane, dead pane and extra membership", async () => {
  const {freshPaneProof, paneScopeProof} = await import("../src/processProof.ts");
  const scope = {sessionId: "$1", windowId: "@1"};
  const row = "s\t0\t%1\t123\t0\t$1\t@1";
  assert.equal(freshPaneProof(row, "s", "%1", 123, scope), true);
  for (const value of [row.replace("$1", "$2"), row.replace("@1", "@2"), row.replace("123", "124"), row.replace("%1", "%2"), row.replace("123\t0", "123\t1"), row + "\n" + row]) assert.equal(freshPaneProof(value, "s", "%1", 123, scope), false);
  assert.deepEqual(paneScopeProof("s\t$1\t@1\t%1\t123", "s", "%1", 123), scope);
  assert.equal(paneScopeProof("s\t$1\t@1\t%1\t124", "s", "%1", 123), null);
});

for (const witness of [false, true]) test(`single exact dead pane cleanup removes only its pane (other session=${witness})`, {timeout: 15000}, async () => {
  const {TmuxServer, exactSession, shQuote} = await import("../src/tmux.ts");
  const {sessionNameFor} = await import("../src/driver.ts");
  const h = harness(), store = h.open(), rig = makeRig({cleanup: store.tmuxCleanupHooks()}), server = new TmuxServer({socketPath: rig.socketPath});
  const diagnostic: {cleanupResult: "removed" | "retained" | "proof-missing" | "command-error" | null; paneDead: boolean | null; paneScopePresent: boolean | null; spawnSocketProofPresent: boolean | null; currentSocketOwned: boolean | null; socketProofMatches: boolean | null; hasSessionStatus: number | null} = {cleanupResult: null, paneDead: null, paneScopePresent: null, spawnSocketProofPresent: null, currentSocketOwned: null, socketProofMatches: null, hasSessionStatus: null};
  const observed = rig.driver as unknown as {cleanupExitedPane: (pane: {paneId: string; paneScope: unknown; spawnSocketProof: Parameters<typeof sameSocketProof>[0]}, deadline?: bigint) => void; server: InstanceType<typeof TmuxServer>};
  const cleanup = observed.cleanupExitedPane.bind(rig.driver);
  const command = observed.server.try.bind(observed.server);
  observed.server.try = (...args) => {
    if (args[0][0] !== "if-shell") return command(...args);
    try {
      const result = command(...args);
      diagnostic.cleanupResult = result.status === 0 && result.stdout.trim() === "SCG_CLEANUP_REMOVED" ? "removed" : result.status === 0 && result.stdout.trim() === "SCG_CLEANUP_RETAINED" ? "retained" : "command-error";
      return result;
    } catch (error) { diagnostic.cleanupResult = "command-error"; throw error; }
  };
  observed.cleanupExitedPane = (...args) => {
    const [pane] = args;
    const proof = ownedSocketProof(rig.socketPath);
    diagnostic.paneScopePresent = pane.paneScope != null;
    diagnostic.spawnSocketProofPresent = pane.spawnSocketProof != null;
    diagnostic.currentSocketOwned = proof != null;
    diagnostic.socketProofMatches = sameSocketProof(pane.spawnSocketProof, proof);
    diagnostic.cleanupResult = "proof-missing";
    try {
      const result = server.try(["display-message", "-p", "-t", pane.paneId, "#{pane_dead}"]);
      const value = result.stdout.trim();
      diagnostic.paneDead = result.status === 0 && (value === "0" || value === "1") ? value === "1" : null;
    } catch { diagnostic.paneDead = null; }
    cleanup(...args);
  };
  const query = server.try.bind(server);
  server.try = (...args) => {
    const result = query(...args);
    if (args[0][0] === "has-session" && diagnostic.hasSessionStatus === null) diagnostic.hasSessionStatus = result.status;
    return result;
  };
  try {
    const {bee} = makeBee(store);
    rig.configure(bee.id, "transcript"); rig.driver.start(bee.id, 1);
    await drainUntil(rig.driver, rows => rows.some(row => row.kind === "booted"));
    if (witness) server.run(["new-session", "-d", "-s", "cleanup-witness", `${shQuote(process.execPath)} -e ${shQuote("setInterval(()=>{},1000)")}`]);
    rig.driver.stop(bee.id, 1, "stopped_by_user");
    await drainUntil(rig.driver, rows => rows.some(row => row.kind === "exited"));
    assert.notEqual(server.try(["has-session", "-t", exactSession(sessionNameFor(bee.id, 1))]).status, 0);
    if (witness) assert.equal(server.try(["has-session", "-t", "=cleanup-witness"]).status, 0);
    assert.deepEqual(store.tmuxCleanupCounts(), {retained: 0, informational: 0});
  } catch (error) {
    if (error instanceof assert.AssertionError) console.error(JSON.stringify({otherSession: witness, ...diagnostic}));
    throw error;
  } finally {rig.cleanup(); store.close(); h.cleanup();}
});

for (const extraMember of [false, true]) test(`disposeAll cleans only the verified sole dead pane (extra member=${extraMember})`, {timeout: 15000}, async () => {
  const {TmuxServer, exactSession, shQuote} = await import("../src/tmux.ts");
  const {sessionNameFor} = await import("../src/driver.ts");
  const {inspectProcess, processDisposition} = await import("../../driver-hsr/src/psutil.ts");
  const h = harness(), store = h.open(), rig = makeRig({cleanup: store.tmuxCleanupHooks()}), server = new TmuxServer({socketPath: rig.socketPath});
  try {
    const {bee} = makeBee(store);
    rig.configure(bee.id, "transcript"); rig.driver.start(bee.id, 1);
    await drainUntil(rig.driver, rows => rows.some(row => row.kind === "booted"));
    const pid = Number(server.run(["display-message", "-p", "#{pid}"]));
    const observed = inspectProcess(pid); assert.equal(observed.kind, "present");
    if (observed.kind !== "present") throw new Error("Owned server birth unavailable");
    const identity = {pid, birth: observed.birth, bootId: observed.bootId};
    let extra: string | null = null;
    if (extraMember) extra = server.run(["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", exactSession(sessionNameFor(bee.id, 1)), `${shQuote(process.execPath)} -e ${shQuote("setInterval(()=>{},1000)")}`]);
    rig.driver.disposeAll();
    if (extra) {
      assert.equal(server.run(["display-message", "-p", "-t", extra, "#{pane_dead}"]), "0");
      assert.deepEqual(store.tmuxCleanupCounts(), {retained: 1, informational: 0});
    } else {
      const deadline = Date.now() + 3000;
      while (processDisposition(identity, inspectProcess(pid)) !== "exited" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(processDisposition(identity, inspectProcess(pid)), "exited");
      assert.deepEqual(store.tmuxCleanupCounts(), {retained: 0, informational: 0});
    }
  } finally {rig.cleanup(); store.close(); h.cleanup();}
});

for (const failure of ["duplicate", "post-create", "malformed-locator"] as const) test(`failed start retains without killing a session (${failure})`, async () => {
  const {TmuxServer, shQuote} = await import("../src/tmux.ts");
  const {sessionNameFor} = await import("../src/driver.ts");
  const h = harness(), store = h.open(), rig = makeRig({cleanup: store.tmuxCleanupHooks()}), server = new TmuxServer({socketPath: rig.socketPath});
  try {
    const {bee} = makeBee(store), name = sessionNameFor(bee.id, 1);
    rig.configure(bee.id, "transcript");
    let pane: string | null = null;
    if (failure === "duplicate") pane = server.run(["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", name, `${shQuote(process.execPath)} -e ${shQuote("setInterval(()=>{},1000)")}`]);
    else {
      const inner = (rig.driver as unknown as {server: InstanceType<typeof TmuxServer>}).server;
      const run = inner.run.bind(inner);
      inner.run = (args, options) => { if (failure === "post-create" && args[0] === "set-option") throw new Error("forced post-create failure"); const result = run(args, options); return failure === "malformed-locator" && args[0] === "new-session" ? "malformed" : result; };
    }
    rig.driver.start(bee.id, 1);
    assert.equal(server.run(["display-message", "-p", "-t", pane ?? `=${name}:`, "#{pane_dead}"]), "0");
    assert.deepEqual(store.tmuxCleanupCounts(), {retained: failure === "duplicate" ? 0 : 1, informational: 0});
    assert.equal(rig.driver.observe().some(row => row.kind === "exited"), true);
    assert.deepEqual(store.tmuxCleanupCounts(), {retained: failure === "duplicate" ? 0 : 1, informational: 0});
  } finally {rig.cleanup(); store.close(); h.cleanup();}
});

for (const stalled of ["list-panes", "if-shell"]) test(`disposal budgets a stalled ${stalled} command and retains cleanup`, {timeout: 10000}, async () => {
  const {mkdirSync, writeFileSync} = await import("node:fs");
  const {execFileSync} = await import("node:child_process");
  const {shQuote} = await import("../src/tmux.ts");
  const h = harness(), store = h.open(), rig = makeRig({cleanup: store.tmuxCleanupHooks()});
  const previous = process.env.PATH;
  try {
    const {bee} = makeBee(store);
    rig.configure(bee.id, "transcript"); rig.driver.start(bee.id, 1);
    await drainUntil(rig.driver, rows => rows.some(row => row.kind === "booted"));
    const real = execFileSync("which", ["tmux"], {encoding: "utf8"}).trim();
    const bin = join(rig.dir, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "tmux"), `#!/bin/sh\ncase "$*" in *${stalled}*) exec ${shQuote(process.execPath)} -e 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)' ;; *) exec ${shQuote(real)} "$@" ;; esac\n`, {mode: 0o700});
    process.env.PATH = bin + ":" + previous;
    const start = performance.now();
    rig.driver.disposeAll();
    assert.ok(performance.now() - start < 2750, "disposal exceeded its two-second command budget and scheduling margin");
    assert.deepEqual(store.tmuxCleanupCounts(), {retained: 1, informational: 0});
  } finally {if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; rig.cleanup(); store.close(); h.cleanup();}
});
