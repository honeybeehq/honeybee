# Claude central credentials

This opt-in feature gives Honeybee sole ownership of the rotating refresh token
for a Claude account. Local Claude processes and satellite leases receive only
access tokens. A local idle process therefore cannot prevent Honeybee from
renewing the account for a satellite.

Accounts are enrolled independently. Each enrolled account has its own private
authority document, generation counter, refresh scheduling, lease mint, and
ownership fence; enabling, refreshing, or disabling one account never touches
another. The first live rollout ran on one account; the acceptance check below
is per account, and widening the rollout means repeating it per account.

The code is disabled by default. Automated service and RPC tests use dummy
credentials and a local stand-in for the OAuth token endpoint. Those tests do
not prove macOS Keychain rollover or delivery to a live satellite; complete the
acceptance check below before trusting a newly enrolled account.

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
ones. Satellite bees hold access-only leases and do not block enrollment. A
scheduled local wake that lands during publication is refused rather than
queued; the ownership fence keeps it from starting with a partial credential.
Other accounts keep native refresh behavior.

## Enrollment

`enable` adopts the freshest native credential and then proves the chain with
one real OAuth rotation **before** any native copy loses its refresh token:

1. An expired candidate is refused outright. Nothing is saved or published and
   no provider call is made; the message names the expiry and asks for a
   native login (`hive account login <account>`). Refresh the account natively
   or log in again, then retry enable.
2. The candidate is saved as the private authority (generation N+1, phase
   `enrolling`), still with native copies intact. Keychain readability and
   foreign copies are checked first, so a locked Keychain or a newer external
   login stops enrollment before the chain is consumed.
