// C1/C2 fidelity check — READ-ONLY scratch, real functions + real store.
// Proves/refutes with actual normalization, decision, and mutation semantics.
import { strict as assert } from "node:assert";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const WT = "/Users/trmd/Projects/trmd/honeybee/repos/honeybee-perf-c10-by-bee-2026-09-07";
const { userTaskMessages, contextSignature, autoTitleDecision } = await import(join(WT, "v2/daemon/src/autoTitle.ts"));
const { clampUserMessage, stripSessionEnvelopes, isThinOpener } = await import(join(WT, "v2/daemon/src/naming.ts"));
const { openCoreStore } = await import(join(WT, "v2/core/src/index.ts"));

const out = { c1: {}, giantStates: {}, c2: {} };
const bee = { id: "bee-x", lifecycle: "active", title: null };
const msg = (body) => ({ body });
const ENVELOPE = "<hive-session>generation 3 boot; transcript /tmp/x.jsonl</hive-session>";
const SUBSTANTIVE = "Migrate the billing exporter to the new ledger API and backfill March";

// ---------------------------------------------------------------- C1 ------
// A: k envelope-only rows ahead of the first real text — any FIXED first-k
// read computes an empty user set and the DECISION FLIPS defer<->generate.
{
  const k = 3;
  const rows = [...Array(k).fill(msg(ENVELOPE)), msg(SUBSTANTIVE)];
  const real = userTaskMessages(rows);
  assert.deepEqual(real, [clampUserMessage(SUBSTANTIVE)]);
  const realDecision = autoTitleDecision(bee, real, undefined, 1_000_000);
  assert.equal(realDecision.action, "generate", "one substantive user message titles immediately");
  const firstK = userTaskMessages(rows.slice(0, k)); // what a fixed first-k SQL sees
  assert.deepEqual(firstK, [], "every first-k body clamps to empty");
  const kDecision = autoTitleDecision(bee, firstK, undefined, 1_000_000);
  assert.equal(kDecision.action, "defer", "the first-k model DEFERS a bee the real scan TITLES");
  out.c1.decisionFlip = {
    rows: rows.length, firstK: k,
    real: realDecision.action, firstKModel: kDecision.action,
    note: "envelope-only rows are unbounded; no fixed k survives",
  };
}
// B: SQL COUNT(*) is row count, not nonempty-clamp count — signature drifts
// and a persisted deferral is spuriously invalidated.
{
  const rows = [msg(SUBSTANTIVE), msg(ENVELOPE), msg("   \n  ")];
  const real = userTaskMessages(rows);
  const realSig = contextSignature(bee, real);
  const sqlModelSig = [bee.lifecycle, String(rows.length), clampUserMessage(SUBSTANTIVE)].join("\0");
  assert.notEqual(realSig, sqlModelSig, "row count 3 vs clamped count 1: signatures diverge");
  out.c1.countDrift = { realCount: real.length, rowCount: rows.length };
}
// C: initialTask uses stripSessionEnvelopes WITHOUT the 700-char clamp; the
// clamped signature text cannot reconstruct the launch context.
{
  const long = `${"A".repeat(400)} middle detail that the clamp elides ${"Z".repeat(400)}`;
  const clamped = clampUserMessage(long);
  const initialTask = stripSessionEnvelopes(long);
  assert.notEqual(clamped, initialTask);
  assert.ok(initialTask.length > 700 && clamped.length <= 700);
  assert.ok(!isThinOpener(initialTask));
  out.c1.initialTaskDiffers = { clampedLength: clamped.length, initialTaskLength: initialTask.length };
}

// ------------------------------------------------- giant-state validity ---
// All-substantive mailboxes can NEVER defer: userMessages.length >= 2 makes
// the decision generate (no bookkeeping) or backoff-skip (failed attempts).
{
  const rows = Array.from({ length: 1000 }, (_, i) => msg(`${SUBSTANTIVE} step ${i}`));
  const users = userTaskMessages(rows);
  assert.equal(users.length, 1000);
  const fresh = autoTitleDecision(bee, users, undefined, 1_000_000);
  assert.equal(fresh.action, "generate");
  const sig = contextSignature(bee, users);
  const backoff = autoTitleDecision(
    bee, users,
    { attempts: 3, lastAt: 999_500, userTurns: 1000, deferred: false, signature: sig },
    1_000_000,
  );
  assert.deepEqual(backoff, { action: "skip", reason: "backoff" }, "failed attempts put a giant in BACKOFF, read every scan");
  const deferProbe = autoTitleDecision(bee, users, { attempts: 0, lastAt: 0, userTurns: 1000, deferred: true, signature: sig }, 1_000_000);
  assert.equal(deferProbe.action, "generate", "even deferred=true bookkeeping cannot hold a substantive mailbox: decision ignores it once messages are rich");
  out.giantStates.substantive = { fresh: fresh.action, withFailedAttempts: backoff, note: "valid sustained giant read state is backoff (or repeated launches); defer unreachable" };
  // The deferred-giant my study simulated requires envelope/whitespace-only
  // bodies (userMessages empty) — constructible, but synthetic:
  const envelopeRows = Array.from({ length: 1000 }, () => msg(ENVELOPE));
  const envUsers = userTaskMessages(envelopeRows);
  assert.deepEqual(envUsers, []);
  assert.equal(autoTitleDecision(bee, envUsers, undefined, 1_000_000).action, "defer");
  out.giantStates.envelopeOnly = { rows: 1000, userMessages: 0, decision: "defer", note: "deferred giant requires an envelope/whitespace-only flood" };
}

