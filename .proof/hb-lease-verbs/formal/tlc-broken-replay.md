# LeaseVerbs

TLC reached more states than the chart budget of 500, so the chart draws only the bug paths: 5 states and 3 arrows.
The chart does not draw 1 steps that stay in one chart state.
The step the bulk call runs under its key changes Lease and BulkKey at the same time.

## ReplayIsQuiet breaks
The shortest path has 3 steps:
0. Lease No lease on the satellite, BulkKey Bulk key unused
1. the owner mints a lease payload: Lease No lease on the satellite, BulkKey Bulk key unused
2. the bulk call runs under its key: Lease Lease held (epoch 1, window 1), BulkKey Bulk key recorded
3. the same key is sent again: Lease Lease held (epoch 1, window 1), BulkKey Bulk key replayed

## Rules not checked
TypeOK, WindowNeverShrinks, EpochNeverFalls, AuthorityMatchesEpoch, NoDeadlock
After the first break, each TLC run stops at 100,000 distinct states. A run reached that bound before it checked these rules in every state.

Wrote out-broken-replay
exit=1
