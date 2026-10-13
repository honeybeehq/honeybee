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
- **`login_required`:** terminal until a new login. The provider refused the
  refresh token, most often because the login reached its hard lifetime (about
  four weeks). Run `hive account login <account>` (see In-place login); nothing
  needs to be stopped or disabled.
- **`disabling` / `disabling_uncertain`:** fix publication and retry disable.
  Restart preserves whether the restore was allowed to include a refresh token.
- **Missing/corrupt private document:** disable still works and marks
  `auth_needed`. Log in again; do not substitute a runtime copy for the lost
  authority.
- **External login detected:** stop the external process before disabling.
  Disable preserves its credential rather than restoring an older chain, and
  marks `auth_needed`. Capture/verify that login or log in again.

Native capture is refused while enabled; login runs in place (below). Removing an enabled account
is refused; after disable, account removal also removes its private authority
file. The authority document also records a SHA-256 digest and expiry of the
adopted native chain (no secret) so untouched native copies are not mistaken
for a foreign login while enrollment is in progress. Ordinary disable retains the private document, but it is no longer read
as authority; re-enrollment starts from the current native credential. The
retained file remains sensitive and belongs in the account's secret backup and
retention policy.

## In-place login

`hive account login <account>` (RPC `account.login.start` / `submit` /
`retry`) works while central credentials are enabled, in phase `ready`,
`refreshing`, `uncertain` or `login_required`. Only `enrolling` and
`disabling*` refuse it. Only the direct Claude OAuth method is offered, because
any other method would land a refresh token in the home. When the pasted code
is exchanged, the authority, in its own lane and without stopping anything:

1. checks that the grant belongs to the same Anthropic account and
   organization as the chain it holds. It uses the identity recorded on the
   authority document, else asks the provider with the current access token,
   else reads the `oauthAccount` Claude Code recorded in the home's
   `.claude.json`. A different account fails the flow with `different_account`.
   If either identity is unknown, the flow fails with `identity_unverified`.
   Nothing changes in either case.
   `--replace-account` (`replaceAccount: true`) allows the replacement;
2. checks Keychain readability and foreign copies as before a refresh;
3. saves the previous document as `<account>.previous.json`, fences the row
   with an operation key, saves the new chain as generation N+1 and publishes
   access-only copies;
4. moves the phase to `ready`, records the login, clears `auth_needed` and
   fires the auto-resume hook. Bees cut off by the dead login resume once.

The previous generation's file is removed after the new chain's first
successful refresh. If the daemon dies after the save, the row still shows the
old phase with the new operation key. The next tick (for `login_required`) or
the next caller publishes the saved login without another provider call. A bee
whose turn fails authentication while the authority is `login_required` or
`uncertain` is recorded as interrupted. The account's status still comes from
the authority.

Publication, here and after every refresh, uses the native rotation's protocol.
It holds Claude Code's credential locks (including `.storage-write.lock`) and
waits up to 30 s for them. It writes the vault, then the Keychain item (merged
into, so MCP tokens survive), and the home file last.

## Early refresh and lease margin

The daemon refreshes a `ready` central credential once no more than
`accounts.centralRefreshAheadMs` (default 3 h) of the access token remains,
not only at the 15-minute ship floor. `account.lease {minTtlMs}` (0–24 h) asks
for that much remaining lifetime and refreshes centrally first when less is
left. Neither refreshes a token issued within
`accounts.centralRefreshMinIntervalMs` (default 5 min). An early refresh that
the provider did not process leaves the usable token in place and backs off.

## Login due

Mirrored accounts carry `loginDueAt`, derived as `refreshTokenExpiresAt` minus
3 days. No delta is emitted when that moment passes, so compare it with the
clock. `hive account list` prints `login due: login expires MM-DD HH:MM` inside
that window.

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
`credentials disable`, and confirm `credentials status` reports `native` under status v2 (the durable row is `disabled`);
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

## Codex authority

