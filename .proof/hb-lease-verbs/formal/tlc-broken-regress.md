# LeaseVerbs

TLC reached 716 states, more than the chart budget of 500, so the chart draws only the bug paths: 4 states and 2 arrows.
The chart does not draw 2 steps that stay in one chart state.

## WindowNeverShrinks breaks
The shortest path has 4 steps:
0. Lease No lease on the satellite, BulkKey Bulk key unused
1. the owner mints a lease payload: Lease No lease on the satellite, BulkKey Bulk key unused
2. the owner mints a lease payload: Lease No lease on the satellite, BulkKey Bulk key unused
3. a lease installs: Lease Lease held (epoch 1, window 2), BulkKey Bulk key unused
4. a lease installs: Lease Lease held (epoch 1, window 1), BulkKey Bulk key unused

## Rules that hold
TypeOK, EpochNeverFalls, AuthorityMatchesEpoch, ReplayIsQuiet, NoDeadlock

Wrote out-broken-regress
exit=1
