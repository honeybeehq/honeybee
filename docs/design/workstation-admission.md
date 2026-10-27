# Workstation admission, phase A

This guards new automatic Honeybee bee/Cell admission on nodes configured as
`workstation`, plus automatic cross-bee retained `cell.exec`. It does not inspect
commands. Existing bees migrate once to `continuation`; human sessions remain
unrestricted. Existing native harness shells, descendants and watches are untouched.

The deployed CLI declares `client: hive-cli`, `runtimeBeeId` and `runtimeContext`
in its caller hello. Runtime markers are read before target-data-dir filtering.
Missing declarations and direct remote callers are automatic. A direct local CLI
without runtime markers is considered human under a cooperative convention.
Routine `env -i`, cron or launchd can lose those markers and look human. This is
not an OS security boundary against hostile same-UID processes or direct unmanaged
harness launches.

Apiary sends protected frame context, never spawn arguments:

```json
{"workstationAdmission":{"version":1,"intent":"human","requestKey":"same-as-idempotencyKey"}}
```

`intent` is `automatic`, `human` or `landing-fixer-local`. The last requires
`policyId`; other intents forbid it. Fixer intent is spawn-only. Assertions require
the existing enabled LocalRpcTrust registration with verified PID and birth identity.
The trusted producer derives intent from upstream authority; explicit node choice
never turns an agent request into a human request. Interim phone provenance is not
a human exception. Retained exec uses the existing separately validated
`sessionPrincipal: {beeId}` carrier for matching-owner continuation, or human intent.
Unmarked registered services default automatic. Registration lapses fail closed.

The sole temporary producer policy is configuration, without a writer RPC:

```json
{"workstationAdmission":{"landingFixerPolicy":{"policyId":"owner-supplied-id","owner":"T114","expiresAt":1790000000000}}}
```

The timestamp above is illustrative and expired; the owner must supply a finite
approved expiry. Policy expiry blocks new fixer admissions, not existing work.
Children receive independent admission. `admission_basis` defaults `unadmitted`;
missed creation paths are held before command claim without consuming spawn retries.
An older daemon refuses schema52, so rollback restores its pre-migration backup.
On redeploy, every bee in that restored database, including rollback-created
automatic bees, migrates to continuation. Those bees are a disclosed rollback gap;
never claim the migration marker survives backup restoration. Unknown creation
paths in an already-migrated store still default unadmitted and are held.

Refusals use `workstation_heavy_work_denied` and suggest a suitable satellite or
`forage --needs linux -- '<command>'` for Linux-compatible work. They never rerun
work elsewhere. Health/deployInfo advertise effective kind, cooperative scope and
temporary policy. Admission audit records exclude argv, environment and tokens.

Activation is a deployment precondition, not a runtime toggle. Do not deploy this
runtime to a workstation before:

1. T39 increment 1 routes automatic children to satellites.
2. T39 increment 2 forwards trusted origin and retained-exec principals, with an
   independently checked exact error-code passthrough.
3. Workstation LocalRpcTrust is ready and the Apiary registration is maintained.
4. Every satellite has an explicit correct `nodeKind` (missing defaults workstation).
5. Landing's finite T114 policy is installed and approved by its owner.
6. Apiary's existing cross-bee Cell exec callers, including landing holder/prepare,
   approved-range recovery, verify and diff/info paths, are inventoried and assigned
   an approved authority or closed. The spawn-only fixer policy cannot authorize exec.

No deployment or merge is part of this change. Validation uses disposable satellite
fixtures with a simulated workstation kind and fake HOME, never a human workstation.
