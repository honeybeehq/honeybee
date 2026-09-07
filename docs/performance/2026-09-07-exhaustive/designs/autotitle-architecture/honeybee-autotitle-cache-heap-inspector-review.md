# Cache heap-inspector review — read-only (no edits, no new snapshots)

Subject: `/tmp/honeybee-autotitle-cache-heap-inspect.py` with
`/tmp/honeybee-autotitle-cache-heap-inspector-proof.json`, the synthetic
fixture generator/outputs, and the two real baseline structure reports.
Checked against the V8 heap-snapshot serialization format and the committed
a9e5ea91 source (plus its bc6554b6 core parent). Per the provenance rule, no
hashes appear here except values copied from completed tool output: all four
output JSONs and the proof record the same `toolSha256` (`ad87cf648853f10f…`),
verified by string comparison of the recorded fields.

## Verdict

APPROVED for candidate snapshot analysis of a9e5ea91-shaped snapshots. The
decoder is metadata-faithful, the traversal shape is the right one, the
positive and negative controls both pass, and the source alignment is exact.
One improvement is worth making before the tool is used as a bug DETECTOR
rather than a counter (finding 1); two operational notes bind future use.

## Format correctness (checked against V8 snapshot metadata)

- Field widths, type enums, and the strings table are all taken from
  `snapshot.meta` rather than hardcoded; the cumulative edge-offset table is
  built per node and asserted to consume the edge array exactly; the node
  accessor bounds-checks. This is the correct decoding of the flat arrays.
- `name_or_index` is treated as an index for `element`/`hidden` edges and a
  string otherwise — matching the serializer (context/property/internal/
  shortcut/weak carry names; element/hidden carry indices).
- Scanning CONTEXT nodes for a `context`-type edge named `quietBaselines`
  (rather than walking closures) is the load-bearing good decision: sibling
  closures share one Context node, so a shared slot is counted once and the
  multi-closure double-count trap never arises.
- Map traversal: `object`/`Map` node, exactly one `internal` `table` edge
  (asserted — loud on a future V8 layout change), then every non-weak edge
  of the backing store with target dedup. Keys, holes, and oddballs fall out
  of the `membership`+`signature` property filter naturally, and OrderedHashMap
  bucket/size cells are smis, which never appear as edges — so table headers
  cannot false-positive.
- Smi-valued `messageCount` emits no property edge; the parser correctly
  requires only `kind`, whose value is an interned heap string. The
  signature check accepts flat, concatenated, and sliced strings — right for
  a join() product.

## Source alignment (a9e5ea91)

- `quietBaselines` exists exactly once as a binding, in
  `createAutoTitleDispatcher` (autoTitle.ts:146), referenced only there
  (prune :178-179, get :197, set :216) — captured by inner code, so it
  materializes as a context slot; the identifier appears nowhere else in v2
  at this commit, so the name-collision surface for candidate snapshots is
  empty today.
- Entry shape matches the filter exactly: `QuietBaseline = { membership:
  CommittedMailboxMembership; signature: string }` (:115-118), stored as
  `{ membership: after, signature }` (:216); `CommittedMailboxMembership`
  carries a runtime `kind: "committed"` literal (core types.ts:272-276,
  constructed literally at the aggregate return site), so the kind-value
  assert tests a property that genuinely exists at runtime.

## Controls

Synthetic warm: 1 slot, 3 observed entries (fixture faithfully replicates
the real shape, including a `maxMessageId: null` case). Synthetic released:
0 slots. Real baseline warm/released (pre-candidate roots): 0 slots with
CoreStore object counts 1/0 — the negative direction is proven, not assumed.

## Findings

1. **(Medium, worth fixing before candidate analysis)** The two asserts
   inside the entry loop turn the most interesting possible discoveries into
   crashes without a report: a cached `transaction_open` membership or a
   non-string signature — precisely the candidate bugs a snapshot could
   reveal — abort the run before the output file is written. Recording such
   entries in a `violations` list and continuing would convert crashes into
   classified evidence. Loud-over-silent is safe as wiring; as a detector it
   discards the finding it just made.
2. **(Low, cosmetic)** A slot holding `null` (the `storeReuse === null`
   arm of :146) or a not-yet-Map value is recorded with no
   `observedEntryObjects` key; the summary prints `null`, which reads
   ambiguously against "0 entries". The full JSON disambiguates via
   `target.type/name`; a label would help readers.
3. **(Operational, binds future use)** The tool's correctness is pinned to
   this commit's shape in two ways it cannot check itself: the identifier
   (a rename silently zeroes every count) and the capture style (a future
   class-field holder instead of a captured binding would produce no context
   edge at all). The docstring assigns this to source review — discharged
   here for a9e5ea91 — and it must be re-discharged per analyzed commit.
4. **(Info)** Multiple dispatcher instances report as separate slots, which
   is correct; retained-ruler children construct one. `coreStoreObjects` is
   constructor-name based and fine for type-stripped runtime code.

No edits were made, no snapshots were generated, and no Mini or broad
activity occurred.

## Erratum (source citations; parent-caught, verified against a9e5ea91)

Two citations above are corrected; the findings they supported are
unaffected. The `quietBaselines` binding at autoTitle.ts:146 sits inside
`createAutoTitleDispatcherImpl` (:136), the private implementation
entrypoint both factories call — not inside `createAutoTitleDispatcher`
(:306) as written. `CommittedMailboxMembership` is defined in
`v2/core/src/store.ts:272-276`, not in types.ts — my own quoted grep output
said store.ts and I mislabeled the file in prose. Original sections above
are intact; this appends.

## Addendum: v2 delta review (read-only; v1 preserved separately)

The v2 diff implements exactly the review's findings 1 and 2 plus an honest
scope tightening, and it is APPROVED:

- The two in-loop asserts are now `membership_kind` and `signature_type`
  violation records carrying context and entry node ids plus the observed
  node, with the flagged entry still counted (right: it IS a recognized
  entry, just a malformed one). Both-violations-on-one-entry yields two
  records and one counted entry. The output file is written and the summary
  printed BEFORE `SystemExit(1 if violations else 0)`, so a nonzero exit
  now ships evidence instead of a stack trace — my finding 1's crash-
  discards-the-discovery hazard is gone.
- Non-Map slots carry `slotState: "not_map"` (Maps: `"map"`), resolving the
  ambiguous `null` entry count of finding 2 at the JSON level.
- The docstring now states the recognition boundary: violations cover
  objects with BOTH property edges; missing-property and smi-valued fields
  need separate source/behavior checks. That boundary is real and correctly
  drawn — a smi-valued `kind` would still surface (the property edge would
  be absent, so `membership_kind` fires with observed null), while an
  entry-like object missing `signature` entirely is structurally
  indistinguishable from a non-entry and is rightly out of scope.
- One residual, info-level: the `kind` check compares the value node's NAME
  to "committed" without requiring a string TYPE, so a heap object whose
  constructor happened to be named `committed` would pass silently —
  unconstructible in this codebase, noted only for completeness.

Verdict unchanged from the original review otherwise; the operational
note stands (re-verify the identifier and captured-binding shape per
analyzed commit — for a9e5ea91 that means `createAutoTitleDispatcherImpl`,
per the erratum above).
