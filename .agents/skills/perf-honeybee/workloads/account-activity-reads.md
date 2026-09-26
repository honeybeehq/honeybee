# Account activity pending-work reads

Before changing production, accept zero pending-mail/command method calls for booting/running bees in all twelve samples; preserve exact account facts and durable state. Idle/stopped controls must still inspect pending work. This is a count gate, not a time budget. Run the JSON recipe with Node24.18.0 after creating .proof. The public activity reader uses a real fixture SQLite store; no daemon or provider starts. Retain failed samples and command exit status.

The same localActivities helper serves admission, but the measured scope is one nodeActivity call. Runtime reads, reservation history, account scans and total admission work remain unmeasured. Behavioral controls exercise transfer generation ownership, claims, inactive mail/commands, freshness and reopen. Source and collector hashes identify the receipt population.

Retained receipt: baselines/account-activity-reads.json. Three rounds each: empty0→0, 1bee1→0, 120bees180→0, 2000bees3000→0. Every public result hash matches the baseline. The empty/control cases do not establish overall admission cost; admission now shares one activity projection across its filtered candidate pool, measured separately in account-admission-batch. The public report now batches runtime and roster reads, measured in account-activity-batch. The Node test exit status is authoritative for behavioral controls; receipt completeness describes count cases only.

The September24 linked-control receipt refresh preserves all12 facts/state cases with zero active pending-work reads on the batch implementation. The earlier before/after pending-read counts above describe the September22 change, not an additional gain claimed here.

The 2026-09-25 receipt refreshes all 12 linked-control samples against the current generation-attribution query; it claims no new before/after gain.

The 2026-09-26 receipt refreshes all 12 current-source controls after admission adopted that shared projection. It adds no pending-work before/after claim.
