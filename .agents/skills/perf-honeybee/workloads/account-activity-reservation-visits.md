# Account activity reservation membership

A fresh nodeActivity report groups eligible reservations by bee once, preserving store order. The temporary groups are discarded after the synchronous call.

The recipe uses real SQLite fixtures: 32 cases across 0/12/120/1200 bees, ordinary/transfer/skew/history profiles, and two rounds. A separate control checks transfer order, rollback, expiry, release, generation changes, empty account pools and reopen.

Three alternating paired runs retain all six arms and 96 output-hash comparisons in baselines/account-activity-reservation-visits.json. At 1200 bees with transfers, bee-ID reads fall from 5,043,600 to 3,600, exactly one per returned reservation. Excess reads fall from 5,040,000 to zero. Durable state and expected activity remain equal.

This is a property-read count, not a latency, CPU, SQL-scan, receipt-decoding or memory measurement. The per-call grouping allocates a Map and arrays; that tradeoff is unmeasured. Existing activity, admission and historical-generation count controls are refreshed separately.
