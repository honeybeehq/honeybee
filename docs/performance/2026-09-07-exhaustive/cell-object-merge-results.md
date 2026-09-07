# Cell capture without a clean-merge checkout

Candidate `6984a6a2` changes only the diverged, clean merge path in `captureWork`. The existing isolated scratch clone remains. Its HEAD is detached at the target without populating a worktree; `merge-tree --write-tree` computes the merge and `commit-tree` records the same two parents and message. Conflicts, unsupported Git, or unexpected output use the existing checkout/merge fallback. Fetches, target CAS, refusal behavior, transient-ref cleanup, and rebase behavior are preserved.

This is a synchronous capture optimization. It does not change RPC serialization, Cell lifetime, worker spawning, or deletion semantics.

## Canonical paired result

M4 Mini, Node 24.18.0, Apple Git 2.39.5, two immutable checkouts (`b86921c6` and `6984a6a2`), 2,000 files, 12 Cell commits, 15 ABBA rounds and 30 uninstrumented observations per side. The frozen ruler permits exactly capture.ts to differ among measured production sources and verifies exact reports, landed SHA/tree/parents, origin and Cell state, and transient-ref cleanup after every observation.

| Case | Before wall p50, ms | Candidate wall p50, ms |
| --- | ---: | ---: |
| Clean merge | 400.25 | 94.86 |
| Rebase | 734.62 | 734.02 |
| Merge conflict | 444.45 | 459.34 |
| Rebase conflict | 498.76 | 496.75 |
| Fast-forward | 51.76 | 51.73 |
| Create branch | 40.87 | 40.85 |
| Nothing to capture | 39.20 | 39.07 |
| Checked-out refusal | 9.90 | 9.81 |

Clean merge is about 76% faster. Conflicting merge costs about 15 ms more (3.4%) because the attempted object merge precedes the fallback. In the 12-file smoke, clean merge is 98.99→88.74 ms and conflict is 88.84→100.00 ms. The fallback cost matters most for tiny conflicting repositories; it is not a universal speedup.

Clean-merge parent Node CPU drops 73.376→5.124 ms. This includes the parent's own capture cleanup but excludes Git child CPU. It must not be labeled total capture CPU. Separate Trace2 diagnostics attribute the changed Git work; traced timings do not enter the wall table. Canonical clean merge has 13 top-level Git commands on both sides and 19→17 processes including nested children. Their summed top-level traced wall is 278.976→40.787 ms; stress is 1133.369→63.985 ms. Counts explain removed nested work; process count alone does not explain the checkout cost.

The original identical-checkout canonical control has clean-merge wall difference 0.43% and rebase difference 11.6%. The clean-merge gain is much larger than that control drift. Rebase remains an unchanged control, not an optimization claim. The separate 10,000-file stress capture passed all eight cases, with six observations per side. Clean merge falls 1615.594→120.456 ms (92.5%); merge conflict is 1765.250→1760.461 ms, within its unchanged-source control drift. That does not negate the measured canonical/smoke conflict cost. Six observations do not establish tail percentiles.

## Parity and remaining gates

The differential suite forces only `merge-tree` to report unsupported status on its fallback side. All nine fixtures passed on Studio Git 2.52.0 and Mini Git 2.39.5: disjoint clean edits, target union attributes, Cell binary attributes, rename/modify, delete/modify conflict, executable bit plus symlink, bounded gitlink, macOS case collision, and criss-cross ancestry with exactly two merge bases. The final case also asserts the semantic merged file content. Exact landed hashes check identity/message as well as tree and parent order. Both sides assert origin/Cell restoration and no transient refs.

Nine fixtures run inside one test; Mini's log reports seven tests total when combined with the six existing base capture tests. Driver-cell typecheck and repository build pass. The absence shim does not emulate every older Git implementation, and these cases are not a proof for every merge history or platform.

The production prototype is committed for immutable measurement. Accepted and integrated with main's empty-rebase and Cell-move changes as `86ddf953`. Combined verification passed build, all v2 typechecks, core212, daemon299/one skip, CLI59, and adapters70. Four Cell tests reproduced an existing input-connection readiness race on the pre-Cell-change checkout. Test-only `7eb8ecb7` retries only `not_ready` within five seconds; full Cell then passes70/one platform skip, followed by driver-cell typecheck and build. All failure logs remain. [Review](../../review/2026-09-07-perf-cell-object-merge.md). Reports: `mini-cell-tree-ab-{smoke,canonical,stress}.json`, adjacent hashed Trace2 sidecars, and `verification/mini-cell-tree-*.log`.
