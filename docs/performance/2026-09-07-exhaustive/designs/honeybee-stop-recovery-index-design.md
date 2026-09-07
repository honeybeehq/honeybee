# D05 stop-recovery index — shape study (no implementation)

Lane: honeybee-perf-stop-recovery-index-2026-09-07 @ 6d2677b1 (created this
round; worktree CLEAN — no prototype edits, no tests yet, per instruction to
report plan/read behavior first). Method: disposable in-memory node:sqlite
scratch with a commands-shaped table, the real index set, and the EXACT
production query text from store.ts:3082. Scratch numbers are structural
ratios on a contended Studio, never absolute claims; the parent owns real
measurement.

## The fixture finding, confirmed quantitatively

read-hotspots `seedSettledCommands` writes ALL 100k rows as
verb=stop/status=done/target_generation=1/thenRevive:false, and the queried
runtime is also generation 1 — so the candidate partial index

```
CREATE INDEX commands_stop_recovery ON commands(bee_id, target_generation)
  WHERE verb = 'stop' AND status IN ('done','running');
```

puts the ENTIRE canonical history into one (bee, gen 1) bucket. Measured
(median of 60, 100k rows, negative lookup):

| Fixture shape | old index | with candidate | bucket rows | verdict |
| --- | ---: | ---: | ---: | --- |
| same-gen canonical (100k stop/done gen1) | 334.0 ms | 197.4 ms | 100,000 | **residual retained** — constant-factor trim only |
| spread-gen (100k across 200 gens) | 143.8 ms | 2.1 ms | 500 | ~68× — the realistic-workload win |
| mixed-verb same-gen (50k stop + 50k wake) | 196.0 ms | 174.4 ms | 50,000 | verb narrowing halves the bucket; residual remains |
| any OTHER generation, all shapes | — | ~0.001 ms | 0–500 | off-bucket negatives become index-seek cheap |

The original 11.9 ms canonical residual is NOT solved by this index and must
not be claimed solved: with the fixture's shape the query still walks the
full bucket, and the per-row cost is dominated by the residual
`json_type(args,…)` fetch+parse, which no non-JSON index can remove.

## Plan/read-behavior facts (scratch EXPLAIN, exact texts)

- `hasStopThenReviveRequest` (text unchanged) →
  `SEARCH commands USING INDEX commands_stop_recovery (bee_id=? AND
  target_generation=?)` — SQLite proves the implication because the query
  carries `verb = 'stop'` and the byte-identical `status IN
  ('done','running')` term. No query rewrite needed; JSON stays a residual
  filter; read semantics byte-identical.
- **No plan theft:** hasPendingStopCommand and hasPendingReviveOrWake keep
  `commands_by_bee_status` (their `status IN ('queued','running')` cannot
  imply the index WHERE); claimNextCommand keeps `commands_ready`;
  listCommands keeps `commands_by_bee`.
- **NULL target_generation:** such stop rows enter the index (no gen term in
  the WHERE) and are excluded by `=` exactly as today.
- **Transitions:** membership changes only at stop-verb status edges —
  queued→running enters, running→done stays, running→failed/queued leaves —
  O(log n) maintenance on those writes; non-stop verbs never touch it.
- **Rollout:** `CREATE INDEX IF NOT EXISTS` on every open, no version bump,
  engine-maintained under downgrade — the bees_one_active_move /
  runtimes_daemon_live precedent. One-time build at first open scans the
  commands table ONCE reading only bee/gen/verb/status columns — it never
  parses args.

## JSON-expression candidate — documented, NOT implemented

`CREATE INDEX … ON commands(bee_id, target_generation,
CASE WHEN json_valid(args) THEN json_type(args,'$.thenRevive') END) WHERE …`
would make the canonical negative O(1), but: (a) the index build evaluates
the expression over EVERY historical row at first open — `json_valid` guards
the malformed-args startup failure but the full-history parse cost moves
into open; (b) the query must be rewritten to the exact expression for the
planner to use it — a read-shape and error/timing-semantics change; (c)
malformed-args rows silently classify as NULL rather than raising at read
time. All three need review before any prototype; deferred exactly as
instructed.

## Recommendation and measurement asks

The non-JSON narrowing index is a modest, safe candidate whose case rests
entirely on realistic workloads (generation spread, mixed verbs, off-bucket
negatives) — carry it forward ONLY with the same-gen residual stated
honestly. Parent measurement should include, at minimum: (1) same-generation
negative control at 100k (expect ~1.5–2× constant trim, nothing more);
(2) spread-generation negative (expect order-of-magnitude); (3) mixed-verb
history; (4) write-path cost on stop transitions (paired-step lifecycle
cycles); (5) first-open build cost and storage bytes at 100k (read-hotspots
open scenario + closedStorage); (6) confirmation of no plan shift on the
neighboring command queries (the EXPLAIN pins above, as tests once the shape
is approved).

Next step on approval: dirty prototype (schema export + store exec, query
untouched) plus the cheap ~1k-command test file (install/reopen, plan pins
incl. no-theft, strict-JSON matrix over the index, transition membership,
NULL-gen, read-only probes) — none of it started yet.
