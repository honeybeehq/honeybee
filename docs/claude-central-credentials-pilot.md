# Claude central credential pilot

This opt-in pilot gives Honeybee sole ownership of the rotating refresh token
for **one Claude account**. Local Claude processes and satellite leases receive
only access tokens. A local idle process therefore cannot prevent Honeybee from
renewing the account for a satellite.

The code is disabled by default. Automated service and RPC tests use dummy
credentials. Those tests do not prove macOS Keychain rollover or delivery to a
live satellite; complete the acceptance check below before widening the pilot.

## Commands

```sh
hive account credentials status <account> --json
hive account credentials enable <account>
hive account credentials refresh <account> --idempotency-key <unique-test-id>
hive account credentials disable <account>
```

Status reports the phase, credential generation, and expiry, without secrets.
`refresh` requests one real OAuth refresh even if the token is still fresh.
Reuse the same idempotency key to retry a lost command response. `enable` and
`disable` require all local bees on that account to be stopped, including idle
ones. Other accounts keep native refresh behavior.

Enroll only an isolated account home with no interactive Claude process or
external login using it. Honeybee checks its own runtime and login records; it
cannot fence a process launched outside Honeybee or a copy on another computer.
An unexpected foreign refresh token in the home, vault or Keychain blocks a
central refresh instead of being overwritten. Do not run native `/login` or
copy credential files while the pilot owns the account.

## A test the operator can judge

1. Choose one account with no live local sessions or external users. Enable it.
2. Start one local Claude bee and one on a granted satellite using that account.
   Tell each a different word and wait for both to acknowledge it.
3. Record the credential generation. Request `credentials refresh` with a new
   idempotency key. Status must return `ready` and generation must increase once.
4. Confirm that Apiary delivered that generation's access token to the satellite.
   **Current limitation:** `apiaryd lease ensure` skips a healthy, not-yet-due
   lease. Honeybee's refresh command updates local copies but does not force
   remote delivery. An explicit delivery operation through Apiary's authorized
   lease lane is required for an immediate test; do not hand-copy files or
   modify the lease database to simulate this.
5. Ask both bees for their words. Both must answer correctly, with the same
   runtime generation/PID as before. Then spawn a third bee on the satellite:
   it must answer normally. Confirm the satellite has no refresh token without
   printing its access token.
6. Stop the pilot's local bees, disable the pilot, and verify a normal spawn.

Do not count the live test as passed unless all steps pass. Testing file reload
against a local mock API establishes that a Claude process *can* reread an
updated access token; it does not establish macOS Keychain behavior or prove
that Apiary delivered it.

## Recovery

The private full credential is stored at
`<accounts.vaultDir>/.credential-authorities/<URL-encoded-account-id>.json`, mode 0600 in a
0700 directory. SQLite stores only ownership phase, generation, operation key,
and expiry. The new private document is fsynced before runtime copies are
published. Runtime files and macOS Keychain receive access-only documents.

- **`enrolling`:** fix the reported Keychain/file problem, then retry enable.
  Starts and leases are blocked until publication completes.
- **`refreshing`:** retry the original refresh key. If the provider result was
  saved, Honeybee finishes publication without rotating twice. If no result
  was saved, it refuses to reuse the possibly consumed token and remains
  `refreshing`. Stop local bees, disable, then log in again, as for `uncertain`.
- **`uncertain`:** stop this account's local bees, disable, then log in again.
  This first pilot deliberately has no automatic retry for an ambiguous
  provider response. Disable publishes an access-only copy and marks the
  account `auth_needed`; it never restores a possibly consumed refresh token.
- **`disabling` / `disabling_uncertain`:** fix publication and retry disable.
  Restart preserves whether the restore was allowed to include a refresh token.
- **Missing/corrupt private document:** disable still works and marks
  `auth_needed`. Log in again; do not substitute a runtime copy for the lost
  authority.
- **External login detected:** stop the external process before disabling.
  Disable preserves its credential rather than restoring an older chain, and
  marks `auth_needed`. Capture/verify that login or log in again.

Native login and capture are refused while enabled. Removing an enabled account
is refused; after disable, account removal also removes its private authority
file. Ordinary disable retains the private document, but it is no longer read
as authority; re-enrollment starts from the current native credential. The
retained file remains sensitive and belongs in the account's secret backup and
retention policy.

## Deployment boundary

Deploy only through `hive deploy` after verification. This change adds schema
**v27**. Opening the store upgrades the whole node even when the pilot remains
off. A v26 binary will refuse that database: `hive deploy --rollback` to v26 is
not a working pilot rollback.

The pilot's supported behavioral rollback is `credentials disable` on the v27
build. Before deploying on a shared workstation, prepare a schema-compatible
fallback build and verify its startup against a copy of the migrated database.
Do not restore an old database under live bees or while an account is enrolled.
A backup alone is not proof of safe runtime rollback.

Use fresh temporary stores for branch development. Early, unreleased revisions
of this branch used a smaller phase CHECK under the same v27 stamp; such test
stores are not migration targets. Any phase change after release requires an
explicit table-rebuild migration, as with the existing v26 command vocabulary.

## Automated verification

Run from the Honeybee checkout; these commands use temporary stores and dummy
credentials, and do not enroll a real account:

```sh
node --test --test-name-pattern='central.claude' v2/daemon/tests/account-lease.test.ts
node --test --test-name-pattern='rpc central' v2/daemon/tests/accounts-rpc.test.ts
npm run v2:check
```

The tests cover idle runtime renewal, access-only copies, keyed replay,
concurrent requests, rejected enrollment, lost replies/publication failures,
uncertain outcomes, interrupted disable, unreadable Keychain, missing authority,
and preserving an external login. Full account/login and core suites remain
part of the pre-deploy gate.
