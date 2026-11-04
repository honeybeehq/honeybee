# LeaseVerbs

TLC reached 732 states, more than the chart budget of 500, so the chart draws only the bug paths: 3 states and 1 arrows.
The chart does not draw 1 steps that stay in one chart state.

## AuthorityMatchesEpoch breaks
The shortest path has 2 steps:
0. Lease No lease on the satellite, BulkKey Bulk key unused
1. the owner mints a lease payload: Lease No lease on the satellite, BulkKey Bulk key unused
2. a lease installs: Lease Lease held (epoch 1, window 1), BulkKey Bulk key unused

## Rules that hold
TypeOK, WindowNeverShrinks, EpochNeverFalls, ReplayIsQuiet, ReplayAnswersOwnItems, EveryMintAudited, NoDeadlock

Wrote out-broken-authority
exit=1
