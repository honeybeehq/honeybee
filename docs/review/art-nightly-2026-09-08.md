# Art nightly Honeybee review, 2026-09-08

Reviewed all 27 exact candidates against frozen main `a60e679f9cb62896caa08c0c53dff9b0d5e86485`. The [per-SHA ledger](art-nightly-2026-09-08-evidence/outcomes.json) records full diff hashes, callers, tests, branch applicability and later supersession. [Ancestry](art-nightly-2026-09-08-evidence/ancestry.json) confirms that none of these 27 candidates is a merge. Branch-only work remains isolated. No push, deployment or live runtime change was performed.

## Finding and repair

Medium severity: a root runtime inherited `HIVE_PARENT` from the daemon environment or agent configuration. `beeIdentityEnv` omitted the key for roots, so spreading it last did not remove an earlier value. A root could receive false instructions about whom it should report to. This remains present in the identity composition touched by `a60e679f`; it predates that commit, originating in the identity overlay introduced at `a277bfd7f19c28161e45cd69c7555d919aebdf26`.

The first integration run exposed the ambient-parent case. The deterministic reproduction then sets `HIVE_PARENT: "forged-spec-parent"` in the existing fake-Claude agent configuration. The unchanged assertion failed with actual `forged-spec-parent`, expected `null`. Both HSR and tmux environment assembly now delete the inherited key when the durable bee has no parent. Actual children still receive their stored parent ID. The same test passes through fork, delivery, revive and parent-stamp checks after the fix. The real process test covers HSR; the equivalent tmux assignment was inspected directly, without claiming a live tmux UI run.

[Red/green receipts](art-nightly-2026-09-08-evidence/checks.md#parent-red) preserve the failure and successful rerun. The repair changes neither stored lineage nor mailbox state.

## Simplification

The [complete module and candidate ledger](art-nightly-2026-09-08-evidence/simplification.json) records the skill source and digest, exact baselines, contracts, first and second passes, and every concrete disposition.

- Main: removed `DaemonCore.pendingStopExists`, a private pass-through to the store. All three policy callers now use the same store query directly. The same eight policy and urgent-delivery assertions pass before and after.
- Main: removed two repeated type decisions in `rpcCellExec` after the boundary has already rejected every other type. Omission, error ordering, request hashes and operation admission remain the same. The Cell RPC and move checks pass before and after.
- Artifact and release branches: exact manifest-byte equality already implies equality of the parsed artifact hash and bootstrap digest. Removed those two redundant comparisons. Retained parsing before comparison to preserve malformed-manifest diagnostics, and retained payload hashing, rollback checks and effect ordering. All 15 artifact tests pass before and after on each isolated branch.

Retained the distinct pending/confirmed delivery facts, generation-fenced stop predicates, router/Cell boundaries, stale-reader boundary, metadata-only resume branch and legacy envelope recognition. Their contracts differ; merging them would lose behavior or move responsibility into callers. The task-supply candidate already eliminates disabled-row decoding with SQL and needs no additional cache. Its code was not brought onto main. A second pass over every recorded module and caller found no further compatible simplification with sufficient proof.

## Verification and limitations

The [receipts](art-nightly-2026-09-08-evidence/checks.md) include exact commands, exit codes, portable excerpts and raw-log SHA-256 digests. Runtime was Node v25.8.0. The dependency lockfiles are identical between the inspected branches and main; branch checks use the installed dependencies through an isolated-checkout symlink. The repository has no separate lint script or configured `.github` workflows. Root Art owns publication and remote CI reconciliation.

The initial focused run passed 147 of 148 tests, including detached-runner survival and observation recovery. `budget.11` hit the five-second watchdog under concurrent load and observed `stopped_by_system` instead of its expected natural crash. Its isolated rerun passed both matched tests. The final loop suite also passed. The original failure remains recorded; no assertion or timeout was weakened.

The first CLI/RPC integration run passed 80 of 81 tests and exposed the parent-stamp defect. The deterministic parent red/green test proves its cause and repair. Final affected loop, argument, Cell and preflip suites passed 108 tests. Task-supply branch tests passed 10 core tests and 79 loop tests. Both artifact branch baselines and their simplified variants passed 15 tests each. Main and both artifact branches passed root and v2 typechecks and their production builds. The unchanged task-supply branch also passed both typecheck commands and its production build.

Historical September 7 evidence is reused only with [exact blob and digest identities](art-nightly-2026-09-08-evidence/prior-evidence-identity.json). [Fresh duplicate proof](art-nightly-2026-09-08-evidence/duplicate-proof.json) distinguishes equal patches from equal complete blobs. All 64 legacy test/callsite paths in the prior failure attribution still match frozen main. The broad legacy suite was not rerun and is not claimed green; its previously reported failures remain qualified historical evidence.

All 1,875 current performance-manifest entries match their byte lengths and SHA-256 values. The branch task-supply evidence was parsed and its raw distributions recomputed, with measured source fingerprints checked against exact committed blobs. Its historical CPU measurements remain stress-fixture results, not new production measurements. Incident-document live deployment and provider timing claims likewise remain attributed to their original authors. No live provider or complex desktop behavior is claimed by this review.

## Commits and handoff

Main simplification: `6600660bc4d549befb4d5e22d9ac0712468d0718`.

Main parent-identity repair: `88c967839d90d3133c459c116fa25e2f12c42b69`.

Isolated artifact simplification: `f20bb16feb6afbc9c907f360997a74f9c0bf88a4` on `art/nightly-2026-09-08-artifact-simplify`, based on `d20df402a62beea1e0f98354cf15bf641de5060d`.

Isolated release simplification: `e7e500f254573652a01e1be8be52fb1cc3ec378a` on `art/nightly-2026-09-08-release-simplify`, based on `29dce91870e0c5a4106d30db248dfea8d705226f`.

Run `python3 docs/review/art-nightly-2026-09-08-evidence/verify.py` in a clone containing the candidate objects to verify the portable identity and arithmetic evidence. This passed in the owned worktree. Root consumes `honeybee-result.json` and `honeybee-simplification.json` in the dated Art review directory. Historical root artifacts and live runtime state were left intact.
