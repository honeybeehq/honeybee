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
