# LeaseVerbs

TLC reached 378 states and 1331 steps. The chart draws 12 states and 27 arrows.
The chart does not draw 343 steps that stay in one chart state.
The view hides 358 steps, so the chart does not draw them.
The step the bulk call runs under its key changes Lease and BulkKey at the same time.

## EveryMintAudited breaks
The shortest path has 3 steps:
0. Lease No lease on the satellite, BulkKey Bulk key unused
1. the owner mints a lease payload: Lease No lease on the satellite, BulkKey Bulk key unused
2. the bulk call runs under its key: Lease Lease held (epoch 1, window 1), BulkKey Bulk key recorded
3. the same key is sent again: Lease Lease held (epoch 1, window 1), BulkKey Bulk key replayed

## Rules that hold
TypeOK, WindowNeverShrinks, EpochNeverFalls, AuthorityMatchesEpoch, ReplayIsQuiet, ReplayAnswersOwnItems, NoDeadlock

Wrote out-broken-audit
exit=1
