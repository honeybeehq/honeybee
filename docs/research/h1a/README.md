# H1a delivery retry and integrity receipts

Transient `not_ready` retries use a per-bee exponential delay with jitter, capped at 30 seconds. Runtime, message and driver readiness changes reset it. Native multiline unsupported refusals retain their existing bounded fallback policy. Pending acknowledgements remain uncertain and are never cleared to resend. Existing I1 deadline telemetry remains active.

`hive v2 doctor integrity` calls the additive read-only `doctor.integrity` RPC. SQLite `quick_check` runs on the daemon-owned connection, after transactions settle. Normal starts and health polling do not run it.

`lab.log` captures the real before/after runs. The owned SQLite quota (`max_page_count`) produces SQLite FULL without filling any filesystem. After raising that quota, delivery succeeds on the same connection without restart and `quick_check` reports ok. A separate owned daemon verifies the RPC transport. This does not prove the cause of production message 24680; the historical-build investigation is separate H1b work.

Run with a clean environment, an owned fake HOME and a short owned TMPDIR under /var/tmp:

```
node --experimental-strip-types scripts/lab/h1-not-ready.mjs
node --experimental-strip-types scripts/lab/h1-doctor-rpc.mjs
hive v2 doctor integrity --json
```

The first script uses actual DaemonCore/CoreStore and the existing controlled driver; the second launches only the owned stub daemon. No live daemon, credentials or account leases are accessed. No new unit tests or code comments were added; existing fake drivers expose their changing readiness to the new scheduling interface.
