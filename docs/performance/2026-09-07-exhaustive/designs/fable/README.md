# Candidate: seq-validated cross-tick snapshot reuse (Fable lane)

Arena candidate for the Honeybee quiet-tick performance target. Read-only design
against baseline `343289fe`; no repository files were changed.

**Target.** `DaemonCore.stepPhases` (v2/daemon/src/loops.ts:276) rebuilds the full
roster read-model every 200ms tick even when nothing happened. Parent profile at
1,000 retained stopped bees: snapshot phases are 682.6ms of 722.7ms CPU over 30
ticks (~94%), allocations ~3.7MB/tick dominated by `listBees` (59.5MB),
`listBeeViewRows` (18.5MB), `mapBee` (8.8MB) of 109.7MB sampled.

**Design in one sentence.** Hoist the already-existing within-tick audit-seq
snapshot reuse (`refreshSnapshot`, loops.ts:328) across ticks — cache the last
committed `{snapshot, seq}` in `DaemonCore`, revalidate each acquisition with one
`lastAuditSeq()` probe, and precompute tiny derived subsets (`booting`, `idle`,
`rowsById`) at rebuild so the per-tick policy walks are O(actionable) instead of
O(roster). Zero new public API, zero store/schema changes, behavior-identical
including log order.

**Predicted effect.** Quiet-tick mapping cost drops from ~22.8ms CPU +
~3.7MB allocation per tick to one B-tree MAX probe plus empty-subset walks
(sub-0.1ms, ~zero allocation). Rebuild ticks (any committed write) cost exactly
what every tick costs today.

## Files

| File | Content |
| --- | --- |
| `rationale.md` | Problem, caller-first usage, shape, tradeoffs, alternatives (incl. the losing fresh-query design), open questions |
| `sketch.ts` | Type sketch, signatures, module map — the loops.ts delta with `not implemented` bodies and pseudocode |
| `correctness-gates.md` | Specific gates mapped to the invariants the task names, with commands |

Grounding read: `v2/daemon/src/loops.ts`, `v2/core/src/store.ts`,
`v2/core/src/view.ts`, `v2/core/src/schema.ts`, `v2/daemon/src/daemon.ts`
(tick loop), `v2/harness/src/daemon.ts` (SimDaemon), parent's
`quiet-tick-design.md`, `evidence/quiet-before.json`, and the mid-run
`quiet-profile-before.json` summary.
