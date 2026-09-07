# Read-only study: auto-title roster materialization after 8e57

Status: source and existing evidence inspection only. No production, test, ruler, or worktree files changed. No new captures were run. None of the alternatives below is accepted by this document.

## Exact current path

The accepted tip inspected is `8e57e74615801f6e294f209ac9f2cb29c2ce4f55`. Its `v2/daemon/src/autoTitle.ts` hash is `ffececcc9fa976b3a10cf025a90ee9ce12c211324eeddd9a14e383638d6e768d`, identical to the frozen Unit 2 author file.

On each enabled, no-in-flight, no-argument store scan, `autoTitle.ts:167` calls `deps.listBees()`. `CoreStore.listBees()` at `store.ts:1823` runs:

```sql
SELECT * FROM bees ORDER BY id
```

It materializes every raw row, then maps every row through `mapBee`. The mapper constructs a 26-field `BeeRow` and parses `tags`, `env`, and `args` JSON. The scan uses only `id`, `lifecycle`, and `title` from those rows. It first builds the complete active-untitled ID set for cache pruning, then walks the same roster in ID order.

The daemon invokes this scan at most once per second. Disabled calls and calls while a title generation occupies the slot return before the roster read and before pruning. On a real store scan, the row read at scan entry is the lifecycle/title freshness boundary. The code deliberately does not re-read each Bee before inspecting its mailbox.

## What the existing profile establishes

Evidence files:

- `/tmp/honeybee-autotitle-evidence/mini-autotitle-v1-quiet-canonical-profile.json`, SHA-256 `f45c2b4a7040cc8a39011c9cf19c2e0109660fe90e279e6c354b09b934de32fe`.
- `/tmp/honeybee-autotitle-evidence/mini-autotitle-v1-allocation-ancestry.json`, SHA-256 `3d8b8e06f35d74d9e2fdb98b6571f827d1c7bd5c6f8540a505ac50ab90f3dc90`.
- Ruler hash `8e4d3cacea90a15760de59b40e65f37a692a1bfd12d5b20aba42a753cd9d2f67` and SQL tracer hash `e16ef5f0cc9c265482a7ac08cc331cecb97709be12f0df4f5f9f04dcd903a754`.

Candidate side 1 is exact source `8e57e746`. Each allocation profile is one separate quiet replay and reports V8 sampled allocation traffic, including objects later collected. It is not retained memory or exact allocation accounting.

| Canonical candidate scenario | Sampled bytes | Roster SQL trace | Direct allocation ancestry |
| --- | ---: | --- | --- |
| 1,000 active untitled Bees, empty mailboxes | 2,752,672 | 1,000 rows, 148,890 text bytes, 1.212 ms wall | 2,006,232 in `listBees().all`, 317,744 in `mapBee`, and 12,192 in its `map`; 2,336,168 total, or 84.9% |
| 1,000 active untitled Bees, one thin message each | 2,884,912 | 1,000 rows, 147,890 text bytes, 1.194 ms wall | 356,552 in `mapBee`, 35,960 in the pruning `Set`; 2,492,400 is sampled at the dispatcher frame without a deeper child frame |

The empty-mailbox profile directly identifies full Bee-row materialization as the dominant sampled source. The thin profile supports the same target but does not let us assign its dispatcher-frame bytes solely to `listBees`. The canonical warmed whole-scan CPU medians were 3.114 ms and 3.255 ms respectively. Those numbers establish the remaining scale, not the gain of any proposed replacement.

## Small source-owned alternatives

### 1. Fresh three-field roster

Add a Core read that returns a freshly validated projection on every actual store scan:

```ts
type BeeTitleRosterRow = Readonly<Pick<BeeRow, "id" | "lifecycle" | "title">>;

class CoreStore {
  listBeeTitleRoster(): BeeTitleRosterRow[];
}
```

```sql
SELECT id, lifecycle, title
FROM bees
ORDER BY id
```

The store-backed no-argument path would use this read. `CoreStore.listBees()`, `AutoTitleDeps.listBees`, caller-supplied `BeeRow[]`, and every other public full-row consumer would remain unchanged. Core would validate the three unknown SQLite values instead of casting them. Daemon would continue to own active/title filtering, cache pruning, normalization, retry policy, and launch assembly.

This is the smallest semantic change. It keeps the exact roster contents and branch structure while removing 23 unused fields and all three JSON parses per Bee. It still allocates raw projected rows plus mapped rows for the complete roster and still scans titled and archived Bees.

### 2. Fresh active-untitled ID roster

Push only the existing pre-skip predicate into a dedicated Core read:

```ts
class CoreStore {
  listActiveUntitledBeeIds(): string[];
}
```

```sql
SELECT id
FROM bees
WHERE lifecycle = 'active'
  AND (title IS NULL OR title = '')
ORDER BY id
```

The empty-string arm is required. Current JavaScript treats both `null` and `""` as untitled, and `createBee` does not reject an empty initial title. `WHERE title IS NULL` would change behavior.

This result is still the complete roster needed for pruning, not the eight-probe prefix. It reduces both column width and rows when most Bees are archived or titled. It needs a small store-only dispatch path that represents the SQL result as a known active-untitled candidate. It must not fabricate a full `BeeRow` or use a cast to claim query semantics. Shared private decision helpers can accept the actual fields they use so title policy remains single-sourced.

This option moves more policy into the Core query than option 1. It should therefore be a separate measured candidate, not silently folded into the first projection patch.

### 3. Iterator-backed implementation of either fresh read