The same credentials commands now support opt-in Codex accounts. Native accounts
keep their existing `codex exec` refresh path. Central accounts use the daemon's
JSON OAuth transport with Codex's public client id and JWT access expiry. The
private authority is saved before access-only publication to the vault,
`CODEX_HOME/auth.json` and the legacy `HOME/.codex/auth.json` mirror. Both home
paths participate in foreign-refresh-chain checks. The legacy mirror remains
access-only even after disable; a healthy disable restores the native refresh
chain to the canonical home and vault. Files are mode 0600, private directories
0700, and publication fsyncs the file before rename and the containing directory
afterward, for Claude and Codex.

Codex has no in-place central login yet. For `login_required`, stop its local
bees, run `hive account credentials disable <account>`, complete
`hive account login <account>`, then run credentials enable again. An unusable
access token received with a rotated refresh token is retained privately and
retried with that new chain; it is never discarded or treated as usable.

The refresh endpoint can be injected with `HIVE_CODEX_OAUTH_TOKEN_URL` or the
transport constructor's endpoint argument for isolated stub checks. Run
`node --test v2/daemon/tests/codex-central-credentials.test.ts` with no real
account. The first live enrollment is the acceptance check: use a throwaway
account only with Needle's explicit approval, after Queen's review. Stub checks
do not establish the live provider contract or long-lived session rollover.

## Grok authority

The same opt-in commands support first-party Grok OIDC credentials with exactly
one `https://auth.x.ai::<client-id>` entry. API-key credentials, corrupt documents,
mixed entries and conflicting scopes are refused. The daemon sends form-encoded
refresh requests with the entry's client id and principal fields. An omitted
`expires_in` uses the 3600-second default of Honeybee's native Grok refresh path.
A present expiry must be a finite positive number within the timestamp range.
A malformed expiry retains the rotated private chain but stops in
`login_required` with `invalid_token_response` and no scheduled retry; it never
consumes a second rotation automatically. This terminal marker survives restart.

The private rotated chain is saved before access-only publication to the account
home and vault. Foreign refresh chains, scopes and principal identities are
checked before use. A healthy disable restores the current native refresh chain;
an uncertain or rejected chain is never restored. Enable and disable require
stopping the account's local bees. Grok has no in-place central login: stop bees,
disable, complete native login, then enable again.

`HIVE_GROK_OAUTH_TOKEN_URL` injects a local stub for isolated tests. Run
`node --test v2/daemon/tests/grok-central-credentials.test.ts` with dummy accounts.
These checks do not prove the live provider contract. Queen review and Needle's
explicit approval are required before any real-account refresh-chain mutation.

## Workstation handoff and explicit recovery

These RPCs require Queen review before deployment. Apiary supplies authenticated
workstation identities and peer public keys over its org lane; Hive does not
contact another Hive directly. The refresh chain is transported only by export
and adoptPrepare. Prepare persists a target-bound claim; the source commits
before the destination rotates. A committed source never aborts or refreshes.
Confirm scrubs the source after the signed adoption receipt is verified.

The local handoff key is a private per-workstation Ed25519 key, independent of
Apiary's org device key. The explicit handoff-key-rotate RPC/CLI aborts unclaimed
exports using the old key before replacing it. Prepared/committed handoffs
refuse rotation. Apiary must pin the new public key through authenticated peer
transport before using it in a new handoff.

Stand-down requires a signed higher-epoch receipt from the healthy current
holder, with its public key and peer identity supplied independently by Apiary.
An epoch alone cannot scrub credentials. A storage/Keychain failure retains a
durable cleanup fence; repair it and retry the same receipt, including after
restart. Default/global Keychain items and symlinks to them are excluded.

A crash after provider consumption but before saving its returned refresh chain
can lose that response. The destination keeps an uncertainty marker and makes
no automatic provider retry; the source remains committed-fenced. Saved
replacement chains replay publication without rotating again. This is not an
exactly-once guarantee across the network-response/durable-save window.

