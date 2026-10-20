# H1a delivery retry and integrity receipts

Transient `not_ready` retries use a per-bee exponential delay with jitter, capped at 30 seconds. Runtime observations/state, message and HSR/Cell readiness changes reset it. Other driver-private changes without an observation can wait until the next retry (at most 30 seconds). Jitter is injected in the lab. Native multiline unsupported refusals retain their existing bounded fallback policy. Pending acknowledgements remain uncertain and are never cleared to resend. Existing I1 deadline telemetry remains active.

`hive v2 doctor integrity` calls the additive read-only `doctor.integrity` RPC. SQLite `quick_check` runs on the daemon-owned connection, after transactions settle. Normal starts and health polling do not run it. Calls require a verified direct local Unix peer (no relays), single-flight concurrent requests, and a 60-second minimum interval. Same-UID agents can also invoke this read-only administrative check. SQLite exclusive locking prevents a separate read connection; the scan occupies the writer/event loop. A 269,570,048-byte normal-durability lab database took 83 ms per scan on metal-2; this is not a bound on larger production databases.

`before.raw.log` is the unmodified baseline output from `node --experimental-strip-types .audit/h1/lab.mjs` before source edits (the initial two-scenario DaemonCore script). `lab.log` summarizes its 300-element attempts array as `attemptsCount` and retains the later after/RPC output; the summary is explicitly transformed evidence, not raw script output. The owned SQLite quota (`max_page_count`) produces SQLITE_FULL without filling any filesystem. This is a logical SQLite capacity fault, not filesystem ENOSPC or WAL/checkpoint-failure proof; it sanity-checks existing rollback behavior. After raising that quota, delivery succeeds on the same connection without restart and `quick_check` reports ok. A separate owned daemon verifies the RPC transport. This does not prove the cause of production message 24680; the historical-build investigation is separate H1b work.

Run with a clean environment, an owned fake HOME and a short owned TMPDIR under /var/tmp:

```
node --experimental-strip-types scripts/lab/h1-not-ready.mjs
node --experimental-strip-types scripts/lab/h1-doctor-rpc.mjs
hive v2 doctor integrity --json
```

The first script uses actual DaemonCore/CoreStore and the existing controlled driver; the second launches only the owned stub daemon. No live daemon, credentials or account leases are accessed. No new unit tests or code comments were added; existing fake drivers expose their changing readiness to the new scheduling interface.
