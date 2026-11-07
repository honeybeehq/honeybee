# Legacy runner identity recovery

An archived idle bee can retain a live runner host while its legacy runtime row
has no exact birth token. If the runner status file is empty or lost, adoption
falls back to a degraded runtime. Previously that path omitted the legacy
binding flag, and the socket binding path required readable generation status.
A supported stop therefore stayed queued pending identity proof.

The Linux recovery path now accepts generation evidence from the running host's
exact argv when status is empty or absent. It requires the recorded legacy start
stamp within the existing five-second discovery bound, exact bee/generation config
path, a recognized Honeybee runner entry, and executable argv matching /proc/exe.
It checks exact birth before and after reading cmdline. It then authenticates the
connected socket peer (same uid, PID and birth) before the existing NULL-only store
compare-and-set binds identity. Normal exact-identity stop fencing remains in use.
No environment is read, no status is fabricated, and lost observation evidence
still means degraded adoption. Nonempty corrupt status, corrupt stored tokens,
wrong generation/config, changed birth and unauthenticated peers remain refused.

## Read-only live observation

On 2026-11-07, SSH health reported `process_identity_unresolved count=1`.
`hive view` reported bee `84ab31f1-6e34-46c8-bcfc-c58af2cfd660`, generation 11,
archived/idle, PID 3866913, recorded start stamp 1792515336551, and identity
unresolved. The runner status file read as empty. Its /proc cmdline was Node,
an old immutable Honeybee installation's `dist/v2/runner-host.js`, and exactly
`/home/trmd/.hive/v2/runners/84ab31f1-6e34-46c8-bcfc-c58af2cfd660.11.json`.
/proc stat start ticks 2042486326, CLK_TCK 100 and btime 1772090473 give
1792515336260 ms, a 291 ms difference from the recorded legacy stamp.

No live database was read, and no live process was signaled or daemon changed.
The actual stored token being NULL rather than corrupt remains unconfirmed.
Boot logs now expose `identityReason=legacy_null_token`, `identity_record_invalid`,
`pending_new_start`, `process_birth_mismatch`, `process_inspection_unavailable`,
`host_adoption_refused`, or `resolved`, without printing token values. The invalid
record code also covers schema/row inconsistency; it does not claim token corruption.
Successful background binding logs `doctor.runtime_identity_resolved`.

## Repeatable evidence

Run with installed, lockfile-pinned dependencies and the built native peer bridge:

```sh
npm run build
npm run check
node scripts/with-fixture-warden.mjs node --test \
  v2/daemon/tests/legacy-runner-recovery.test.ts \
  v2/daemon/tests/identity-recovery.test.ts \
  v2/driver-hsr/tests/legacy-birth.test.ts \
  v2/driver-hsr/tests/legacy-runner-proof.test.ts \
  v2/driver-hsr/tests/runner-host.test.ts \
  v2/driver-hsr/tests/psutil.test.ts
```

The added driver regressions fail against the original driver (`legacy` remains
unbound), and pass with this fix. The real fixture daemon uses an isolated HOME,
explicit HIVE_V2_DATA_DIR and private socket/store paths through startDaemon.
It recovers the NULL token with empty status, keeps the exact PID/birth/generation
across a further daemon restart, and completes both a new supported stop and a
stop queued before recovery. The bee remains archived with stopped_by_user.

This proves the preserved-runtime identity prerequisite in a fixture, not execution
of the external reviewed updater. After an authorized deploy, inspect live health
and boot logs before retrying that updater. If the live record is invalid rather
than NULL, it remains safely blocked and needs a separate supported recovery change.

No general repository verification skill was installed; the mandatory architecture
skill, focused identity/restart suites, typecheck and build supplied verification.
The environment has npm 12 despite this repo requiring npm 11; this run used npm
`--force` only to execute the lockfile install and scripts, without changing dependencies.

Validation receipt: the six focused files above passed 49/49 tests. After review,
the genuine missing-status case passed 5/5 driver cases and added diagnostic
assertions passed 11/11 daemon identity cases. Typecheck and build passed.
The broader driver/adapters suite passed 284/285. Its execution-handshake
`owner completion` timeout reproduced both in isolation and against the original
unchanged driver; that pre-existing failure is outside this fix.

Independent review by codex/gpt-6.1-sol found no Medium-or-higher findings. A Low
missing-status test-coverage finding was corrected and rerun successfully. User
worker-model requirements took precedence over the audit skill's different-model
family preference.