// ---------------------------------------------------------------- C2 ------
// (max id, row count) probe truth table on a REAL store: every committed
// membership mutation is detected; content-neutral ops are correctly silent.
{
  const dir = mkdtempSync(join(tmpdir(), "hb-c2-"));
  let t = 1_000_000;
  const store = openCoreStore(join(dir, "core.sqlite3"), { now: () => (t += 1000), ephemeral: true });
  const b = store.createBee({ name: "probe", agent: "claude", substrate: "tmux", cwd: "/tmp/w" }).bee;
  const pair = () => {
    const rows = store.listMessages(b.id);
    return { max: rows.at(-1)?.id ?? 0, count: rows.length };
  };
  const sigOf = () => contextSignature({ ...bee, id: b.id }, userTaskMessages(store.listMessages(b.id).map((m) => ({ body: m.body }))));
  const steps = [];
  const step = (name, mutate, expectDetect) => {
    const before = pair();
    const sigBefore = sigOf();
    mutate();
    const after = pair();
    const sigAfter = sigOf();
    const detected = before.max !== after.max || before.count !== after.count;
    const changed = sigBefore !== sigAfter;
    // Soundness: any signature change MUST be detected. (Detected-but-
    // unchanged is allowed and harmless: one extra full read.)
    if (changed) assert.equal(detected, true, `${name}: signature changed but probe silent`);
    steps.push({ name, before, after, detected, signatureChanged: changed, expectDetect });
    assert.equal(detected, expectDetect, `${name}: detection expectation`);
  };

  const m1 = store.send(b.id, "First real task message").message;
  const m2 = store.send(b.id, "Second message with detail").message;
  const m3 = store.send(b.id, "Third message").message;

  step("send", () => store.send(b.id, "Fourth message"), true);
  step("cancel highest pending", () => {
    const rows = store.undeliveredMessages(b.id);
    assert.deepEqual(store.cancelMessage(b.id, rows.at(-1).id), { canceled: true });
  }, true);
  step("cancel old + send new (count restored)", () => {
    assert.deepEqual(store.cancelMessage(b.id, m1.id), { canceled: true });
    store.send(b.id, "Replacement message");
  }, true); // AUTOINCREMENT: the new id EXCEEDS every prior id, max moves
  step("send then cancel the same message (net no-op)", () => {
    const m = store.send(b.id, "Transient").message;
    assert.deepEqual(store.cancelMessage(b.id, m.id), { canceled: true });
  }, false); // content identical at both scan points: correct silence
  step("markDelivered (membership-neutral)", () => {
    assert.deepEqual(store.markDelivered(m2.id, 1), { applied: true });
  }, false);
  step("expedite urgency (membership-neutral)", () => {
    store.expediteMessage(b.id, m3.id, "now");
  }, false);
  step("rollback of send+cancel", () => {
    const boom = new Error("rollback");
    assert.throws(() => store.transact(() => {
      store.send(b.id, "Rolled back");
      assert.deepEqual(store.cancelMessage(b.id, m3.id), { canceled: true });
      throw boom;
    }), boom);
  }, false);
  // Delivered mail cannot be canceled — membership of delivered history is
  // append-only (no production path deletes delivered rows).
  {
    const before = pair();
    const result = store.cancelMessage(b.id, m2.id);
    assert.equal(result.canceled, false, "cancel of a delivered message is refused");
    assert.deepEqual(pair(), before);
    steps.push({ name: "cancel delivered refused", detected: false, signatureChanged: false });
  }
  // AUTOINCREMENT no-reuse is load-bearing: after canceling the highest id,
  // the next send takes a HIGHER id, never the freed one.
  {
    const rows = store.undeliveredMessages(b.id);
    const highest = rows.at(-1).id;
    assert.deepEqual(store.cancelMessage(b.id, highest), { canceled: true });
    const next = store.send(b.id, "After highest cancel").message;
    assert.ok(next.id > highest, `AUTOINCREMENT: ${next.id} > freed ${highest}`);
    steps.push({ name: "no id reuse after cancel-highest", freed: highest, next: next.id });
  }
  // Reopen stability: the pair is a pure function of committed store state.
  const beforeReopen = pair();
  store.close();
  const reopened = openCoreStore(join(dir, "core.sqlite3"), { now: () => (t += 1000), ephemeral: true });
  const rowsAfter = reopened.listMessages(b.id);
  assert.deepEqual({ max: rowsAfter.at(-1)?.id ?? 0, count: rowsAfter.length }, beforeReopen);
  reopened.close();
  out.c2 = { steps, note: "soundness held on every step: no signature change went undetected" };
}

writeFileSync("/tmp/honeybee-autotitle-c1c2-fidelity.json", JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 1));
