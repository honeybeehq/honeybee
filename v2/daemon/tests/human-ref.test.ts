import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";
import type { AuditRow } from "../../core/src/types.ts";
import type { HumanRefEnrollResult, HumanRefReceipt, HumanRefStatusResult, SnapshotResult, SpawnResult, WatchFrame } from "../src/protocol.ts";
import { resolveBeeIn, runV2Cli } from "../../cli/src/main.ts";

test("human-ref two-daemon smoke: serial reserve/enroll, colliding aliases, deltas, CLI, offline issuance and restart", async () => {
  const a = makeDaemonDir(), b = makeDaemonDir();
  let authority: DaemonHandle | null = null, peer: DaemonHandle | null = null;
  try {
    authority = await startDaemon(a.dir); peer = await startDaemon(b.dir);
    let ac = await authority.client(), bc = await peer.client();
    const ast = await ac.request<HumanRefStatusResult>("humanRef.status");
    const bst = await bc.request<HumanRefStatusResult>("humanRef.status");
    assert.equal(ast.issuer, null); assert.equal(bst.issuer, null);
    const first = await ac.request<SpawnResult>("spawn", { name: "first", agent: "stub", cwd: "/tmp" });
    const second = await bc.request<SpawnResult>("spawn", { name: "second", agent: "stub", cwd: "/tmp" });
    assert.equal(first.handle, second.handle, "two independent installations have the same legacy alias");
    assert.equal(first.humanRef, null);
    const watcher = await peer.client();
    const events: AuditRow[] = [];
    let seq = -1;
    watcher.onEvent = (frame: WatchFrame) => {
      if (frame.type === "gap") throw new Error("unexpected gap");
      assert.equal(frame.baseSeq, seq); seq = frame.seq; events.push(...frame.events);
    };
    seq = (await watcher.request<SnapshotResult>("watch")).seq;
    const out: string[] = [], err: string[] = [];
    const io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s) };
    assert.equal(await runV2Cli(["human-ref", "registry", "init", "--data-dir", a.dir], io), 0, err.join("\n"));
    const [ar, br, replay] = await Promise.all([
      ac.request<HumanRefReceipt>("humanRef.registry.reserve", { installationId: ast.installationId }),
      ac.request<HumanRefReceipt>("humanRef.registry.reserve", { installationId: bst.installationId }),
      ac.request<HumanRefReceipt>("humanRef.registry.reserve", { installationId: ast.installationId }),
    ]);
    assert.deepEqual(replay, ar); assert.notEqual(ar.namespace, br.namespace);
    assert.equal(ar.authorityId, br.authorityId);
    await ac.request<HumanRefEnrollResult>("humanRef.enroll", { receipt: ar });
    const receiptPath = join(b.dir, "receipt.json"); writeFileSync(receiptPath, JSON.stringify(br));
    assert.equal(await runV2Cli(["human-ref", "enroll", receiptPath, "--data-dir", b.dir], io), 0, err.join("\n"));
    assert.equal((await bc.request<HumanRefEnrollResult>("humanRef.enroll", { receipt: br })).applied, false);
    await waitFor(() => events.find((e) => e.kind === "bee.human_ref"), "reference delta");
    assert.deepEqual(events.find((e) => e.kind === "bee.human_ref")?.payload, { beeId: second.beeId, human_ref: `${second.handle}.${br.namespace}`, issuing_namespace: br.namespace });
    await assert.rejects(bc.request("humanRef.enroll", { receipt: { ...br, namespace: "tampered" } }), /invalid allocation receipt/);
    const asnap = await ac.request<SnapshotResult>("snapshot"), bsnap = await bc.request<SnapshotResult>("snapshot");
    const abee = asnap.views.find(v => v.bee?.id === first.beeId)!.bee!;
    const bbee = bsnap.views.find(v => v.bee?.id === second.beeId)!.bee!;
    assert.equal(abee.human_ref, `${first.handle}.${ar.namespace}`);
    assert.equal(bbee.human_ref, `${second.handle}.${br.namespace}`);
    assert.notEqual(abee.human_ref, bbee.human_ref);
    assert.equal(bbee.issuing_namespace, br.namespace);
    assert.throws(() => resolveBeeIn([...asnap.views, ...bsnap.views], first.handle!), /ambiguous/);
    assert.equal(resolveBeeIn([...asnap.views, ...bsnap.views], bbee.human_ref!), second.beeId);
    out.length = 0;
    assert.equal(await runV2Cli(["view", bbee.human_ref!, "--data-dir", b.dir], io), 0, err.join("\n"));
    assert.ok(out.join("\n").includes(bbee.human_ref!));
    out.length = 0;
    assert.equal(await runV2Cli(["human-ref", "status", "--data-dir", b.dir, "--json"], io), 0);
    assert.equal((JSON.parse(out[0]!) as HumanRefStatusResult).installationId, bst.installationId);
    watcher.close(); ac.close();
    await authority.stop(); authority = null; // Selected registry is actually offline.
    const offline = await bc.request<SpawnResult>("spawn", { name: "offline", agent: "stub", cwd: "/tmp" });
    assert.equal(offline.humanRef, `${offline.handle}.${br.namespace}`);
    assert.equal(offline.issuingNamespace, br.namespace);
    bc.close(); await peer.stop(); peer = await startDaemon(b.dir); bc = await peer.client();
    assert.equal((await bc.request<HumanRefStatusResult>("humanRef.status")).issuer?.namespace, br.namespace);
    const reopened = await bc.request<SpawnResult>("spawn", { name: "reopened", agent: "stub", cwd: "/tmp" });
    assert.equal(reopened.issuingNamespace, br.namespace); assert.notEqual(reopened.humanRef, offline.humanRef);
    bc.close();
    authority = await startDaemon(a.dir); ac = await authority.client();
    assert.deepEqual(await ac.request<HumanRefReceipt>("humanRef.registry.reserve", { installationId: bst.installationId }), br);
    ac.close();
  } finally { await authority?.stop().catch(() => {}); await peer?.stop().catch(() => {}); a.cleanup(); b.cleanup(); }
});
