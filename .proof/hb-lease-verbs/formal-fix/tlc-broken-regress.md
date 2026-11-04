# LeaseVerbs

TLC reached 408 states and 1531 steps. The chart draws 12 states and 33 arrows.
The chart does not draw 361 steps that stay in one chart state.
The view hides 348 steps, so the chart does not draw them.
The step the bulk call runs under its key changes Lease and BulkKey at the same time.

## WindowNeverShrinks breaks
The shortest path has 4 steps:
0. Lease No lease on the satellite, BulkKey Bulk key unused
1. the owner mints a lease payload: Lease No lease on the satellite, BulkKey Bulk key unused
2. the owner mints a lease payload: Lease No lease on the satellite, BulkKey Bulk key unused
3. a lease installs: Lease Lease held (epoch 1, window 2), BulkKey Bulk key unused
4. a lease installs: Lease Lease held (epoch 1, window 1), BulkKey Bulk key unused

## Rules that hold
TypeOK, EpochNeverFalls, AuthorityMatchesEpoch, ReplayIsQuiet, ReplayAnswersOwnItems, EveryMintAudited, NoDeadlock

Wrote out-broken-regress
exit=1
