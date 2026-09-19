# Batch action-view projection

Recipe registered before baseline and candidate measurements. It counts full-lane element reads at the public store method using temporary ephemeral SQLite fixtures. Setup, SQL, parsing, selected-row iteration and allocation are excluded. Three repetitions at 1/32/256 rows cover queued, paused, mixed, status-filtered and terminal lanes. No elapsed, CPU, RSS or app claim.

The test compares exact output with the existing single-row projector and checks read-only state/audit equality. Separate controls cover multi-bee filtering, real cancellation/pause/reorder, audit replay and reopen. The exhaustive four-row status table covers ordered lanes only: the store SQL and unique (bee_id, position) constraint establish that contract.

Acceptance: <=4 full-lane reads per stored row, >=75% fewer for 32/256 all-queued lanes, and at most two additional reads at one row. Retained receipt: `baselines/action-view-projection.json`. All 45 pairs had matching normalized output hashes. Baseline `ad4280aabc30d64ee25e4aff3efef62885b2d852` read 1,056 and 65,792 lane elements for 32/256 queued actions; candidate reads 95 and 767 (91.0% / 98.8% fewer). One-row and terminal-only controls are unchanged. Mixed/filtered reads fall 446→49 and 28,126→369. These figures exclude setup and SQL/JSON work.

The batch projector uses temporary selections/output arrays, with no persistent cache. Allocation/RSS effects are unmeasured. Read the test exit status as well as the receipt: a passing count verdict does not establish that separate correctness tests passed. The same driver on baseline intentionally fails its linear-work assertion while retaining all samples.

The single-row projector and scheduler are unchanged in behavior and retain their scanning path. No schema migration, retention change or owner receipt change is made.