For this stuck case, the operator chooses the new holder and runs
`hive account credentials take-over <account> --confirm`. Stop all running
bees on the account first. The command signs a receipt bound to this workstation,
the abandoned handoff and an epoch above the known source/destination floors,
fences the local row and scrubs its abandoned copies. Apiary must relay
operatorTakeoverApply to the authenticated peer, which also refuses any running
bee and scrubs without logout, revoke or provider refresh. Apiary returns the
peer's signed cleanup acknowledgment to operatorTakeoverComplete. Only after
both sides have scrubbed does the issuing row become local/auth_needed for
native login and credentials enable. Each side records explicit operator
recovery once in its audit ledger; the same receipt retries cleanup safely.

The CLI does not relay across machines: Apiary's orchestration is a later task.
Protected payload RPCs expose take-over-apply and take-over-complete; retries
retain the printed handoffId with --takeover-id. If the peer reports a higher
epoch, choose a higher --epoch and a fresh takeover id after inspecting both
states. This recovery is never automatic. Every real-account native login,
enable or refresh-chain mutation still requires Needle approval and backups.

A peer whose original handoff is adopted, aborted, confirmed, stood down or
superseded refuses take-over without scrubbing, and returns a signed refusal
plus the original terminal receipt when available. Relay that refusal to
take-over-cancel on the issuer. Cancellation releases only the unapplied
recovery fence; it does not restore refresh material or release an original
committed handoff. Reconcile its original receipt (confirm an adopted peer or
consume its abort) rather than destroying a healthy holder. A failed-row
recovery also refuses a newer local authority, native login or handoff.

## Local authority facts and workstation re-pairing

The trusted caller boundary is a direct local Unix-socket connection. Every
handoff mutation and export, and any authenticatedPeer/targetKey fact, refuses
remote, node-relayed or unknown connection provenance. The RPC server derives
ingress from its accepted socket. The client hello may mark clientLane as
node_relay or remote, which only downgrades a connection; neither a hello nor
request parameters can promote a network socket to local authority. Generic
Apiary node-RPC proxies must use a tagged relay connection and preserve that
provenance. Authenticated org handoff orchestration validates the roster/mTLS
peer and deliberately calls its own Hive over a separate local Unix connection.
Hive cannot detect a privileged local proxy that strips relay provenance; that
proxy behavior is outside the trusted apiaryd contract.

handoffIdentitySet is set-once by default. For explicit org rebuild/re-pairing,
the operator may use handoff-identity-set --file identity.json --replace. It
durably aborts unclaimed source exports with old-key receipts, voids and removes
preparing/prepared destination shadow material, then persists the replacement
identity. The dedicated workstation Hive signing key remains separate from the
org device key and does not rotate as a side effect. Same-identity replay is a
quiet no-op. Failed cleanup keeps the old pin; retry completes remaining voids
before replacing it. A crash after voiding a shadow but before pinning the new
identity cannot revive that shadow.

Source prepared/committed claims and provider-started destinations refuse
replacement until explicitly completed or recovered. A prepared destination
cannot know whether its source already acknowledged it: Apiary must settle that
source before re-pairing the destination. If it does not, the source remains
fenced; a fresh higher-epoch healthy holder must authorize stand-down recovery.
Replacing an identity never silently aborts a remotely committed source or
restores a deleted refresh chain. Do not relay the operator --replace command
from a remote RPC lane.

## Releasing a removed handoff peer

An operator may use `hive account credentials release-peer <account> --confirm
--file authenticated-roster.json [--handoff-id id]`. Local apiaryd supplies the
roster fact from its validated signed membership DAG for this handoff's org;
UI or remote payloads must never supply it. The capability is
`account.credentials.release_peer.v1`; the RPC is
`account.credentials.releasePeer`. Only direct local Unix ingress is accepted.
The fact carries orgId, genesis, sorted heads, their version hash, local
authorNodeId/authorCounter and the folded member nodeIds. It must include this
workstation, exclude the bound handoff peer and name this workstation as author.
Hive persists the complete asserted fact; it does not fold or authenticate the
org DAG itself. This remains the trusted local apiaryd boundary. Stop account
bees on every computer visible to Apiary; Hive refuses local running bees or an
active login. The command is never automatic.

