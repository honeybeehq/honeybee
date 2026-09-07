# autoTitle C1/C2 fidelity check — correction report (appends, original frozen)

Companion to `/tmp/honeybee-autotitle-read-study.md` (bytes untouched).
Method: the REAL normalization/decision functions and a REAL CoreStore from
the c10 worktree (a67a48bb); every claim below is assertion-verified by
`/tmp/honeybee-autotitle-c1c2-fidelity.mjs`, results in
`/tmp/honeybee-autotitle-c1c2-fidelity.json`. No production edits.

## 1. The exact signature model (line-cited; my C1 framing was too loose)

- `userTaskMessages` (autoTitle.ts:60-67) pushes `clampUserMessage(body)`
  ONLY when the clamp is nonempty. `clampUserMessage` =
  `clampContext(stripSessionEnvelopes(body), preserveTail)` (naming.ts:155)
  — strips `<apiary-session>/<hive-session>` blocks (naming.ts:30-31),
  collapses whitespace, clamps to 700 chars (naming.ts:23) with head…tail.
- Signature (autoTitle.ts:69-75) = [lifecycle, count of NONEMPTY CLAMPED
  texts, first clamped text]. NOT mailbox row count.
- `initialTask` at launch (autoTitle.ts:184-186) is computed SEPARATELY:
  first `stripSessionEnvelopes(body)` that is not a thin opener — full
  text, NOT 700-clamped.
- Sender is ignored throughout: every row's body participates.

## 2. C1 (bounded signature read): REFUTED as an identical-decisions candidate

Real-function counterexamples (envelope bodies are real production traffic —
that is why the stripper exists):

- **Decision flip.** k envelope-only rows ahead of one substantive message:
  the real scan computes userMessages = [substantive] and the decision is
  GENERATE; any fixed first-k read sees only empty clamps and decides
  DEFER. k is unbounded, so no fixed k survives. (Asserted: real=generate,
  first-3 model=defer on 4 rows.)
- **Count drift.** [substantive, envelope-only, whitespace-only] → real
  count 1, SQL `COUNT(*)` 3. The drifted signature breaks the :148
  deferred-signature match, spuriously invalidating persisted deferrals
  and re-deciding every scan.
- **initialTask normalization.** An 800+-char first message: the signature
  text is the 700-char head…tail clamp, initialTask is the full stripped
  text (asserted unequal). A bounded clamped read cannot reconstruct the
  launch context.

Verdict: the signature's count ranges over ALL rows' JS-normalized bodies,
so any read that skips rows can flip decisions; a bounded-read-with-full-
fallback degenerates to the full read precisely on the envelope-heavy
mailboxes it targets, and the giant's count spans all 100k bodies every
scan regardless. **C1 cannot fix the giant read and is withdrawn as an
exactness-preserving candidate.** (An approximate variant would be a
titling-behavior change — out of scope by instruction.)

## 3. Giant-state validity: which sustained giant reads are real

Source argument, empirically confirmed: `deferred: true` is saved ONLY in
the defer branch (autoTitle.ts:159-167), and defer requires userMessages
∈ {[], [thin]} — so every defer-saved signature has count 0 or 1-with-thin
-first. A mailbox whose bodies are substantive produces a signature with a
non-thin first (and/or count ≥ 2) that can NEVER equal a defer-saved one,
so the :148 deferred-continue is unreachable for it — current decisions
cannot produce a deferred giant with substantive bodies (asserted: fresh →
generate; even a hand-seeded deferred=true record is bypassed once the
signature is recomputed... and a matching signature is unconstructible).

- **Valid sustained giant state: BACKOFF.** Failed generation attempts
  (asserted: attempts=3 bookkeeping → skip "backoff") — the bee is READ
  every scan, skipped after the read, no probe consumed; backoff caps at
  10 min, then it re-launches (one read + break + in-flight pause) and on
  failure re-enters backoff. During provider outages this sustains
  ~130 ms CPU per scan for a 100k-history bee.
- **Synthetic giant-deferred.** Reachable only via an envelope/whitespace-
  only flood (asserted: 1000 envelope rows → userMessages=[] → defer). My
  study's §3 extrapolation labeled this state "deferred"; the correction
  is the state attribution, not the arithmetic — a backoff giant is read
  every scan just the same.

## 4. C2 ((max id, count) change probe): proof and limitations

Mutation inventory (complete, source-cited): INSERT only in send
(store.ts:2651); DELETE only by id (:2928) reached via cancel of an
UNDELIVERED message (cancel of a delivered message is refused — asserted
`{canceled:false}`, rows untouched, so delivered history is append-only);
UPDATEs touch only urgency (:2950) and delivery stamps (:2985). **Bodies
and ids are immutable; membership changes only via send and pending-cancel.**

