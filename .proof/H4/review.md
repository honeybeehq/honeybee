# Independent audit

Reviewer: `claude-opus-5-5`, session `71596f84-a3a1-4ce7-9857-5d08682e9d8c`.

The reviewer read the source diff against d532471e and the parent transcript. Labs were run by the author; the reviewer did not independently run them. Exact final refresh hunks were sent to the reviewer.

Resolved findings: refreshable blank access lost its recovery path; live siblings prevented repair; the quota map missed the damaged code; orphaned hold flags survived restart; stopped auth attention did not derive needs-you; damaged refresh deferred indefinitely to a live sibling. Final exact-hunk review accepted the repair lock/revision fencing and the existing bounded takeover path.

The real-bound lab's earlier SQLite-lock and wrong-RPC-shape failures were superseded by an RPC-only run proving needs-you, watch attention and same-command recovery. The audit trail includes corrections for manually approximated timestamps and Project publication after initial edits. The five-line diagnosis preceded implementation.

Final verdict: ready to propose under DEPLOY HOLD once final gates complete. Final check, v2:check and build completed successfully; focused account/auth/admission tests passed. Known base failures are recorded in the gate receipts.

Attention: source selection can still prefer an expired nonblank vault chain over a blank HOME carrying a newer refresh token. This unproven residual edge is documented for Queen; alternate-chain retries require separate authority analysis. Other limits are the wall-clock bound, per-snapshot readiness reads, one-second hold scheduling cap, delayed mirror attention without account events, and dedicated unit-test debt under the brief's no-new-tests restriction.

## Queen-requested additive revision

The preceding verdict and residual edge describe f5427450 only. Queen requested changes; the additive revision fixes the stale-vault chain selection, requires a bounded provider identity match before repair, classifies all reported blank shapes as damaged, guards active credential operations, preserves true non-auth hold causes and backs off verification. The R2 reviewer read the updated exact source hunks and accepted the narrow prefix-derived needs-you behavior, matching across direct/list/read-only views. Ordinary quota behavior is explicitly covered.

The reviewer accepted a conservative trade-off: an expired-vault-only refresh chain now requires login or renewed live material while live material exists, even for an undamaged expired HOME. Its error is source-unconfirmed rather than damaged. No alternate-chain refresh retry is attempted. The old unsafe vault-over-live-chain ordering gap is closed. Final exact-commit check attaches to the superseding proof; author ran labs and gates, reviewer checked source and receipts.

The existing empty-file admission assertion changed to the damaged code. Dedicated unit-test debt remains; no new unit tests or code comments were added. Twenty Queen scenarios, controlled-clock backoff/typed-hold/read-only parity, the real 60-second watch/recovery run, E2 and C4 are recorded with R2 receipts. Final gate outcomes are in `receipts/gates-r2.json`.
