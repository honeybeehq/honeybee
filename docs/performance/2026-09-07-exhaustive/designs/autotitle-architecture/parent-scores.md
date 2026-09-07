# Parent rubric scores before seeing the cross-judge

Both four-file packages were read end to end. Frozen hashes verified. Scores assess the authored designs, not a corrected implementation. Three means the criterion is met, two needs a bounded correction, one has a material unresolved issue, zero fails the criterion.

| Criterion | Fable | Sol |
|---|---:|---:|
| Exact policy/context/bookkeeping |1|2|
| Rollback/lifecycle/reentry |1|2|
| Bounded retained state |2|2|
| Honest complexity/measurement |1|3|
| Ownership and interface depth |2|2|
| Minimal verifiable sequence |2|2|
| Total |9|13|

Fable's small read-only Core method and quiet-path-only reuse are useful. Its separate evaluate/record protocol relies on a false no-await atomicity argument for custom callbacks. Its backoff sketch omits lastAt truthiness, and the per-arm stamp changes on delivery despite the claimed silence. The giant probe estimate is also refuted by the actual Mini planning diagnostic. These are bounded corrections, but prevent shipping the sketch as written.

Sol keeps custom callback behavior outside reuse and describes actual write overhead as an unresolved cost. Its bounded title summary captures the right information, backed by the author's differential. The initial-version/deletion behavior is underspecified, and the new transaction path must stage effects immediately at successful SQL writes, including caught nested errors. The selected-body launch path and policy rewrite add more scope than needed to remove repeated quiet reads.

Provisional synthesis for judge comparison: use Sol's private store-only boundary and a rigorously bounded committed-version mechanism, but graft Fable's quiet-path-only reuse. Keep existing full normalization and full launch hydration until those costs are independently measured. No generic callback cache. No new sidecar/schema. The committed-version mechanism is not accepted until its direct existing-on-open deletion and nested-caught-write contracts are executable and its read/write/RAM tradeoffs are priced.

Lower-risk fallback remains a single combined total COUNT/global MAX identity queried over both partial-index arms inside the trusted store wrapper. It costs3.2ms on the measured100k planning fixture, which must be stated. A global total_changes token avoids mutation hooks but empirically invalidates on unrelated/audited no-op activity; any comparison must include a busy daemon with otherwise unchanged giant mailbox contents.
