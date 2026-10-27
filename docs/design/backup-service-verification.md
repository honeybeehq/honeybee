# B6 verification receipt

All runs used this worker's disposable fixtures and numeric loopback. No real Cell,
Studio/MacBook home, SX65, real email destination or installed service was used.
Toolchain: Node 24.18.0, npm 11.16.0, restic 0.18.1, rest-server 0.14.0, Linux x64.

Run `HIVE_TEST_RESTIC=/absolute/path/to/restic HIVE_TEST_REST_SERVER=/absolute/path/to/rest-server node scripts/verify-backup-service.mjs`.
Expect 11 passing tests, no skips, and `.audit/backup-b6/loopback-summary.json`.

The eleven tests cover inventory failure/capacity alert, expired maintenance takeover,
unknown encrypted arrivals, gateway bind recovery, real scheduled upload/restart/SMTP/
finite prune, approved configurable retention, exact capacity bands, durable CAS/replay,
real RPC service admission, poisoned-key/outage fairness, and local live-Cell preflight.
The real drill uses six encrypted snapshots, retains four after deleting an unpinned
capture/catalogue pair, preserves the pinned sole copy and completes bounded check/prune.
It refuses keys/config mutation, out-of-grant snapshot deletion, pack deletion before
index publication, a late pin, grant replay and uploader maintenance access. It also
refuses prune before the operator bootstrap attestation. Report retry succeeds without
another capture. Overdue and capacity-stop mail reach a local authenticated SMTP sink.

Final evidence under `.audit/backup-b6/`:

| Evidence | Result |
| --- | --- |
| check-final.log, v2check-final.log, build-final.log | pinned checks and build passed |
| core-fleet-final.log | core 623, fleet 6 passed |
| daemon-final.log | local RPC security, eviction, retained safety and retention: 32 passed |
| service-drill-final.log | 11 passed, zero skips |
| b2-regression.log | capture/SQLite/retry/restore: 5 passed |
| b4-built-regression.log | built verifier/eviction worker: 13 passed, including pin-unavailable intact-source assertion |
| protocol.log | real proxy/restic phases and closed refusals, no credentials |
| loopback-summary.json | operation/report retry, 6→4 snapshots, protected copy, SMTP and access checks |
| templates.log | TOML/plist syntax parsed; platform/target runtime not claimed |

The expanded scan checks fixture repository/HTTP/SMTP/private signing/HMAC secrets,
derived maintenance passwords, bearer tokens and common base64 forms in tool/server
output, mail bodies, Core facts and records. It does not claim application backup contents
are secret-free. Fixture repositories, databases and hashed authentication files are cleaned.

Review: claude-opus-5-5, read-only, no tests rerun. No remaining Medium-or-higher code
findings in the reviewed excerpts. The committed decision trail records failed experiments
and their superseding real results. Operational limitations remain in the service contract:
private server-config bootstrap attestation (not a cryptographic operator signature),
B6-before-B4 install ordering, immutable extra pins after failed eviction, no signed rejected-
snapshot disposal API, 30s token revocation lag, and unbounded retained service history.
Pollinate target schema, launchd runtime and inherited special-tar fixture are NOT_COVERED;
B4's mmap/inaccessible-fd writer residual remains. No installation is implied by these tests.
