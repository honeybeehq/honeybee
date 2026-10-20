Admission roster-read allowance on E rebase

Product source 67d3732f and existing-test correction4f69709a, on main3c562377. The changed existing assertion is a maximum read budget, not permission to admit with unknown activity. No new unit test is added.

Candidate completeness

accountsService.ts:2623-2628 constructs the entire considered account list after the existing allow/exclude/source filters and passes every candidate id to localActivities. localActivities at2398 initializes an activity entry for each requested id. At2412 it unions beesOnAccount for every id. CoreStore.beesOnAccount at store.ts:6580-6582 is an authoritative SQLite SELECT of every bee bound to that account, all lifecycles; it is not a cache or partial roster.

For a live transfer, the bee may already be rebound to a destination outside the requested candidate set while the old runtime still consumes the source. localActivities2399-2410 builds all unreleased, unexpired per-bee reservations;2413-2417 explicitly adds every such bee whose transfer source is requested.2421-2424 uses the existing generation fence to attribute that runtime to its source until it advances beyond reconcileAfterGeneration. Thus every bee whose runtimeAccount is a requested id is included: either its stored account is requested, or a live transfer sources it from a requested id. Bees whose runtimeAccount is outside the requested set are correctly ignored.

Source coverage

A source admitted as a recovery candidate is in that same considered set. An excluded source is not a candidate; destination unreconciled holds remain charged separately through admissionCandidate2597-2603. The proactive source/current-account check uses localActivities([accountId]) at2515, with the same transfer inclusion. This preserves source charging before successor boot and destination charging afterward without double-counting the held start.

Unknown remote facts still wait

contextIsFresh at2373-2395 is unchanged: scope, configured owner/epoch, complete=true, valid revision, bounded observedAt age and typed account facts are required. admissionCandidate2542-2549 derives coverage complete only from that fresh complete context; otherwise it marks unknown. core/accountAllocation.ts:180-183 rejects unknown coverage with activity_unknown. A complete owner snapshot may explicitly report zero other-node activity; a missing/incomplete/stale snapshot cannot silently become that zero. These are the existing active-admission semantics; shadow legacy placement is unchanged.

Executed proof

admission-parity.mjs runs the existing40 admission fixtures twice. The second execution overlays ONLY main3c562377's exact full-roster localActivities method in memory. Both executions pass all transfer, rollback and reopen controls; every admission resultHash and effectsHash matches. The targeted path uses no more full-roster reads. The script and both complete receipts/logs are committed.

activity-uncertainty.ts drives the actual active AccountsService with fresh readable quota and independently missing, incomplete and aged120001ms fleet contexts. All three return account_wait/activity_unknown and create zero reservations. Existing account-allocation uncertainty tests also cover unknown remote activity.

The old assertion required exactly the allowance, so fewer reads failed30 samples despite unchanged results/effects. Its existing excessRosterReads metric already uses max(0,actual-allowed); changing the assertion to actual<=allowed matches that budget and still rejects any growth above it.
