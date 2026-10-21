# Protected dev owner and caller path

Design only. No provisioning, sudo, registration, bridge execution, live changes
or phase-3 implementation is authorized by this document. DEPLOY HOLD stands.

A locked honeybee-exec-dev UID owns a dedicated dev daemon, immutable reviewed
artifact and private /var/lib/honeybee-exec-dev management root. Its data directory
is separate from that root. Owner files/key are 0600, private directories 0700.
The human or trusted Apiary management provisions these after Tormod approval.
The live daemon is unchanged. Keep the same-euid RPC check; ordinary Cell clients
cannot directly use this dev daemon. Permissions require Cells to have neither
this UID nor privilege escalation/service control.

Owner registration uses only urbench-v2 and the final 14de2f119af5a822c12e8910339666c311dace27
package and three full hashes in external-exec-owner-candidate.json. That Cell
file is non-authoritative. Copy/review it owner-side only after approval, initially
without the workspace capability grant.

## Channel and session identity (design choices)

Use TLS 1.3 mutual authentication with explicit SHA-256 SPKI pins in both
directions, in addition to certificate validity checks. The broker has one
filesystem Unix listener inside its 0700 service-UID directory; a trusted
service-UID relay carries mutually authenticated TLS bytes over that socket.
The relay has no TCP listener: it maintains an outbound mutually authenticated
TLS connection to the operator's Apiary management host. Apiary validates the
broker certificate through that end-to-end tunnel. Neither the relay nor broker
exposes an abstract socket or TCP listener. Tailnet membership grants no authority.

The accepted Apiary client SPKI and management server pin are root-owned config,
not writable by service UID or Cells. Apiary also keeps the expected broker SPKI
in root-owned management config on the operator host. Apiary's client private key stays on
Tormods-Mac-Studio in the operator's protected management service/Keychain, never
in any metal-3 trmd process, environment or file. The broker private key is a
systemd credential readable only by the dedicated service. This requires a
separate trusted Apiary management process: running it as unrestricted trmd on
metal-3 is explicitly unsupported. No TLS session secrets enter Cell tools.

Rotate keys through human/trusted management root-owned pin updates: accept old
and new pins for a bounded 24-hour overlap, verify new identity, then remove old.
Compromise revokes the old pin immediately, closes existing channels, invalidates
sessions and suspends admission; reconnect always rechecks pins and policy.
No fallback to unpinned TLS or tailnet identity. TLS resumption is disabled.

Choose process-bound session identity, not bearer-token authentication. A trusted
metal-3 session attestor accepts local tool invocations on a filesystem Unix
socket and obtains SO_PEERCRED plus native PID birth/boot identity. Trusted
management registers each session's exact tool-executor process identity and
workspace at launch through a protected control channel; neither the agent nor
the executor can register or change this binding. This executor belongs to the
trusted harness tool plane, not an arbitrary agent subprocess. The attestor
rechecks birth/liveness before each acceptance and forwards an authenticated
attestation bound to the body digest, session, workspace, nonce and expiry.
Apiary checks the attestation against its own session registry. Exit/relaunch
revokes the old binding; a replacement requires trusted registration.

Apiary must reject a copied session bearer token without this attestation.
Caller-supplied PID, birth, workspace and claimed parentage never count.
Same-UID /proc/environ or token-file access therefore does not impersonate another
session. A fake executor has a different kernel peer identity; an untrusted
subprocess cannot inherit registration. Attestor signing keys live under a
separate protected service UID/systemd credential, not trmd. Cells cannot ptrace,
signal or mutate trusted executors/attestor; this requires a protected tool-plane
UID and brokered tool execution, not today's arbitrary same-UID helper process.
This is additional proposed Apiary integration work, a hard enable prerequisite.
No claim is made that current Apiary bearer authentication provides this boundary.

## Exact agent caller path

1. Ur Bench agent invokes the dedicated external-attempt tool. The protected
   executor/attestor establishes the process-bound session above. Apiary derives
   actor and ur workspace from its registry and checks the external-exec role.
2. Apiary sends only the approved job specification over pinned mTLS. The broker
   independently authorizes actor, ur workspace, operation and policy. Only
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
5. Status/wait/stop/reconcile accept only actor/workspace-bound attempt handles.
   They call existing authorized Honeybee operations for the recorded bee and
   generation; no direct guest signaling or blind retry/start. Return scoped
   status and untrusted evidence references, never fences, private paths or keys.

## Replay, recovery and policy

