# Protected dev owner and caller path

Design only. No provisioning, sudo, registration, bridge execution, live changes
or phase-3 implementation is authorized by this document. DEPLOY HOLD stands.

A locked honeybee-exec-dev UID owns a dedicated dev daemon, immutable reviewed
artifact and private /var/lib/honeybee-exec-dev management root. Its data directory
is separate from that root. Owner files/key are 0600, private directories 0700.
Tormod provisions these through the human-only administration path after approval.
The live daemon is unchanged. Keep the same-euid RPC check; ordinary Cell clients
cannot directly use this dev daemon. Permissions require Cells to have neither
this UID nor privilege escalation/service control.

Owner registration uses only urbench-v2 and the final 14de2f119af5a822c12e8910339666c311dace27
package and three full hashes in external-exec-owner-candidate.json. That Cell
file is non-authoritative. Copy/review it owner-side only after approval, initially
without the workspace capability grant: explicitly strip the candidate JSON's
`capabilities: ["external-exec.v1"]` before installing it.

## Decision: per-attempt human approval

Tormod selected per-run human approval (Apiary question ea215807). This revision
completes that design; it does not enable it. The separate phase-3 acceptance
(question 7a0b4e6b, maximum lease 12 hours) does not authorize phase-3 code,
inference, account leasing or guest credentials in this phase-1–2 path.
Queen must approve this design before implementation. DEPLOY HOLD stands.

All agents run as `trmd` on both hosts. Everything reachable by that user is
agent-reachable, including Apiary RPC, browser surfaces, bearer tokens, sockets,
Keychain items and Accessibility, AppleScript or CGEvent automation. Proposal
identity is therefore a claim, not authenticated agent provenance. The human
selects an actor and workspace from the protected management registry; the screen
labels the proposal's claimed source separately. Approval authorizes the selected
actor's exact attempt, not a claim that the proposer actually was that actor.
No automatic attestor is included. Unapproved requests can only create proposals.

### Selected mechanism and its limits