A prepared source aborts without committing or calling the provider. Its chain
is unchanged; removed-peer copies may still contain valid refresh material until
the source next refreshes. The response warns that an abort does not sign that
computer out at the provider. Authority becomes ready, and Apiary must publish the account
record at requiredEpoch (the prior handoff/local epoch maximum plus one). A
committed source first persists its release attempt, then makes one refresh.
Success saves the replacement chain before access-only publication, voids the
handoff and restores the source at requiredEpoch. Do not renew leases until
Apiary has written that authority record. An invalid_grant scrubs this source
and leaves its local row requiring native login; the response names the account
and warns that the removed computer still has a working login until it is
signed out at the provider. Honeybee never logs out or revokes that computer.

A crash before the call or between response and save is durably uncertain and
must not cause a blind provider retry. After a saved successful response, retry
only publishes the saved chain. A known saved replacement with unusable access stays private and
reports retained_unusable; uncertain is reserved for unknown provider processing. Cleanup failure remains fenced with cleanupPending until the same
request succeeds after storage repair. Keep the original roster fact and
handoff id for retries; changing it after the attempt refuses. Each outcome has
one secret-free audit row.

Restored responses include abortReceipt, signed over the original export
binding. On authenticated re-enrollment, a still-prepared destination consumes
it through adoptAbort before the higher-epoch lease installs into its same row.
A destination that started adoption needs the existing signed stand-down
protocol instead. A bare higher epoch never authorizes deleting an authority.
The operator must not commit a prepared source merely to release its peer.

The prepared abort also persists rotationScheduled and an early-rotation marker
in its release audit. The next handoff reconcile tick schedules a normal central
refresh immediately, bypassing the ordinary early-refresh age threshold without
unpausing the account. It respects credential-operation ownership and provider
backoff; a provider failure remains visible through existing credential status.
This background rotation is separate from the zero-provider-call abort itself.

A committed release that durably records a proven-unconsumed transport refusal
returns retryable=true. An explicit same-request retry may then send the token
again; exactly one processed rotation is permitted. An unknown response or a
crash after the next attempt marker is written clears that permission. Retryable
is a transport classification, never inferred merely from an arbitrary HTTP 5xx.

For an unknown outcome only, an operator may add --native-recovery with the same
confirmation and original roster fact. This makes no provider call, scrubs the
uncertain local copies and leaves the account requiring native login. It warns
that the removed computer may still hold a working login until signed out at
the provider. Known saved replacement material refuses this exit: use normal
release-peer to finish publication. A proven-unconsumed token also refuses
native recovery: use the known-safe explicit retry instead. No recovery is
automatic, and each native recovery outcome has one secret-free ledger row.

Removed-source destination recovery uses the same explicit local release-peer request and authenticated roster fact. A preparing/prepared or failed shadow is terminalized before its private received material is forgotten; its existing account row and pre-handoff local/leased provenance remain intact. No provider is called. A completed adopted destination keeps its healthy authority without rewriting credential files and reports requiredEpoch for the org record. An adopting/unknown destination requires --native-recovery, has no provider call, and becomes local/native-login-required after scrub; a known saved replacement refuses this option and must complete normal adoption/publication first. Pending cleanup stays fenced and retries with the original fact. All branches persist the claim terminal state so resurrected source commit/prepare frames cannot reactivate it. The outcome audit names the removed source. Apiary must perform normal native login, identity check and credentials enable after shadow cleanup, then publish epoch+1; an adopted holder needs only that record publication.

A removed-source destination retaining a known rotated chain with malformed expiry may explicitly use release-peer --use-retained-chain (mutually exclusive with --native-recovery). handoffStatus.retainedChainRecoveryAvailable identifies this action without provider-text inference. Persist transportGeneration and the removed roster before entering the durable attempt; success saves first, publishes and retains the holder at requiredEpoch, invalid_grant proves the chain dead before scrub, and unknown stops without blind retry. Saved success retries publication only. The action is never automatic and cannot discard a known chain without rejection proof.

Crash limitation: a durable attempted marker cannot distinguish a crash immediately before sending from one during a processed request. Both stop as uncertain. Explicit native recovery after that uncertainty can therefore abandon an old retained token that the provider would still accept; the operator is warned that the removed peer may retain a working login. A newer saved response generation is never discarded by this option.

