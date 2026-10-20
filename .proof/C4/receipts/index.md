# C4 receipt index

- `G-owner-source-and-proactive/r6/result.json`: passing real Apiary owner H1 to execution H2 source-reset restoration; one continuation without a human send.
- `G-owner-source-and-proactive/r6/owner-reservation.json`: one confirmed same-source reservation with the approval witness.
- `G-owner-source-and-proactive/r7/result-first-run.json`: **superseded: lab assertion scanned row 1's limit lines; see G r7 after.json**.
- `G-owner-source-and-proactive/r7/after.json`: scoped proactive evidence: generation 3 to 4, quota null, maxProjectedPercent 95, and zero quota.observed after recovery creation. `r7/owner-reservation.json` shows the source excluded and no source-restoration witness.
- `queen-final-rpc-lab/summary.json`: passing two-real-Honeybee-node RPC lab; four refused holds released, one source restore confirmed, zero outstanding unconfirmed holds.
- `queen-final-gates/`: passing final typechecks, build and 128 existing tests. `queen-final-allocation-digest.log`: nine passing allocation/checkpoint checks.

G confirmed the first r7 failure was a lab assertion bug, not a product failure (orchestrator message 10932, 2026-10-20T09:35:33Z). The assertion `!/hit your/` scanned the last 20 lines of the whole Champion journal; lines 10–11 belonged to row 1's deliberate weekly limit on generation 1, claude-a. Row 7's scoped proactive evidence has zero quota.observed after its creation. The original failed result remains intact except for path sanitization.

G provenance: Apiary `review/sar-G-quota-lab` at `95c26fb7453a12f96a3bdb853aba5c081fffbb34`, original `.proof/G/final/rows/r7/after.json`, curated `scripts/quota-lab/receipts/2026-10-20-owner-source-and-proactive/r7/after.json`, imported here as `G-owner-source-and-proactive/r7/after.json`.

Raw home and Cell checkout prefixes in the receipt bundle are sanitized to `<HOME>/<CELL>`.

## Final E2 rebase verification

`E2-rebase/replay.json` maps all six old and new commits: zero conflicts, identical patch IDs, no extra production delta. Base is E2 `50577b6355a8d684f5923d821b241be29e1b5b8c`. `E2-rebase/rpc-lab/summary.json` is the fresh two-Honeybee-node proof on that base; `E2-rebase/gates/` holds fresh check, v2:check, build and existing-suite results. Allocation/checkpoint results are adjacent. The real Apiary G receipt above remains historical integration evidence on the identical C4 patches; no new full Apiary run is claimed for this mechanical rebase. New receipt paths are sanitized too.