3. One rotation runs under a durable fence (`enrolling` with an operation key).
   - Provider success is fsynced to the authority (generation N+2) before any
     access-only copy is published; status then reports `ready`.
   - A definitive provider refusal (`invalid_grant` and similar) aborts:
     phase returns to `disabled`, the account is marked `auth_needed`, and
     native copies are byte-for-byte unchanged. Log in natively and retry.
   - A request the provider did not process (connection refused before send,
     429, the provider's `overloaded_error`) also aborts to `disabled` with native copies unchanged. Retry
     enable.
   - A lost or malformed response leaves phase `uncertain`. The native copies
     still look intact, but the token may have been consumed, so native
     refresh, capture, login and enable stay refused. Honeybee retries the
     rotation itself after a backoff (see Refresh outcomes): the account ends
     `ready`, or `login_required` if the token was consumed.
   - An enrollment interrupted mid-rotation (daemon restart) resumes on the
     next enable: a saved result is published without rotating again; no saved
     result is treated as `uncertain` and retried at once.

Enrollment therefore costs one provider round trip and rotates the chain once;
generation 2 is the first `ready` generation of a fresh enrollment.

Enroll only an isolated account home with no interactive Claude process or
external login using it. Honeybee checks its own runtime and login records; it
cannot fence a process launched outside Honeybee or a copy on another computer.
An unexpected foreign refresh token in the home or vault is checked on every
use. Keychain is checked before publication, refresh, and spawn activation, but
not on every fresh lease or limits read; a Keychain-only external login can be
detected as late as the next refresh. In every case it blocks central refresh
instead of being overwritten. Do not run native `/login` or copy credential
files while Honeybee owns the account.

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
   modify the lease database to simulate this. Run Honeybee's forced refresh
   first, then deliver the exact access-only `account.lease` payload under the
   satellite's existing grant. Keep the lease ledger owner-managed: record the
   account, node, time window, and unchanged ledger row, and expect at most one
   redundant delivery at the next due scan before the ledger converges.
5. Ask both bees for their words. Both must answer correctly, with the same
   runtime generation/PID as before. Then spawn a third bee on the satellite:
   it must answer normally; record its spawn wall time because a spawn at the
   refresh boundary includes one provider round trip. Confirm the satellite
   has no refresh token without printing its access token.
6. Stop the account's local bees, disable it, and verify a normal spawn.

Do not count the live test as passed unless all steps pass. Testing file reload
against a local mock API establishes that a Claude process *can* reread an
updated access token; it does not establish macOS Keychain behavior or prove
that Apiary delivered it. The explicit mid-TTL operation proves on-demand
delivery, not normal prompt propagation: routine rotations reach a satellite
only when its lease next becomes due, potentially most of one lease TTL later.
Central ownership removes the blocked refresh-chain ownership; it does not make routine
mid-TTL delivery instantaneous.

## Refresh outcomes

Every refresh attempt ends in one typed outcome. `hive account credentials
status <account>` shows the last one that did not succeed, and the daemon log
has one `account.credentials.refresh` line per attempt and one
`account.credentials.phase` line per phase change (account, generation,
outcome, reason; never token content).

| Provider answer | Outcome | Phase | Account | Next |
|---|---|---|---|---|
| 2xx with a token | success | `ready`, generation +1 | unchanged | none |
| 400 / 401 / 403 | `rejected` | `login_required` | `auth_needed` with the reason | log in again |
| connection refused before send, 429, a non-auth 4xx, the provider's `overloaded_error` (503/529) | `retryable` | stays `ready` | unchanged; last-good limits kept | retry after backoff or `Retry-After` |
| timeout or lost connection after send, any other 5xx, unusable 2xx | `unknown_outcome` | `uncertain` | `auth_needed` until it settles | retry after backoff |

A 5xx counts as `retryable` only when it carries the provider's own
structured `overloaded_error`. A status code alone proves nothing: a gateway
can answer 500, 502, 503 or 504 after the provider committed the rotation, so
those keep the doubt.

Backoff starts at `accounts.centralRefreshRetryBaseMs` (default 30 s), doubles
per consecutive attempt and is capped at 15 minutes. Retrying an unknown
outcome presents the same refresh token again: an unconsumed token rotates
normally, a consumed one is answered `invalid_grant` and the account moves to
`login_required`. Either way the phase is true and the account is not stuck.

A `login_required` account refuses `account.lease` with the typed code
`credential_login_required` and never presents the refused token again. The
limits probe reads the authority phase: any phase other than `ready` replaces
the limits row with `auth_failed` instead of keeping last-good numbers, and the
derived `credentialHealth` is `unverified` while the phase is `login_required`
or `uncertain`.

The token endpoint's `refresh_token_expires_in` is recorded on login and on
every refresh as `refreshTokenExpiresAt` (credential document, authority row
and account row). `hive account list` and `credentials status` print it as
`login expires MM-DD HH:MM` (UTC).

## Recovery

The private full credential is stored at
`<accounts.vaultDir>/.credential-authorities/<URL-encoded-account-id>.json`, mode 0600 in a
0700 directory. SQLite stores only ownership phase, generation, operation key,
the two expiries and the secret-free last refresh failure. The new private document is fsynced before runtime copies are
published. Runtime files and macOS Keychain receive access-only documents.

- **`enrolling`:** fix the reported Keychain/file problem, then retry enable.
  Starts and leases are blocked until publication completes. If the status row
  carries an operation key, the validating rotation had started: a retry either
  publishes the saved result or moves the account to `uncertain`.
- **`refreshing`:** a refresh is in flight, or the daemon died during one. The
  next daemon tick settles it: a saved provider result is published without
  rotating twice; otherwise the phase becomes `uncertain` and the retry runs
  at once.
- **`uncertain`:** the last refresh has an unknown outcome and a retry is
  scheduled. Nothing to do: it ends in `ready` or `login_required`. Disabling
  meanwhile publishes an access-only copy and marks the account `auth_needed`;
  it never restores a possibly consumed refresh token.
- **`login_required`:** terminal. The provider refused the refresh token, most
  often because the login reached its hard lifetime (about four weeks). Stop
  this account's local bees, then `hive account credentials disable <account>`,
  `hive account login <account>`, `hive account credentials enable <account>`.
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
file. The authority document also records a SHA-256 digest and expiry of the
adopted native chain (no secret) so untouched native copies are not mistaken
for a foreign login while enrollment is in progress. Ordinary disable retains the private document, but it is no longer read
as authority; re-enrollment starts from the current native credential. The
retained file remains sensitive and belongs in the account's secret backup and
retention policy.

## Deployment boundary

Deploy only through `hive deploy` after verification. This change adds schema
**v27**. Opening the store upgrades the whole node even when no account is enrolled
off. A v26 binary will refuse that database, so a direct rollback from the
feature to the old v26 runtime is unsafe.

Use the two-stage rollout represented by the two commits in this change:

1. Before deploying, verify the currently installed artifact declares schema
   v26 and its deploy history contains no v27 runtime. The initial production
   rollout verified this on runtime `2200223eabb3e1a6b2da46ff2ae36d5e962c7666`
   (`dist/v2/cli.js` declares `SCHEMA_VERSION = 26`). If any v27 build has
   already opened the store, stop and inspect its exact phase CHECK first.
2. Deploy the v27 rollback-bridge commit and verify daemon startup, a v27 store,
   and normal account/bee reads. Do not enroll an account yet.
3. Deploy the descendant feature commit. Its immediate `hive deploy --rollback`
   target is then the installed v27 bridge, not the incompatible v26 runtime.

The feature rollback is: for every enrolled account, stop its local bees, run
`credentials disable`, and confirm `credentials status` reports `disabled`;
then `hive deploy --rollback` to the v27 bridge. Never redeploy the feature and call
enable against an old `ready` document after a bridge window; enable afresh
from the current native credential. If the bridge sees any non-disabled row it
refuses before account handling. Under launchd the daemon log repeats the
`account:phase` refusal about every ten seconds until the operator acts; this is
the rollback guard working. Do not roll the bridge itself back to v26 after it
has opened the live store. Do not restore an old database under live bees or
while an account is enrolled. A backup alone is not proof of safe runtime
rollback.

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
concurrent requests, rejected enrollment, expired and provider-refused
candidates, lost replies during enrollment and refresh, save-before-publish,
interrupted enrollment and disable, unreadable Keychain, missing authority,
several accounts enrolled at once, and preserving an external login. Daemon
tests point the rotation at a local stub through `HIVE_CLAUDE_OAUTH_TOKEN_URL`;
production never sets it. Full account/login and core suites remain part of
the pre-deploy gate.