Each authenticated envelope has a 256-bit nonce, issuedAt and expiresAt, with
maximum lifetime 60 seconds and at most 5 seconds future skew. Apiary and broker
use host CLOCK_REALTIME synchronized by trusted host time service; a time step,
unhealthy synchronization or uncertainty exceeding 5 seconds suspends admission.
Within a boot, monotonic time also bounds envelope age. Attestations use the
same limits and bind the full canonical body digest and target broker identity.

Atomically persist accepted nonces before effects in a protected request journal.
Keep them at least until expiresAt + 5 seconds and never less than 65 seconds
after acceptance; crash/restart does not clear them. An identical replay performs
only an idempotency lookup, never a second operation; conflicting replay refuses.
The broker derives Honeybee idempotency keys as SHA-256 of a domain-separated,
length-framed workspace and request id. Caller-supplied idempotency keys refuse.
A request id is opaque input, not authority: same workspace/id and same canonical
job digest plus actor returns the existing handle; a changed body or actor refuses.
Handles are independently random 256-bit values checked against workspace AND
actor on every operation. They do not grant authority by possession alone.

Choose a per-workspace management key: this dedicated daemon serves only ur and
has one ur-only key/management registration. No multi-workspace shared key.
Another workspace requires its own isolated service/root/key/daemon, rather than
extending this key's authority.

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
maximum 30-minute run deadline, 64 KiB job specification, 2 MiB derived dispatch,
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

Append audit records for policy/config version, authenticated actor/workspace,
request digest/id, nonce verdict, attempt mapping, bridge install digest,
admission/refusal reason, Honeybee result, reconcile, stop and revocation result.
No fences, token values, full dispatch, secret-bearing argv or raw output in audit.
Raw output remains untrusted evidence, subject to separately approved capture
policy before publication. Bound denial logging; retain security audit 30 days.

## Bridge trust and host policy

Explicit choice: the pinned Ur Bench host bridge and interpreter inventory are
trusted code in the management TCB, running as honeybee-exec-dev. It can read
management.key, owner root and the dev store. Hashes prove identity, not safety:
enable requires Queen's security review of this exact bridge's host-side parsers,
guest control and output handling. Guest/model code never runs as that UID.
Only disposable KVM guest execution is permitted; guest output is parsed as
untrusted data and cannot choose host commands/paths. If that trust is not
accepted, a separate bridge UID plus an authenticated restricted launcher is a
new design gate, not a same-UID permission workaround.

All Ur Bench host state is service-UID-owned in private directories, never a
Cell-writable or trmd-owned location. Provision protected copies of immutable
inputs, resolve only content ids, and reject writable ancestors/symlinks at use.
Neither daemon nor broker accepts configuration, executable, recovery or workload
paths writable by Cells. No account homes or provider credentials are mounted.

No login shell (nologin), password login, sudoers or polkit grant for service UIDs.
No supplementary group shared with trmd, including kvm: do not add the daemon or
broker to kvm. For the approved dev KVM path, provision a device ACL granting only
the service UID access to /dev/kvm; verify effective device permissions and systemd
DeviceAllow. A later separate bridge UID would receive that ACL instead.
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

This entire caller channel, protected executor/attestor, broker and policy are
design only and require Tormod authorization before implementation/provisioning.
The owner CLI alone is not an Ur Bench agent integration. Current source remains
disabled and not usable; no claim of isolation proofs having run is made.

Acceptance must include all of the following on metal-3 after authorization:

- Inspect uid, nologin, password lock, sudoers/polkit, groups, device ACL and kvm.
- Inspect systemd hardening and actual effective identity/capabilities/umask.
- Run ss -lxp and ss -ltp, with a complete per-service PID inventory: only expected
  filesystem Unix listeners; no abstract sockets or TCP listeners for these UIDs.
  Inspect established outbound relay TLS separately.
- Actual Cell plus harness-native tools cannot read owner/key/state/recovery,
  connect to broker/management Unix sockets, signal/ptrace service processes,
  inspect private /proc aliases, escalate or control services.
- A Cell using copied bearer tokens, another actor's handle, fake PID/workspace,
  a relayed challenge or host tailnet identity cannot obtain an accepted request.
  Prove rejection end to end at the real Apiary entry and broker audit, not only
  with unit mocks. Own-session approved requests succeed through the attestor.
- Test pin rotation/revocation, expiry/skew, nonce replay across restart,
  body/id conflict, actor/workspace isolation, quota and revocation teardown.
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
