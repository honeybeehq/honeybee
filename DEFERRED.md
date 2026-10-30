# Deferred review minors

- **SEM-14 — durable edge-firing memory:** `edgeFiringTail` remains the bounded dedupe/join-success source; replacing it requires a new durable firing index and record migration, beyond a cheap fix.
- **SEM-16 — late seals after ordinary terminal completion:** terminal, non-invalidated activations are not rescanned; durable post-completion audit ingestion needs an explicit retention/sweep policy so completed runs do not remain sweepable forever.
- **contracts-008 — full invalid-output routing matrix:** direct retry and attempts-exhaustion paths are covered, but controller-level invalid-seal forward escalation/no-route/exhaustion permutations are deferred as additional coverage rather than a known semantic defect.

## Delta-review additions (2026-07-28, non-blocking, queued for slice 1.1)
- SEM-13 PARTIAL: subject compare still self-referential.
- SEM-17 PARTIAL: active-run late spawn success leaves bee unowned.
- **DELTA-5 — persisted agent-adoption replans:** recovery intentionally replays the persisted adoption request, so its digest check proves stored-request integrity but cannot detect a newly rendered custom brief that diverges under the same semantic key. Fixing this requires separating stable semantic fields from replay-only transport fields, like the broader SEM-13 migration, rather than discarding the request that closes the attach/adopt crash window.
- NEW: stale-claim `releaseClaim` corrupt_state sweep-loop after crash-window repair.
- NEW: support-root recreation bypasses per-node attempt caps.

## W7a fix-round residuals (2026-07-28)

- **Human stall notification delivery and escalation state (W7A-8):** clock evidence and timeout-edge firing are correct, but buz delivery is still one-shot and recorded before delivery, and only the first threshold notifies. A durable per-edge notification outbox/state machine is deferred because it changes the run schema and requires retry/backoff policy rather than a local correctness patch.
- **Production revision-movement trigger for packet successors (W7A-9):** successor creation and thread linkage are covered, but slice 1 has no subscription/amendment path that advances a live activation's subject revision. W8 must drive the successor through a real revision event and retain the integration fixture; inventing a second revision authority in W7a would violate scope.
- **Unauthenticated verdict-actor residual risk (W7A-10):** ordinary `origin=comb` verification packet kinds do not yet receive Forum's comb-only required-author and exact-pin enforcement. Honeybee checks packet identity, freshness, engine-side pins, and a non-empty actor, but it cannot authenticate that actor. Forum/W7b must extend required author + pin columns to ordinary comb-origin packets before Honeybee can make actor provenance mandatory.
- **Adopt-time terminal race (remaining W7A-11):** human-effect request digests now exclude volatile destination resolution and replay their persisted request, but a feedback bee can still die between resolution and `adoptAgent`. Routing that execution-time failure through `attachedRetryOnDead=spawn` needs a typed adoption error and a new retry transition, so it is deferred rather than guessing from error text.
- **Fresh local-tmux spawn attachment readiness (W7A-12):** spawn-time comb attachment can still deliver its combined contract/track prompt before a newly booted local-tmux CLI is ready. HSR delivery is durable and is the default. The local fix belongs in spawn readiness orchestration so attachment can reuse `confirmSpawnReady`/`deliverSpawnBrief` without double-delivering.

## Honeybee track H0 (2026-10-30)

- **Drop the `tracks` table (expand-contract step 3):** H0 removed every reader and writer of `tracks` and stopped creating it in new stores, but existing stores keep the empty table under `SCHEMA_VERSION` 51. The release that bumps `SCHEMA_VERSION` to 52 drops it with `DROP TABLE IF EXISTS tracks` in the store constructor's explicit migration path; the live studio store holds 5 rows and 5 `track.*` audit rows, so the drop costs nothing measurable. Retired `track.put` / `track.deleted` audit rows stay in the append-only log forever and replay as no-ops through `RETIRED_AUDIT_KINDS`.

## Honeybee track H1/H2 (2026-10-30)

- **Git alternates for Cell `.git` (H1):** not built. On this machine's live Cells `.git` is 5 % of Cell bytes (median 119 MB, p90 145 MB; `du` semantics, already CoW-shared with the per-repo Git image on APFS), while git-ignored paths are 83 %. Purging ignored paths on park takes the projected median Cell from 1.06 GB to 0.31 GB; alternates would take it to 0.21 GB at the cost of a Cell that breaks when its image generation or the origin's objects are pruned (generation pinning or a dissociate-on-park step would be required first). Revisit if the gate moves below 0.3 GB.
- **Shared pnpm store (H1):** kept as pnpm's own user store (`~/Library/pnpm/store/v10` on this machine; 114 of 118 sampled Cell installs already hard-link from it on the same volume, so their `node_modules` are byte-identical by construction). Honeybee now grants `~/Library/pnpm` in the Cell sandbox so a sandboxed install never falls back to a per-Cell store. A Honeybee-owned `npm_config_store_dir` was rejected for now: pnpm refuses to install into a `node_modules` created against a different store, which would break every live Cell at deploy.
- **Refusing re-provision of evicted Cells below the floor (H2):** `resource_blocked` refuses only NEW Cells (`spawn` with `substrate: cell`). Reviving an evicted bee re-provisions its Cell even below the floor, because refusing it would leave a bee unrevivable with no operator surface; the per-bee `runtime_start_held` flag path is the place to add that if the floor keeps being breached by revives.