Invariance argument: mailbox.id is `INTEGER PRIMARY KEY AUTOINCREMENT`
(schema.ts:278) — a new send's id exceeds every id EVER issued, even freed
ones (asserted: after canceling highest id 5, the next send took 7 — the
rolled-past 6 was consumed by a canceled transient; the sequence never
rewinds). Therefore if (max, count) is equal at two scan points: no new
ids are present (all new ids would exceed the old max), so the current id
set is a subset of the old one; equal count makes it identical; immutable
bodies make every signature input identical. **Signature change ⇒ pair
change. Sound.**

Truth table (real store, all asserted): send DETECTED; cancel-highest
DETECTED (max and count both move); cancel-old + send-new with count
restored DETECTED (max moves past all prior ids); send-then-cancel-same
SILENT and correctly so (content at both scan points identical — the
probe compares states, not history); markDelivered SILENT (membership-
neutral; delivery does not affect userTaskMessages, which ignores
delivered_at); expedite SILENT (urgency is outside the signature);
transact ROLLBACK of send+cancel SILENT (committed state unchanged);
close/reopen pair stable.

Limitations (reported, per instruction no persisted-schema proposal):

1. `COUNT` per bee is O(index entries), not O(1): the giant's probe walks
   ~100k delivered-index entries body-free. Far below the row-fetch read,
   but not free — the parent's rulers would price it. max-only is
   insufficient (cancel of a NON-highest pending row moves neither max
   nor... only count), so both components are required.
2. The probe's baseline must live in the bookkeeping sidecar (a format
   extension, tolerant both directions: `loadBookkeepingFile` drops
   unknown fields, so an older daemon simply resumes full reads). No
   core-store schema change is proposed or needed.
3. The invariant leans on bodies-immutable and AUTOINCREMENT no-reuse. Any
   future body-edit or id-compaction feature silently breaks it — if C2
   is ever adopted this becomes a documented maintenance constraint with
   its own test.
4. No probe/read race exists: the scan and the probe run on the same
   single EXCLUSIVE connection in the same synchronous walk.
5. The lifecycle signature component is constant "active" inside the scan
   (the :143 pre-skip filters everything else) — the probe need not watch
   the bee row for it.
6. Because sender is ignored, system-sent envelope messages DO change the
   pair (send moves max) — a full read follows and correctly re-derives an
   unchanged-or-changed signature; this is the safe direction (extra read,
   never a missed change).

## 5. Standing

C1 withdrawn (exactness unpreservable); C2 sound with the four stated
limitations; C3 (read budget + rotating cursor, explicit-latency) and C4
(dirty set) remain as the study left them. Original study report bytes
frozen; scratch artifacts: honeybee-autotitle-c1c2-fidelity.{mjs,json}.
No production edits, no Mini, no broad tests.

## 6. Erratum (scan-study ramp arithmetic; parent-caught)

The 1000-bee empty/thin scenarios ran ceil(1000/8)+3 = 128 scans. The ramp
8+16+…+1000 spans 125 scans and totals 63,000 reads; the study's 66,000
figure is the harness TOTAL including the 3 already-steady scans
(3 × 1000), and its "~125 scans" wording conflated the two. Study report
bytes remain frozen; this append is the correction of record.

C2 persistence remains UNAPPROVED — restore/import compatibility and
stale-sidecar implications are open; a per-dispatcher in-memory baseline
(avoiding cross-restart invalidation assumptions entirely) is queued for
later evaluation. No expansion now.

## 7. C2 constraints of record (parent-added; no design expansion)

1. **AUTOINCREMENT protects previously COMMITTED rowids only.** The
   sqlite_sequence bump rolls back with its transaction, so a rolled-back
   send's id CAN be reused by the next committed send — with a different
   body. A baseline captured from an IN-TRANSACTION read (an uncommitted
   send visible on the same connection) could therefore survive rollback
   with equal (max, count) yet different content on the reused id: a
   missed change. My §4 proof holds only for baselines read from
   COMMITTED state — my rollback truth-table step read its pairs outside
   the transaction and could not catch this. Any future C2 design must
   publish/validate baselines committed-only (the Z01 `inTransaction`
   seam), or prove the scan boundary always runs outside transactions —
   true for today's tick-driven scan, but a constraint, not a given.
2. **The §4 membership inventory was incomplete: deleteBee's FK cascade
   (`DELETE FROM bees`, store.ts:1940, `ON DELETE CASCADE` on
   mailbox.bee_id) removes mailbox rows without the :2928 statement.**
   Per-bee (max, count) is unaffected for OTHER bees, and the deleted
   bee's baseline dies with the bee, but the inventory claim "membership
   changes only via send and pending-cancel" is corrected to include
   cascade deletion. No current C03 impact.