Retain the Studio-local option: a separate standard macOS management account
`apiary-approve`, a protected native Apiary approval window in that account's own
login session, and a per-workspace Secure Enclave P-256 approval key. A signed,
hardened native helper owns the key. Secure Enclave/keychain access control
requires `privateKeyUsage` AND `biometryCurrentSet`, without password fallback.
The reviewed helper, not hardware alone, enforces a fresh LocalAuthentication
context per signature and `touchIDAuthenticationAllowableReuseDuration = 0`.
No reused context or earlier authentication is accepted.
Only Tormod's enrolled biometric set is allowed; changing it invalidates the key
and requires manual reenrollment. An unlocked login keychain is insufficient.
Apple documents hardware key protection and biometric access constraints in
[Secure Enclave keys](https://developer.apple.com/documentation/security/protecting-keys-with-the-secure-enclave)
and [biometryCurrentSet](https://developer.apple.com/documentation/security/secaccesscontrolcreateflags/biometrycurrentset).
Those controls protect key use; they do not attest what the person saw.
The Studio needs a compatible, physically paired Magic Keyboard with Touch ID;
it has no built-in sensor. See Apple's [keyboard requirements](https://support.apple.com/en-in/121954).
Use the data-protection keychain with a helper-only `keychain-access-groups`
entitlement authorized by a Developer ID provisioning profile, plus the hardware
access-control flags. The UI and transport service are not in that access group.
Apple's [macOS keychain implementation note](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)
describes this entitlement/profile boundary. The signing certificate's private key
must be held outside `trmd` reach by human release administration, and XPC checks
pin the approved binary cdhash as well as its designated requirement. Every update
requires a reviewed hash/config change. These signing/profile prerequisites are
part of the cost; no agent-held Developer ID credential may create a trusted helper.

The helper accepts only the exact prepared job through XPC from the root-owned,
signed approval UI, checking the kernel-supplied audit token's effective UID and
pinned code-signing designated requirement and cdhash on each connection.
Also require the caller's kernel audit-session ID to match the management user's
currently active physical console GUI login session, verified through trusted
session APIs, not a caller-supplied session string. The helper fails closed when
there is no unique active matching console session. A matching effective UID in
`trmd`'s audit session is insufficient. Deny PAM `su` and terminal `login` into
`apiary-approve`; disable SSH and remote GUI login for it. Make its LaunchAgents,
login items and all executed configuration root-owned/non-writable, with no
user-writable autostart path. Probe `su`, `login`, `launchctl asuser` and stolen
password simulations in T8. Reject `trmd`,
forwarded audit tokens, PID strings, alternate binaries and generic sign-bytes
requests. Both binaries have hardened runtime and library validation, no debugger
entitlement, no writable plugins, scripts, WebViews, remote content or URL-based
approve command. The helper independently fetches the broker's frozen preparation
through the protected channel, computes its digest, and returns the complete
validated body to the UI. The UI and helper bind one immutable review instance to
one click and one fresh biometric prompt; changing actor, job or selection destroys
that instance. Put actorId, workspaceId, operation `start` and a bodyDigest prefix
in LAContext's localizedReason, shown by the system authentication sheet, so a
job swap disagrees with the job being reviewed. This is a cross-check, not proof
of comprehension. A prompt cannot be preauthorized for a later job. Disconnect,
expiry, lock or session switch cancels the review and its authentication context.

The protected screen shows **actor ID and name, workspace ID and name, broker,
operation, full canonical job, every input digest, all install pins, no-inference
mode, resource limits, deadline, policy version, approval expiry and body digest**.
No ellipsis, hidden defaults or summary-only approval. Scrollable escaped plain
text shows every field, including controls and bidirectional characters as escapes;
show stable ASCII IDs alongside names to resist misleading labels. Disable
Approve until the complete validated document is available and has been visited.
This reduces accidental omission; software cannot prove human comprehension.
No approval in ordinary `trmd` Apiary counts. It can display pending/refused/result
state only, and cannot read back the signed token.

Tormod physically switches to the management login session using macOS's trusted
login flow and Touch-ID-only routine unlock, checks its account identity, opens
the installed native UI there,
reviews the job and approves with a fresh biometric gesture. Do not approve a
prompt in response to an agent message, ordinary Apiary window or browser page.
Keep that session locked otherwise. After reboot or when macOS requires a
password, stop approvals: a human-only physical-console startup ceremony is
required with `trmd` logged out and its processes stopped by the human admin.
Never type the management password into the agent session or a routine switch
prompt. If this operational rule or console binding cannot be enforced, choose
the separate approval station. Disable screen sharing, remote management,
remote login, automation grants and cross-user control into that account. Audit and revoke existing `trmd` app TCC
grants where necessary; TCC grants are per app/user, not target-session ACLs. No
agents, harnesses, terminal automation or shared clipboard tooling run there.

This is a conditional security design, not a claim about current Studio settings.
The current `trmd` admin membership, sudo rights/cached credentials, TCC grants and
cross-session automation reach have **not been measured by T1**. Tormod and T8 must
record them. `trmd` must have no effective privilege-escalation path, including
cached sudo, passwordless rules, admin credentials in reachable stores, writable
privileged launch/config paths or service-install RPC. Admin membership alone
does not prove immediate root, but this design requires removing it from the
agent account rather than relying on a password prompt. A separate human-only
admin account performs setup and keeps its credentials outside agent reach.

Without elevation, separate UIDs plus signed hardened binaries are intended to
block memory/task-port access, key use, helper impersonation and cross-user UI
control. Do not infer that from file modes: T8 must attempt each actual path with
the Studio's existing Accessibility and Screen Recording grants. If `trmd` can
inject input, draw an overlay in the management session, capture/control its
approval window, replace its binaries, use the key as an oracle or escalate,
this option fails. A Secure Enclave key alone does not fix that failure. Root,
OS compromise, malicious approved helper/update, physical coercion and deliberate
human approval of a harmful displayed job remain outside the guarantee. An agent
can spam or socially engineer proposals; rate limits and explicit physical
session switching reduce this risk but cannot eliminate human error.

### Phase 0: human feasibility gate before any code

Tormod, from a human-only admin account, first records Studio `trmd` administrator
membership and exact sudoers rules, cached authorization, Accessibility, Screen
Recording and Automation lists, Touch ID keyboard availability/pairing, existing
login/autostart paths and console-session behavior. Do not have an agent perform
this privileged assessment. Exercise one week of real fast-user switching before
committing to the Studio topology; record lock/reboot/password-required cases and
whether the workflow invites hurried or spoofed approvals. No approval feature
code begins before this gate and the topology/cost decision. The Phase-0 record
contains facts and redacted outcomes, never passwords or private keys.

The metal-3 verifier also needs a human-owned trust root. Current evidence from
Queen/T2 is that `trmd` has sudo and Cell NoNewPrivileges is 0; that defeats all
pins, file permissions and sandbox claims. Before provisioning, remove `trmd`'s
sudo/polkit/admin/service-control rights and invalidate cached authorization on
metal-3, then measure effective denial from a real Cell. Enforce Cell NNP as
defense in depth, not a substitute for removing sudo. A separate human-only
metal-3 admin account is reachable only through Tormod's hardware-backed FIDO2
`sk-ssh-ed25519` key with user verification/presence, enrolled from a human-only
admin machine/account with no agent-visible SSH agent or forwarding. Agents
neither provision this key nor obtain that admin session. Restrict the admin
endpoint/key by the reviewed T2 host plan. An ordinary `trmd` SSH key, shared
sudo password or agent-controlled terminal is not an independent admin path.
If removing `trmd` privilege is infeasible, move broker/verifier to a host agents
cannot root; current metal-3 cannot be enabled.

The Project's T2 privilege matrix is maintained by worker
`748eb6d2-61c3-480d-bc87-d11556f46b0c`, branch
`review/external-exec-metal3-provisioning`, reviewed head `529985d8`:
[Queen review matrix](https://github.com/honeybeehq/honeybee/blob/529985d8d0d9fda7a51582886e36f339e395fc76/docs/design/external-exec-metal3-provisioning.md#queen-review-packet-claims-open-items-and-safe-subset).
Its read-only step 0 has GO; provisioning steps 1–3 WAIT for topology, and it also
records the nearly full root filesystem as a bootstrap gate. Review that matrix
with the Phase-0 record; neither T1 nor a file-mode change closes its
current sudo blocker. Removing admin rights affects Tormod's daily account and
existing agent/admin workflows on both machines. This operational change and the
new 6–8-week estimate require Tormod's explicit topology/cost decision, routed
by Queen together with T2, before implementation. No automatic privilege removal
or extra hardware purchase follows from selecting a design in this document.

### Alternatives and estimated cost

Estimates are design estimates in engineer-weeks for review-ready implementation
and negative proofs, not measured delivery commitments. They exclude phase 3 and
are compared with the accepted roughly 3–5-week envelope.

| Option | Estimate | Decision and principal risk |
| --- | --- | --- |
| Proposed Studio user, native hardened UI/helper, per-use biometric key | 6–8 total | Exceeds accepted 3–5 weeks. Includes UI/helper/signing profiles/session binding/JCS vectors (about 2), broker/per-workspace service/direct mTLS/NTS/journal (about 2), bwrap/cgroup/AF_UNIX launcher (1–2), admin separation/setup/T8/review (1–2). Phase-0 adds a week of elapsed workflow observation, not a week of continuous engineering. Human cost/topology decision pending. |
| Ordinary `trmd` Apiary plus private file/keychain or non-exportable key | 1–2 | Reject: same-user automation or signing oracle can authorize without exact-job consent. |
| Management user plus Touch ID prompt, without protected full-job UI | 2–3 | Reject: biometric presence does not bind the human's view to the signed body. |
| WebAuthn hardware key attached to agent-controlled Studio browser | 3–5 | Reject for this path: touch/UV binds an RP challenge, not a trusted full-job display; malicious client can swap the job. A display-capable transaction signer needs a separate protocol/review. |
| Dedicated human-held iPhone, native Apiary approval app and Secure Enclave per-use Face ID key, no agent/remote-control pairing | 6–9 total | Stronger display separation; exceeds envelope. Requires human-installed signed app, physical public-key enrollment, broker-authenticated full-body display, lost-device revocation and reenrollment. No phone chat/message is approval. |
| Dedicated human-only Mac approval station: used Apple-silicon mini plus Touch ID keyboard, or MacBook Air with Touch ID | 4–6 total plus hardware/setup | Costed fallback: same protected native UI/key/protocol, no agents or automation on that station, physical human enrollment. Avoids shared Studio session proofs; retains metal-3 admin separation, broker, sandbox and T8. Human chooses purchase/topology before code. |
| Full separate-UID harness executor and process-bound attestor | 3–5 for that integration, approval work excluded | Reject for this task: automatic authority is outside the selected path; any reselection also needs ptrace_scope >= 1 with no agent parent/debug privilege or separate PID namespaces. |

No silent fallback. If Studio preconditions fail or effort exceeds the envelope,
Queen takes one concrete scope/device decision to Tormod (already required by the
revised estimate and T2 privilege findings). A replacement device
would enroll a new public key physically; revoke old key, close channels, discard
pending approvals and fail closed until new enrollment. Do not restore a signing
key from an agent-accessible backup. Remote phone messages and anything inside
an `apiary-phone-unverified` fence are always unverified.

## Direct pinned channel and key ownership

The metal-3 broker dials the protected Apiary management listener on the Studio
over direct TLS 1.3 mTLS. No relay, browser proxy, ordinary Apiary RPC forwarding
or TLS-in-TLS. The management listener accepts only this broker's pinned client
certificate. Tailnet routing supplies reachability, never identity. The broker
has no inbound TCP/abstract socket listener; its management Unix socket stays
inside its service UID's 0700 directory. The management service is part of the trusted computing base. Its sole
unprivileged proposal intake is a filesystem Unix socket with a defined closed
`proposal.v1` message schema, 16 KiB maximum, bounded queue (20 per workspace),
10 proposals/minute/workspace and a 1-second parse deadline. It authenticates no
agent identity there and grants no authority. XPC approval/key operations are
separate endpoints with the checks above. Peer credentials, strict framing,
unknown-field/duplicate-key rejection and bounded parsing prevent the intake
from becoming a general RPC/file/signing proxy. No dynamic code or caller paths.
Fuzz the parser and stress queue/memory limits in T8. Proposals reach Apiary as untrusted data;
protected management sends them over the existing outbound broker connection for
preparation. Only protected management receives preparations and signed approvals.

Use three independent keys, not one multipurpose key:

| Key | Private owner and use | Verifier pin |
| --- | --- | --- |
| Studio TLS server key | `apiary-approve` private keychain; only protected per-user launchd LaunchAgent may use it after human login/keychain unlock; no biometric for transport | Broker root-owned config: SHA-256 of server SPKI plus exact server name and certificate validity/chain policy |
| Broker TLS client key | metal-3 broker service UID through systemd credential, never `trmd`, bridge or guest | Studio root-owned config: SHA-256 of client SPKI plus exact broker identity and certificate validity/chain policy |
| ur approval key | Studio Secure Enclave, `apiary-approve` helper only, fresh biometric for each approval | Broker root-owned config: P-256 SPKI, key ID, human approver ID, ur workspace ID, allowed operation/schema and policy epoch |

Use a dedicated manually installed private trust anchor/certificate chain; validate
chain, EKU, names, validity AND exact SPKI pins. A public CA alone is insufficient.
No private key, TLS secret or signed approval enters `trmd` memory, environment,
logs, Cell files or tool responses. Transport authentication cannot substitute
for the separate approval signature. Owner Unix access cannot bypass approval for
an external run. Only ur is registered; another workspace needs separate key,
service root and dedicated daemon rather than expanding this key's authority.

Tormod installs public fingerprints out of band at both hosts as described in the
[setup procedure](external-exec-approval-setup.md). Never learn a pin from the first
network peer or an agent-supplied file. Rotation uses manually authenticated,
root-owned config updates with at most 24-hour dual-pin overlap, then removal of
the old pin. A compromise revokes immediately, closes channels, cancels pending
preparations and suspends admission. Pin/policy changes invalidate the old epoch.
The transport is deliberately unavailable after reboot/logout until Tormod logs
into the management account and unlocks its private keychain. Use a per-user
LaunchAgent in that account's GUI bootstrap domain, not a root LaunchDaemon
pretending to access a login keychain. Locking may leave the established service
available only if tested keychain policy permits; otherwise pause until human
unlock. Never store the password or switch to a trmd-accessible/system-wide key
to gain unattended availability. Approval always needs the active physical session.
Disable TLS resumption and 0-RTT. Every reconnect checks current pins, certificate
time and policy; failure never falls back to bearer auth or unpinned transport.

## Canonical job and one-use approval protocol

### Body bytes

The broker owns normalization. It validates a closed, versioned job schema,
resolves immutable content IDs in protected storage, fills every policy default
and computes the exact executable operation before asking for approval. Reject
unknown/missing fields, duplicate JSON property names at parse time, invalid UTF-8,
lone surrogates, floats, negative zero and integers outside 0..2^53-1. IDs and
hashes use schema-constrained ASCII; names are display data only. No caller argv,
environment, executable, host paths, fence, account or auth slot is accepted.

Canonical bytes `B` are UTF-8 JSON Canonicalization Scheme (RFC 8785) of this
validated, explicit-default body. JCS sorts object properties recursively,
preserves array order, emits no whitespace and preserves string code points
without Unicode normalization. Numeric values here are bounded integers only.
A reordered object has the same digest; reordering an input array changes it.
These rules follow [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785).

The closed body includes schema `honeybee.external-exec.approval-body.v1`,
operation (only `start`), human-selected actor ID,
ur workspace ID, target broker ID, broker-generated request ID and preparation ID,
policy epoch/version, and the entire validated job. The job includes immutable
input ID/digest pairs, exact bridge commit/executable path and all three inventory
pins below, no-inference mode, absolute run deadline and every resource/capture
limit, plus broker build digest, dispatch-builder build digest, pinned bwrap hash
and sandbox profile ID/digest. Changing any of these invalidates approval.
No secrets in
this body; fences and private dispatch paths are broker-generated later.

The fixed bridge identity is:

- Commit: `14de2f119af5a822c12e8910339666c311dace27`.
- Executable: `/opt/urbench-v2/bridge/14de2f119af5a822c12e8910339666c311dace27/bin/urbench-bridge`.
- Executable SHA-256: `7157b41da3845b273f1208e0c9d14e53ec0ff7c56c9d5c7950d1ccf4e1c4d946`.
- `files.json` SHA-256: `2b25875bc9bc5b7808b614b022497febc4bd0afd2a8a6fcd7fb16ae8ec5607cf`.
- `payload.sha256` SHA-256: `89ba8f60ce2638d89533ce97cb2a8623c0db8ca067cf47d0b73fdc2395ebed2d`.

`bodyDigest = SHA-256(UTF8("honeybee.external-exec.body.v1\0") || B)`,
encoded as 64 lowercase hex characters. The helper independently parses,
validates and canonicalizes the broker's body and checks this digest. It never
signs the digest supplied by a proposer. Golden vectors must match across broker,
helper and UI, including malformed-input rejection and displayed-field coverage.

### Preparation, display, signature and admission

1. Broker may validate an untrusted proposal in advance, but creates no timed
   approval preparation on arrival. In the protected UI Tormod selects actor and
   workspace, inspects a draft at leisure, then clicks **Review**. The protected
   UI asks management to prepare that selected actor/workspace/job. Only then
   does the broker validate again, fill defaults and freeze `B` in its journal.
   Cap complete displayed canonical body at 16 KiB and 200 rendered lines; reject
   larger jobs and require an independently reviewed smaller specification.
   No hidden reference may replace the full canonical job and input digests.
   Broker generates random 256-bit request ID, preparation ID and nonce. Client
   retry correlation is only a queue hint, never an authoritative request ID.
2. Broker records `issuedAt` and `expiresAt = issuedAt + 60 seconds` as integer
   Unix milliseconds and a same-boot monotonic deadline. It sends the frozen body,
   digest and envelope fields to protected management. This 60-second window
   includes final authoritative review and signing after the human is already
   in the protected session. Slow review expires and requires a fresh Review;
   never hurry approval or extend the same token locally.
3. Helper verifies the frozen preparation and renders the exact body in the
   protected UI. The human selects/reviews actor and workspace; any selection
   change requires a new broker preparation, not a local edit of the frozen body.
   On explicit Approve, the helper requires one fresh biometric operation.
4. Helper signs `UTF8("honeybee.external-exec.approval.v1\0") || JCS(E)` using
   ECDSA P-256 with SHA-256 (fixed 64-byte IEEE-P1363 `r || s` signature encoding).
   Envelope `E` has exactly: schema `honeybee.external-exec.approval.v1`, keyId,
   approverId, actorId, workspaceId, brokerId, policyEpoch, requestId,
   preparationId, nonce, issuedAt, expiresAt, bodyDigest and complete body object.
   Signature travels separately as unpadded base64url. Reject unknown fields or
   algorithms; do not deduplicate by signature bytes (ECDSA can vary). The token
   carries actor, workspace and full job, not merely a human-readable summary.
5. Protected management submits the token over pinned mTLS. Broker checks pinned
   approval key/approver/workspace/epoch, exact signature encoding, own broker ID,
   time health, nonce and preparation existence, equality of every envelope field
   to the persisted preparation, recomputed `B`/digest, actor grant and current
   policy. Revalidate protected input and bridge identity at execution. A changed
   policy or job fails closed and requires a new preparation and review.
6. In one durable SQLite transaction, mark the preparation consumed and reserve
   the nonce, request mapping, random 256-bit handle and operation intent before
   any external effect. Only then may the broker mint a private random 256-bit
   fence, persist encrypted recovery dispatch and invoke the existing owner path.
   A start approval is one attempt only. It cannot approve an automatic retry.
7. Return a scoped read/stop handle to ordinary Apiary. Only starts need approval.
   Status and wait expose only the recorded attempt's approved result scope;
   stop is the safe direction and may stop that exact owned attempt without
   another biometric. No control operation can create/retry an attempt, alter
   dispatch or extend its deadline. Reconcile is broker-owned same-attempt
   evidence recovery, never agent authority to re-execute a bridge start.

An agent cannot forge a signature without the helper key/use boundary; cannot
obtain one through a trmd API or automated prompt if the isolation assumptions
hold; and cannot turn an observed token into another effect because body, target,
policy, nonce and durable consumed state are checked. An identical authenticated
transport retry returns the original acknowledgement only while the token is
valid, without executing again. Expired retries return expired without releasing
status. A lost result is recovered through the scoped read/stop handle or protected
human management. This handle is a deliberately limited capability, not proof
of the caller's actor identity. No claim is made against human deception,
root or a broken OS isolation boundary.

## Exact agent caller path

1. An agent proposes a job. The selected per-attempt protocol above requires
   explicit approval in the protected Mac UI. No automatic attestor or ordinary
   bearer identity can authorize it. This path remains disabled pending proof.
2. Protected Apiary submits the signed approval and complete approved body over
   pinned mTLS. Preparation messages are untrusted until approval is consumed.
   The broker independently authorizes actor, ur workspace, operation and policy. Only
   urbench-v2 is allowed. No generic RPC, exec or file operations are exposed.
3. Choose broker-built dispatch: the agent supplies no dispatch and never supplies
   or sees a fence. The broker mints a 256-bit random fence and attempt id, builds
   the canonical dispatch from the validated job, and derives private receipt,
   capture and state paths. Job inputs reference owner-approved immutable content
   ids; the broker resolves them in protected storage. No caller host paths, argv,
   env, executable, account, auth slot or install pins are accepted.
4. The broker connects as honeybee-exec-dev to the management Unix socket, checks
   daemon instance and its own UID/PID/birth challenge, signs the ur-bound
   challenge, and registers that connection. It invokes existing spawn with named
   bridge and broker-built dispatch. LocalRpcTrust, same-euid, capability, pin and
   receipt checks remain unchanged.
5. Status/wait/stop require the random handle and its stored workspace/actor
   scope, routed over protected management; no claimed actor can expand scope.
   Handle possession deliberately grants read/stop only for that exact approved
   attempt. Since all agents share `trmd`, this cannot authenticate which agent
   holds it: the approval screen discloses that scope and possible same-user
   sharing. Return only scoped status/untrusted evidence references, no fences,
   private paths, raw credentials or full dispatch. Wait is at most 30 seconds
   per call, subject to rate limits; it cannot extend the attempt deadline.
   Stop uses only existing authorized generation-fenced operations, no direct
   guest signaling. Reconciliation stays protected broker-owned same-attempt
   recovery; an uncertain effect holds, never retries a start.

## Replay, recovery and policy

The broker refuses preparation, admission and dispatch whenever trusted time is
unhealthy. Require an operator-configured authenticated time source and a protected
host time-health provider reporting synchronized state, bounded uncertainty at
most 5 seconds, no leap-unsynchronized indication and a fresh sample at most
5 seconds old. On metal-3 use reviewed chrony/NTS with two independent
authenticated sources and a protected adapter reading source selection, leap
state, last update age and conservative root-distance/error bound. Configure
polling to meet freshness; no unauthenticated fallback. Reject disagreeing
sources and publish sequence-numbered health samples through a protected local
endpoint. Broker measures sample age and realtime progress against its own
monotonic clock. Missing/stale provider, excessive offset or a time step suspends
admission and invalidates pending preparations. T8 tests actual behavior.

Only the broker's clock controls the approval lifetime. Do not replace macOS
`timed` or require Studio NTS/uncertainty reporting. The Studio displays broker
issuedAt/expiresAt/countdown as advisory; it cannot extend them or issue its own
time window. A Studio clock error can cause fail-closed certificate validation
failure, not make an expired approval valid. Pin and certificate validation still
apply. Broker clock health is checked at preparation, consumption and dispatch.

At receipt and immediately before durable consumption/dispatch require
`issuedAt <= now + 5000`, `now < expiresAt`, and `expiresAt - issuedAt == 60000`.
There is no expiry grace. Also require age below the persisted same-boot monotonic
deadline (use a clock including sleep). Loss of sync closes the admission lane;
existing attempts remain observed/stoppable under protected safety policy. After
reboot or time-health recovery discard every unconsumed preparation and require
fresh approval after three consecutive healthy samples at least 5 seconds apart.
Do not revive old tokens by moving the clock backward.

The replay store is protected SQLite with a single broker writer, WAL mode,
`synchronous=FULL` and successful durable commit
before acknowledging consumption. A unique `(keyId, nonce)` plus unique
preparation ID and `(workspaceId, requestId)` enforce concurrent one-use handling.
Power loss/crash never empties it. Keep consumed nonce rows until both
`expiresAt + 5 seconds` and `acceptedAt + 65 seconds` have passed under healthy
time; request-ID/preparation tombstones remain for the lifetime of this broker
identity. Nonce pruning cannot make a token valid because the preparation remains
consumed. Never restore an older journal and resume admission: corrupt/missing DB,
WAL, encryption key or rollback/restore puts admission in suspended recovery.
Recovery revokes the old approval/policy epoch, cancels outstanding preparations,
reconciles daemon effects and requires manual fresh enrollment/approval before use.
Backups cannot reset one-use state under the old epoch.

Derive Honeybee idempotency keys as lowercase hex SHA-256 over
`UTF8("honeybee.external-exec.idempotency.v1\0") || L(workspaceId) || L(requestId)`,
where `L(x)` is unsigned 32-bit big-endian UTF-8 byte length followed by those bytes.
Request IDs are broker-generated. The request record additionally fixes actor,
operation and bodyDigest; any mismatch refuses. A duplicate consumed operation
uses only its original effect mapping. Independent 256-bit random handles bind
workspace AND human-approved actor on every operation; possession and a claimed
actor never grant start authority. Handles grant only their explicitly scoped
read/stop capability. They are absent from URLs and general logs.

The broker journal is service-owned SQLite under protected
/var/lib/honeybee-exec-dev-broker, with 0700 parent and 0600 database/WAL.
It stores request digest, actor/workspace, nonce/expiry, handle, attempt mapping,
generation and admission/recovery phase. Encrypt fence/dispatch recovery material
with AES-256-GCM and a systemd-delivered key, unique nonce and request identity as
associated data. Never log the ciphertext's plaintext or fence. This is a request
deduplication/recovery journal, not a competing runtime/lifecycle authority:
Honeybee's SQLite writer remains authoritative. Retain mappings until owner
retention permits deletion, and retain request-id tombstones to prevent reuse.
On restart, renew process-bound management registration and reconcile each
incomplete journal entry against Honeybee by the derived key/attempt. Resupply
only the identical protected dispatch; if evidence or recovery key is missing,
hold uncertainty and deny a replacement start.

Initial owner quotas: one active attempt per actor and two per ur workspace,
maximum 30-minute run deadline, 16 KiB complete displayed canonical body
(maximum 200 rendered lines), 2 MiB derived dispatch,
16 MiB raw capture per stream, 1 GiB total evidence per attempt, 10 GiB workspace
evidence, and 10 admitted starts/minute/workspace. Refuse before effects when full;
bridge enforcement must be reviewed for deadline/disk limits before enable.
Status requests are limited to 60/minute/actor; wait uses bounded long polling.
Any increase is an owner policy change, not a spawn field.

Revocation disables the actor/workspace grant and channel, denies new admission
and reconciles each outstanding owned attempt. Owner policy here is stop all
revoked actor's active attempts via the generation-fenced daemon stop path;
verify teardown/receipt, escalating only through existing verified ownership.
Unknown teardown remains reconcile_required and consumes quota. Revocation never
releases phase-3 accounts (phase 3 is absent). Credential revocation is separate.

Append audit records for policy/config version, human-approved actor/workspace,
request digest/id, nonce verdict, attempt mapping, bridge install digest,
admission/refusal reason, Honeybee result, reconcile, stop and revocation result.
No fences, token values, full dispatch, secret-bearing argv or raw output in audit.
Raw output remains untrusted evidence, subject to separately approved capture
policy before publication. Bound denial logging; retain security audit 30 days.

## Sandboxed bridge and host policy

The bridge is not management TCB. Require a root-owned, hash-pinned bwrap binary
with a protected canonical install chain; verify it before each launch alongside
the bridge's existing install pins. This is a future launcher change, not present
in the source-PASS head. No host bridge operation bypasses this sandbox.

Build a minimal filesystem view from an empty root, not a read-only bind of the
whole host. Read-only bind only the verified pinned inventory and immutable job
inputs at their approved paths; mount tmpfs over the owner root, Honeybee data
directory and broker recovery/key root. Also hide alternate spellings, mounts,
homes and /run service credential locations. Bind a private per-attempt writable
state directory and private tmpfs; expose /dev/kvm as the only host device
(private minimal /dev supplies synthetic null/zero/random only). No host sockets,
account homes, management files or credentials enter the view. The private state
directory cannot contain links, FDs or nested mounts leading back to management.

Require --die-with-parent, --new-session, a private PID namespace/private /proc,
no_new_privs and dropped capabilities. Private /proc must not expose daemon or
broker memory/fd/root; the sandbox cannot ptrace or signal those outside processes.
QEMU inherits this boundary and cannot escape it or change the mount policy.
Neither bridge nor QEMU opens abstract sockets; disallow AF_UNIX socket creation
in their sandbox policy (private control uses inherited pipes), with enforcement
and compatibility proved before enablement. Network policy remains no inference
in phases 1–2; phase-3 egress remains separately gated.

Re-prove fd exec under bwrap, including pathname replacement and interpreter
dependencies: the bridge executable and inventory are the verified FD objects,
only explicit FDs cross the launcher, and bwrap cannot reopen a swapped path.
Re-prove TERM/KILL and reconciliation with actual sandboxed bridge/QEMU: new
session/PID namespaces change pgid/sid, so the existing host-group test is not
proof. Supervise every attempt in an owner-created private cgroup v2, inaccessible
to Cells and sandbox children, with a protected attempt/identity binding. Stop
first uses the bridge control protocol; escalation must target verified sandbox
ownership including every new session/group, never a guessed outer pgid.
Admission stays off until reviewed launcher/cgroup support proves no survivors
or records durable uncertainty on every stop/restart path. No live cgroup
provisioning or sandbox execution is authorized here.

All Ur Bench host state is service-UID-owned in private directories, never a
Cell-writable or trmd-owned location. Provision protected copies of immutable
inputs, resolve only content ids, and reject writable ancestors/symlinks at use.
Neither daemon nor broker accepts configuration, executable, recovery or workload
paths writable by Cells. No account homes or provider credentials are mounted.

No login shell (nologin), password login, sudoers or polkit grant for service UIDs.
No supplementary group shared with trmd, including kvm: do not add the daemon or
broker to kvm. For the approved dev KVM path, provision a device ACL granting only
the service UID access to /dev/kvm; verify effective device permissions and systemd
DeviceAllow. No trmd membership, owner permission, group permission or ACL may
permit KVM access. If the host currently grants it, that is a provisioning blocker requiring
explicit operator remediation, not a condition already proven.
Operator privilege stays outside Cells; a Cell able to sudo invalidates isolation.

Systemd units require NoNewPrivileges=yes, ProtectHome=yes, PrivateTmp=yes,
UMask=0077, empty capability bounding/ambient sets, protected system files and
explicit writable state roots. Units contain no secrets in argv/env. Install
/proc hidepid protection where compatible, but acceptance does not depend on it:
prove no secrets in argv, cross-UID environ/memory/fd/root/ptrace access denied,
and no signal permission. No inherited service control sockets.

Use CLOEXEC on owner files/keys, journal/recovery files, listening and connection
sockets and all non-child FDs across broker -> daemon -> runner -> bridge.
Only explicitly mapped stdin/stdout/stderr and verified bridge install FDs cross
their respective spawn boundaries; enumerate them and prove unrelated FDs absent.
Dispatch/fence travels private stdin, never argv/environment or a Cell-readable
file. Pin verification still occurs immediately before exec on the exec'd FD.
The required inventory-FD mappings are intentional, not leaked authority.

## Acceptance and enable gate

The selected human-approval mechanism, channel, sandbox launcher, broker and policy are
design only and require Tormod authorization before implementation/provisioning.
The owner CLI alone is not an Ur Bench agent integration. Current source remains
disabled and not usable; no claim of isolation proofs having run is made.

Acceptance must include all of the following on metal-3 after authorization:

- Inspect uid, nologin, password lock, sudoers/polkit, groups, device ACL and kvm.
- Inspect systemd hardening and actual effective identity/capabilities/umask.
- Run ss -lxp and ss -ltp, with a complete per-service PID inventory: only expected
  filesystem Unix listeners; no abstract sockets or TCP listeners for these UIDs.
  Inspect the broker's direct outbound pinned-mTLS connection separately.
- Actual Cell plus harness-native tools cannot read owner/key/state/recovery,
  connect to broker/management Unix sockets, signal/ptrace service processes,
  inspect private /proc aliases, escalate or control services.
- A Cell using copied bearer tokens, another actor's handle, fake PID/workspace,
  a relayed challenge or host tailnet identity cannot obtain an accepted request.
  Prove rejection end to end at the real Apiary entry and broker audit, not only
  with unit mocks. The selected human-approval path must reject every unapproved
  request regardless of bearer identity. No automatic attestor is enabled.
- Test pin rotation/revocation, expiry/skew, nonce replay across restart,
  body/id conflict, actor/workspace isolation, quota and revocation teardown.
- On the Studio, trmd agent processes cannot read or use the management key,
  invoke approval/signing through the helper, fake XPC audit identity, inject a
  library/debugger, or automate/control the protected user's UI.
- Real sandboxed bridge and QEMU cannot read owner/key/data/recovery roots,
  including /proc/fd/root and path aliases; enumerate all mounts and open FDs.
  Verify neither opens abstract sockets and AF_UNIX creation is denied.
- Inspect effective /dev/kvm owner/mode/groups/ACL: no trmd access path; actual
  Cell open fails while the sandbox service's intended KVM access succeeds.
- Simulate loss of time synchronization/time steps: admission suspends before
  any effect and resumes only after trusted health recovery.
- Crash after durable nonce/request persist but before Honeybee effect: restart
  retains the nonce and same handle, creates at most one attempt, rejects changed
  bodies and reconciles ambiguous effects without another start.
- Re-run fd-exec replacement and full process-group teardown tests under bwrap
  with --new-session and private PID namespace, including leader exit/restart.
- Inventory child FDs across every exec boundary and prove CLOEXEC exclusions.
  Confirm protected inputs and every ancestor are not writable from a Cell.
- Positive trusted operator and approved ur agent paths work; ordinary live Cell
  hive commands and detached-runtime survival remain intact.

After those proofs and Queen approval, enable only ur/external-exec.v1/urbench-v2
through protected owner config. No merge/live deploy or credentials follow from
that dev enablement. DEPLOY HOLD and phase-3 design/code gate remain.

## Shutdown follow-ups

Detaching records durable reconcile_required for every external group with a
pending stop escalation before closing the writer. It does not stop unrelated
surviving runtimes. Exact-identity KILL remains armed while the old daemon lives;
a successor must reconcile uncertain groups rather than infer teardown.

A valid receipt delivered after shutdown starts is deliberately not committed by
the closing daemon. The runner/bridge receipt is evidence for successor adoption
or explicit same-attempt reconcile. Until that receipt is validated and committed,
the attempt is unsettled; silence or host exit cannot establish a model result.
Loss of both survivor and recovery evidence remains uncertain, never a new start.

## LOW-fix validation

Against source-PASS base ad460aca5629fc468bac45ff3f4a52d30dd8474f:
npm run check, npm run v2:check, npm run build and git diff --check pass.
All 174 adapter/driver tests and 15 focused daemon/authority/shutdown tests pass,
including ordinary detached-runtime survival and pending-group detach reporting.
No schema, migration or wire/mirror change.

Initial runs recorded two test failures, retained in .local/external-exec-dev/r3-*:
the new shutdown-order test omitted its config fixture; the existing fd-exec test
wrote unused stdin to an immediately exiting script and raced into EPIPE. The
fixture now supplies a private data directory, and the fd-exec test closes empty
stdin while still asserting original-opened-file execution after path replacement.
Final suites pass. No real bridge lifecycle operation or guest run was performed.

## Boundary amendment validation

Against source-PASS beb58cc5d4083cae3fbdd2fd3a8bd4219c778e8a, the only runtime
change catches each pending-stop uncertainty write separately during detach.
A failure emits a constant diagnostic and cannot prevent later callbacks,
ordinary runtime detachment or the daemon's subsequent store close. A regression
makes the first write throw and checks the second callback and runtime detach.
It cannot guarantee a durable record if the writer itself has failed; surviving
evidence and explicit reconcile remain necessary.

npm run check, npm run v2:check, npm run build and git diff --check pass.
All 175 adapter/driver tests pass in the final serial run. Earlier logs retain
the new test's invalid-directory fixture failure (corrected) and native-identity
failures from a driver run overlapping native-helper rebuild; tests were rerun
after build with no overlap. Logs: .local/external-exec-dev/r4-*.
The revised boundary design and acceptance checks have not been implemented or
exercised on live services. No provisioning, sudo, registration or bridge exec.

## T1 decision amendment and verification boundary

This document supersedes the pending-choice text in 59be42e5. It retains that
head's sandbox and source-PASS history (including ancestor 4fe7e4b5) without
cherry-picking product code. The handoff's ea215807 and 7a0b4e6b are Apiary question
IDs, not git commits. The selected per-run path is the only approval authority.

Tormod's human-only procedure is in
[approval setup](external-exec-approval-setup.md). T8 must run the mechanism-linked
[negative-proof checklist](external-exec-approval-t8.md) in addition to the host and
sandbox acceptance checks above. These are future checks, not results of T1.
Current keys, Mac privilege state, time-health integration, protected UI and broker
implementation remain unproven. The absence of a repository verification skill
is a setup gap; T1 uses the documented check/build/test commands instead.
Queen design PASS is required before code; separate implementation review and T8
PASS are required before enablement. This document grants no provisioning,
security/keychain commands, sudo, bridge execution, deploy or credential access.

T1 author verification on the document branch: `npm run check`, `npm run v2:check`,
`npm run build`, `npm run v2:driver` (175 passing) and the four focused daemon
suites (15 passing: external-authority, external-exec-rpc, external-exec-admission,
daemon-shutdown) passed in this metal-3 Cell. `git diff --check` passed. These
validate the unchanged source baseline and document formatting; they do not
implement or prove the proposed approval/UI/time/isolation mechanisms.
