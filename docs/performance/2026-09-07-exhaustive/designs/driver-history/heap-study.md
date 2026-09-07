# HsrDriver.consumed heap study — read-only structural analysis

Consumed only after the probe report showed `completed: true`. Grounding
501710c1; the probe's recorded source hashes cover driver.ts, runner-host.ts,
and the stub adapter. No production edits, no new snapshots, no hosts, no
Mini. Every hash below is copied from completed tool output (the analyzer
embeds snapshot and tool digests in its JSON results); none were composed.

Reproducible offline analysis: `/tmp/honeybee-driver-history-heap-analyze.py`
(recorded toolSha256 `77ab0b69f3e4534ee2d144ff8797f9f7cb99e21a73b22e7a2b5db8f29fa6ae8d`
in both outputs), results in
`/tmp/honeybee-driver-history-heap-stopped.json` (snapshotSha256
`95e62e055d6a657abdf0f7a0d99d23ff1ef9d0adf84cd3d9ff1a5229628c512b`) and
`/tmp/honeybee-driver-history-heap-released.json` (snapshotSha256
`11719202e32a9159dc64ce01fd04cff16ad56220d771b5009030178f3f4e5e73`).

## Source shape (inspected independently at 501710c1)

`private readonly consumed = new Map<number, number>()` — driver.ts:320,
commented as "Delivery ground truth for the invariant checker: messageId →
generation." Written at the two delivery paths (:587, :614), read by
`consumedGeneration` (:1126-1127) and `consumedCount` (:1130-1131). There is
no delete or clear anywhere in the class: the map grows monotonically with
lifetime deliveries and survives runtime stop by construction, which the
probe proves behaviorally (`consumedCount() === 100000` re-asserted after
the host exits, every id's generation still 1). Whether that retention is
the intended ownership shape is the parent's separate review; this study
reports structure only.

## Probe (parent-authored; read for context)

Public `HsrDriver.deliver` of 100,000 sequential messages through a real
detached runner host into a provider-free child that asserts strict
sequential ids and writes an exact receipt; count proven externally before
either snapshot; deliveries and host I/O excluded from all memory readings;
stopped snapshot taken with the driver referenced and the host exited,
released snapshot after dropping the reference; whole-process phase readings
labeled diagnostic-only. Sound for its stated structural purpose.

## Method

Metadata-driven decoding (field widths, type enums, strings all from
`snapshot.meta`; edge offsets asserted to consume the edge array). Find
`HsrDriver` object nodes; follow the `consumed` property edge to the Map and
its single internal `table` edge; report SHALLOW self bytes; list bounded
incoming-edge retainers for the driver, the map, and the table; count the
table's outgoing edges BY TYPE as evidence, never as entries. Existence-only
comparison between the two snapshots. Explicit non-claims: no dominator or
retained-byte attribution, no whole-process numbers, no numeric cross-mode
or cross-snapshot arithmetic.

## Findings — stopped snapshot

- Exactly one `HsrDriver` instance (shallow 224 B, 13 edges). Its complete
  retaining path to the probe is a single chain: module context slot
  `driver` (system/Context) → HsrDriver → property `consumed` → Map
  (shallow 32 B — the JSMap header only) → internal `table` → one unnamed
  array node of **3,670,056 shallow bytes**.
- The table's outgoing edges are `{internal: 1}` — one edge total, ZERO
  element edges, against 100,000 externally proven entries. This is the
  smi rule made concrete: numeric keys and values are stored inline and
  emit no edges, so edge enumeration must never be used as an entry count.
  The entry-count authority is the probe's receipt, not the snapshot.
- Layout arithmetic (a consistency cross-check, not an entry measurement):
  (3,670,056 − 16) / 8 = 458,755 slots = 3 header slots + 7 × 65,536 —
  exactly the OrderedHashMap shape (3 header + B buckets + 3 × 2B entry
  slots) at B = 65,536, capacity 131,072 ≥ 100,000. The observed shallow
  size fits the documented layout to the byte at the proven count; at this
  fill that is ~36.7 shallow bytes per entry, stated as arithmetic on the
  observed node, nothing more.

## Findings — released snapshot (existence only)

Zero `HsrDriver` instances, zero `consumed` maps, zero backing tables. The
entire structure is absent once the probe's reference is dropped — the
map's only observed retainer was the driver itself, and the driver's only
observed retainer was the probe's context slot, so nothing else in the
process keeps delivery history alive. No numeric comparison is made with
any none-mode reading.

## Boundaries

Shallow bytes describe the named nodes alone; the map's true footprint
under other workloads (non-smi ids beyond smi range, doubles) would differ
and was not measured. Retainer listings are bounded (12 per node) and
single-level per node; nothing here ranks dominators. Ownership review —
whether an unbounded per-delivery ground-truth map should survive stop, be
capped, or be handed to the invariant checker differently — belongs to the
parent.

## Addendum (parent-accepted scope notes; append-only, no rerun, no tool edits)

1. **Analyzer classification gap, recorded for future use.** The analyzer
   stores whatever the `consumed` property edge targets under the
   `consumedMap` key without checking the target node's type/name, and the
   stdout summary counts every such property as a Map. On THIS baseline
   that is safe because the 501710c1 source proves the field is always a
   `new Map(...)` and the run found exactly one object/Map target — but the
   tool as-is is NOT valid for a future null/disabled-recorder candidate,
   where a null, undefined, or differently-shaped `consumed` target would
   be miscounted as a Map. Classification (type/name check with a labeled
   slot state, as the reviewed cache inspector v2 does) must be added
   before the tool is pointed at any such candidate.
2. **The smi statement is fixture-qualified.** "Numeric keys/values are
   smis and emit no edges" holds for THIS fixture's values — ids 1..100000
   and generation 1 are all within smi range. Larger numeric ids or
   non-smi numerics would be heap numbers with real edges, changing both
   the edge picture and the table's byte shape, as the Boundaries note
   already gestures at; the zero-element-edge finding is evidence about
   this snapshot, not a general law of numeric maps.
3. For downstream use the parent relies on the measured table shallow
   bytes and actual edge counts only; the layout arithmetic here remains a
   labeled consistency cross-check, not an input to any conclusion.