Release-peer follow-up: a missing private authority file means no saved replacement; explicit unknown native recovery finishes scrubbing remaining copies and makes the row native-login-required. Corrupt or unreadable authority files still refuse rather than treating material as absent. An adopted/retained healthy holder reports scrubbed=false; it keeps its chain.

A source release or retained destination recovery returning another unusable access token saves that chain and reports retained_unusable, retainedGeneration and retainedUnusableCount, with the exact recovery command. Another rotation requires explicit --use-retained-chain --retained-generation N bound to the current saved generation. The previous request or generation makes no provider call, and a usable saved response only publishes. After three consecutive retained_unusable outcomes the row reports login_required with reason retained_unusable_limit, keeps the chain private and stops further rotations. At that cap ONLY, --discard-retained-chain permits explicitly confirmed local cleanup using the same authenticated removed-peer roster fact and no running bee. It is refused below the cap and cannot replace a newer saved chain. It makes no provider call, writes one account/generation audit row, and warns that the provider session behind the discarded chain stays valid until signed out at the provider. The SAME row then needs ordinary native login, identity verification and credentials enable, followed by epoch+1 authority-record publication. No same-self stand-down or second-account recovery is introduced.

The roster fact carries a hash and author=self, not an apiaryd signature. The direct local Unix socket is the trust boundary: apiaryd owns validated DAG membership, bound device+node absence, handoff/org correlation and record CAS. The hash is a heads identifier, not self-verifying membership evidence; remote/node-relayed ingress is refused.

Initial destination adoption uses the same known-outcome rule for Claude, Codex and Grok: a processed response with a durably saved replacement and unusable access reports credential_handoff_unusable_access with destinationDisposition retained_unusable. The handoff stays adopting, with public outcome retained_unusable, retainedChainRecoveryAvailable true, retainedGeneration and generation naming the saved generation. An adopt replay makes no provider call. After authenticated peer removal, the first release-peer --use-retained-chain request must also name --retained-generation N; missing or stale generations are refused before transport. This enters the existing explicit retained-recovery limit and capped-discard path. An unknown response or unsaved response keeps the uncertainty fence and never advertises a known retained generation.

For live member peers, capability account.credentials.retained_recovery.v1 adds explicit adoption recovery: adopt accepts retainedGeneration naming the current known saved unusable generation; omitting it never rotates again. Status exposes retainedGeneration, retainedUnusableCount and outcome retained_unusable. Each newly saved unusable generation increments the consecutive count once, including the initial adoption; after three, outcome is login_required, failureReason is retained_unusable_limit, cappedRetainedDiscardAvailable is true and retainedReceipt is a signed retained_discard_request. A save-before-count crash is reconciled from the private generation and cannot permit a fourth rotation.

At the live-peer cap, Apiary relays B's retainedReceipt to A's local exportSettle {handoffId, confirm, retainedReceipt}. The request is verified against A's pinned destination key and original claim, including retained generation, count and recovery epoch. A durably binds it, refuses running bees or a newer native login, scrubs only its dead source copies and atomically confirms/demotes at recoveryEpoch. Its retained_discard_settlement receipt is relayed back to B. Explicit adopt --discard-retained-chain --confirm with sourceSettlement verifies that exact signed cap binding before any scrub, persists discardPending and retries cleanup without a provider call. B's same row becomes local/native-login-required at requiredEpoch after successful cleanup. The message warns that the provider session behind the discarded chain stays valid until signed out at the provider. Native login, identity verification and credentials enable then publish epoch+1 on this row. The live peer's signature replaces the removed-peer roster fact; neither path silently destroys a known retained chain or uses coordinated take-over as routine provider-error recovery.

Handoff fixtures use 30-second graceful-stop budgets and atomic crash-gate publication. Every case has a 180-second deadline and independent forced cleanup of its own daemons, runner hosts and descendants plus the stub listener. The serial daemon test runner owns a 600-second per-file watchdog (HIVE_TEST_FILE_TIMEOUT_MS overrides it), reports the exact hung file and terminates its owned process group and captured descendants. These are test bounds, not production daemon shutdown changes.
