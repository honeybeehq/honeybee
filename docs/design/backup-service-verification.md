# B6 verification receipt, including writer-fence follow-up

All runs used disposable fixtures and numeric loopback from the worker Cell. No real Cell,
Studio/MacBook home, SX65, real email destination, root, sudo or systemd operation was used.
Toolchain: Node 24.18.0, npm 11.16.0, restic 0.18.1, rest-server 0.14.0, Linux x64.

Run `HIVE_TEST_RESTIC=/absolute/path/to/restic HIVE_TEST_REST_SERVER=/absolute/path/to/rest-server node scripts/verify-backup-service.mjs`.
Expect six Python helper checks followed by 12 passing Node tests, with zero skips.
The drill writes `.audit/backup-b6/loopback-summary.json` and `writer-quota-summary.json`.

The helper checks persistent fences across a simulated boot/unit start, uncertain/live
backend refusal, stuck stop/wrong job, slow advisory inventory, pinned nonroot UID and
SUDO_UID mismatch, foreign UID binding, and invalid action/machine/extra fields.

The Node tests cover inventory/capacity alerts, maintenance takeover, unknown encrypted
arrivals, gateway bind recovery, real scheduled upload/restart/SMTP/finite prune, approved
retention, exact capacity bands, durable CAS/replay, real owner RPC admission, poisoned-key/
outage fairness, local busy preflight plus B4 unknown-capacity refusal, and actual quota
retally. Six encrypted snapshots become four after an unpinned capture/catalogue pair is
forgotten; the pinned recovery copy survives bounded check/prune. Report retries do not
recapture. Proxy role, bootstrap, keys/config, out-of-grant, early-pack, late-pin and replay
refusals are exercised. Serve identity headers without credentials return 403.

The integration stops a real disposable writer before the backend starts, asserts the
backend's live argv contains its recorded bounded max-size, then kills its guard. The root
helper logic runs through a disposable manager adapter (no systemd/root) and automatically
reaps the owned orphan via pidfds before writer restart and fleet-lease release. A stuck
fence refuses backend launch and retains the lease. A separate synthetic quota drill proves
both directions: maintenance-added bytes make the restarted writer refuse a write; after
maintenance deletes bytes, a restarted writer accepts newly available space. A backend
write above its own explicit cap is refused.

Final evidence under `.audit/backup-b6/`:

| Evidence | Result |
| --- | --- |
| fence-check-final.log, fence-v2check-final.log, fence-build-final.log | pinned checks and build passed |
| fence-core-final.log | core 623, fleet 6 passed, schema 55 |
| fence-daemon-final.log | local RPC, eviction, retained safety and retention: 32 passed |
| fence-service-final.log | six Python and 12 Node tests passed, zero skips |
| fence-b2-final.log | capture/SQLite/retry/exact restore: 5 passed |
| fence-b4-final.log | built verifier/eviction: 13 passed |
| protocol.log | proxy/restic/fence phases and closed refusals |
| writer-quota-summary.json | actual maintenance addition/deletion retally and backend cap refusal |
| loopback-summary.json | operation/report retry, sole copy, SMTP, stuck fence, orphan recovery and auth checks |
| templates.log | TOML/plist syntax only; installation/runtime not claimed |

The expanded scan checks fixture repository/HTTP/SMTP/private signing/HMAC secrets,
derived maintenance passwords, bearer tokens and common base64 forms in tool/server
output, mail bodies, Core facts and records. It does not claim application backup contents
are secret-free. Fixture repositories, databases and authentication hashes are cleaned.

Review: claude-opus-5-5, read-only, no tests rerun. No remaining Medium-or-higher findings
in reviewed code. Earlier timeout/hash/budget experiments and their final results are in
the decision trail. Real privileged-helper installation, exact sudoers restrictions, actual
systemd boot behavior, target tailnet ACLs, large-repository scan timing and the forced
late-pipe-only branch are NOT_COVERED. Previously recorded limits remain: Pollinate target
schema/macOS runtime, inherited special-tar fixture and mmap/inaccessible-fd residual,
operator bootstrap/install ordering, immutable extra pins, unknown rejected snapshots,
service history growth and 30s token revocation lag. Bootstrap identity is trusted private
configuration, not a cryptographic operator signature. No rollout is implied by these tests.