Core could consume the projected statement with `StatementSync.iterate()` into one final typed array, instead of retaining the `.all()` raw array and a mapped array at once. Do not expose the live SQLite iterator to daemon code. The daemon must possess the complete roster before it prunes and starts mailbox probes, so a public streaming API either changes that ordering or forces a second SQL traversal.

This is an implementation variation, not a reason to choose projection 1 or 2. It needs its own allocation comparison. The v2 core and daemon packages declare Node `>=24`, where `iterate()` and `setReturnArrays()` exist. The root package still declares Node `>=20`. If compatibility is judged at the root rather than the v2 package boundary, keep capability fallbacks. Node added [`iterate()` in 22.13](https://nodejs.org/api/sqlite.html#statementiteratenamedparameters-anonymousparameters) and [`setReturnArrays()` in 22.16](https://nodejs.org/api/sqlite.html#statementsetreturnarraysenabled). The accepted pending-row code already demonstrates a per-statement array-mode fallback. Any new cached statement must have one return mode for every user of that exact SQL key.

### 4. Cross-tick roster version and retained ID list

A commit-aware version could skip even the narrow fresh query when no Bee was created, deleted, archived, unarchived, titled, or otherwise changed from or into active-untitled state. This is the only option here that removes the O(total Bees) read on unchanged ticks, but it is not a small read-only change.

`total_changes()` would be conservative but unrelated daemon writes would invalidate it, the same weakness already rejected for mailbox reuse. A dedicated version requires coverage at every relevant successful SQL write, including writes whose surrounding method later throws and an outer transaction catches. Reads during any transaction must be uncacheable; rollback and reopen must not create equal-version aliases for different rosters. A schema trigger or durable version also adds write and storage cost. This option should wait unless a measured fresh projection leaves enough cost to justify writer work.

## Semantics every candidate must preserve

1. Full pruning comes first. Every actual no-argument store scan must identify all active untitled IDs before the probe-limited or launch-limited walk. An ID beyond the eight-probe prefix must keep its quiet baseline. A deleted, archived, or newly titled Bee must lose it on the next actual scan.
2. Store order is SQLite `ORDER BY id`. It controls which Bee consumes the single generation slot. Do not fetch unordered IDs and apply JavaScript sorting, which is not a proof of SQLite BINARY order for all valid IDs.
3. Lifecycle and title stay fresh at the same scan-entry boundary. A fresh projection may narrow fields, but a retained roster needs an independent committed change proof. Disabled and in-flight calls still perform no roster read and no prune.
4. The current pre-skip is `lifecycle !== "active" || title` and therefore uses string truthiness. Preserve the empty-title case. Deleted Bees remain absent rows.
5. On every membership miss, changed signature, retry expiry, or possible generation, preserve the current full `listMessages` read, message ordering, `userTaskMessages`, exact signature, saved bookkeeping bytes, probe count, and full launch context. `initialTask` remains the first non-thin envelope-stripped body over the complete ordered message list. `userMessages` remains the final three clamped nonempty texts.
6. Generation completion still does the existing fresh `getBee` presence/title check before `setBeeTitle`. Do not add a lifecycle completion check or fold that separate one-Bee read into this roster unit.
7. `createAutoTitleDispatcher(customDeps)` keeps its existing `AutoTitleDeps.listBees()` callback, callback order, synchronous reentry behavior, and arbitrary caller order. Calling a store dispatcher with an explicit `BeeRow[]` keeps the current per-Bee `getBee(candidate.id) ?? candidate` fallback and bypasses store reuse and any new projection.
8. Open outer or nested transactions may expose speculative roster rows just as `listBees` does today, but they must not consume or publish a mailbox baseline. Any roster-level cache must return an explicit uncacheable transaction variant.
9. Keep the synchronous scan phase, one global generation slot, one launch per scan, eight transition probes, watchdog fencing, outcome drain order, and one-second daemon cadence unchanged.

## Focused proof and later measurement

A production candidate should first use real-store differential tests against the accepted dispatcher. The fixture should mix active untitled, empty-title, titled, archived, deleted, newly created, and send-unarchived Bees; use IDs that make an accidental JavaScript re-sort visible. It also needs the existing greater-than-eight suffix-pruning, launch-order, supplied-roster, custom callback/reentry, outer/nested rollback, watchdog, exact state-byte, and exact launch-context cases without relaxing them.

The narrow Core read needs result validation and exact SQL-order tests. If array mode or iteration is used, prove object-row and array-row parity and verify no cached-statement mode collision. A transaction test must cover speculative create/title/archive/delete followed by rollback and the next committed scan.

Only after those proofs should a parent-owned A/A and A/B compare the fresh three-field and ID-only variants on the existing 1,000-Bee empty/thin fixtures, plus titled/archived-heavy and all-active-untitled controls. Record SQL rows/text bytes, sampled allocation ancestry, whole-scan CPU/wall, and retained state. No gain is claimed here.

## Recommendation for sequencing, not acceptance

Prototype option 1 first because it preserves the current full roster and almost all daemon control flow. Measure it. Option 2 is the next source-only candidate if unused rows remain material. Treat iterator mode as an independently measured implementation refinement. Do not add a roster cache or writer version in the same unit.

## Measurement-mode clarification

The 3.114 ms empty-fleet and 3.255 ms thin-fleet CPU medians cited above come from the candidate side of `mini-autotitle-v1-quiet-canonical-profile.json`. That is the separate profile-mode run used for allocation attribution. The accepted uninstrumented headline run is `mini-autotitle-v1-quiet-canonical-none.json`; its corresponding CPU medians are 3.133 ms and 3.302 ms. In both runs, the timed scan clocks stop before the separate allocation replay starts. Use the profile-mode values only with the profile attribution, and use 3.133 ms and 3.302 ms as the accepted headline values.
