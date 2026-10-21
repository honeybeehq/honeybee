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

## Decision pending: authority path

Tormod chooses one path: per-attempt human approval for no-inference phases 1–2,
the full protected executor/attestor, or pause. None is selected or authorized by
this revision. Human approval does not authorize inference, account leasing,
guest credentials or phase-3 code. The owner CLI alone is not agent authority.

The near-term alternative has no attestor. Treat agent proposals, bearer tokens
and claimed session identities as untrusted. In a protected Apiary approval UI,
the human explicitly chooses actor and ur workspace and reviews the complete
canonical job, immutable input digests, bridge/install identity, no-inference
mode, deadline and resource limits. The management service binds a one-use
approval id to that exact body digest, actor, workspace and expiry (60 seconds).
Any change or retry with changed content requires new approval. Copied session
tokens may submit an untrusted proposal but cannot authorize or change a run.
Status/stop requests without an attested actor likewise require human authority;
no agent bearer token becomes authority just because a start was approved.
An approval authorizes one no-inference attempt, not a session or standing grant.

The full automatic alternative requires direct harness integration with a
separate-UID tool executor, SO_PEERCRED plus PID birth/boot binding and protected
launch registration. The harness must connect directly to that executor; today's
same-UID MCP child cannot be promoted by declaring it trusted. Enforce
ptrace_scope >= 1 (with no agent parent/debug privilege over the executor), or
separate PID namespaces, in addition to separate UID and no privilege escalation.
A trusted attestor binds the canonical request digest, actor/workspace, nonce,
expiry and destination to the kernel peer identity; Apiary checks its registry.
No caller PID, parentage, copied token or unprotected registration is accepted.
Agent processes cannot signal, ptrace or inject into executor/attestor. Queen
estimates 3–5 weeks including harness work; this is not a small broker-only change.
Implementation and end-to-end proof remain gated on Tormod choosing this path.

## Protected Mac service and direct channel

Choose a separate macOS management user running a launchd management service,
with its key in that user's private keychain. The normal Apiary process and all
Studio Cell agents running as trmd have neither read nor signing access. Keychain
non-exportability alone is insufficient: no signing oracle is exposed to trmd.
The management user has its own protected approval UI/login session; ordinary
trmd Apiary can only submit untrusted proposals for display there. If Apiary
cannot provide that separate protected UI, the human path is blocked.

Attest the helper caller with XPC audit-token effective UID AND a pinned
code-signing designated requirement for the root-owned, signed, hardened approval
UI (library validation, no debugger/get-task-allow entitlement or user-writable
plugins). The service checks both on each request; PID strings, same binary run
as trmd, bearer tokens and a forwarded audit token do not count. Only this UI under
the management UID can approve an exact job for signing. Automatic attestor-mode
requests would instead require the independently pinned attestor identity and
validated process-bound attestation; that route is disabled in human-only mode.
No generic sign-bytes/key-use RPC exists. Root-owned launchd/config/binaries and
the private keychain are not writable/readable by trmd. A human or trusted root
management provisions them only after authorization. Prove that trmd has no
sudo, task-port, UI-automation or cross-user control route to this service/UI.
An unrestricted admin/root path from a Cell invalidates the boundary.

Drop the relay and TLS-in-TLS entirely. The metal-3 broker itself dials a direct
TLS 1.3 mutually authenticated connection to the separate Mac management service.
Use SHA-256 SPKI pins both ways plus certificate validity checks. On metal-3,
the management server pin is root-owned config; on the Mac the expected broker
client pin is root-owned management config. The broker's private key is a
systemd credential; the Mac service's private key stays in its own keychain.
No key lives in a trmd process, environment or file on either machine.

The broker has no inbound TCP or abstract socket listener; owner-local control
uses only a filesystem Unix socket in its 0700 service-UID root. The management
service queues authorized requests and sends them on the authenticated outbound
broker connection. Only that service's pinned identity is accepted. The Mac
management listener requires the pinned broker client; tailnet membership and
the shared host identity grant no authority. There is no outer TLS layer or
second set of undefined transport pins.

Rotate through trusted root-owned pin updates with at most 24 hours dual-pin
overlap, verify new identity, then remove old. Compromise immediately removes the
old pin, closes existing channels and suspends admission. Disable TLS resumption;
every reconnect validates pins, time and current policy. No unpinned fallback.

## Exact agent caller path

1. An agent proposes a job. Admission requires the authority path Tormod chooses:
   exact per-attempt human approval in the protected Mac UI, or a proven protected
   executor/attestor plus Apiary registry/role check. No path is enabled today.
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
Within a boot, monotonic time also bounds envelope age. Approvals and any future
attestations use the same limits and bind the full canonical body digest and target broker identity.

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

Both authority alternatives, the channel, sandbox launcher, broker and policy are
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
  with unit mocks. A chosen human-approval path must reject every unapproved
  request regardless of bearer identity; test the full attestor only if selected.
- Test pin rotation/revocation, expiry/skew, nonce replay across restart,
  body/id conflict, actor/workspace isolation, quota and revocation teardown.
- On the Studio, trmd agent processes cannot read or use the management key,
  invoke approval/signing through the helper, fake XPC audit identity, inject a
  library/debugger, or automate/control the protected user's UI.
- Under the full attestor option, a Cell cannot ptrace/inject into the direct
  harness executor or attestor; verify effective ptrace_scope/namespace policy.
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

## Second boundary amendment

Documentation only against source-PASS 4fe7e4b501563f7a5c23a25ad908bc96177ae7e6.
No authority alternative has been chosen, and no provisioning, sudo, broker,
Apiary, attestor or sandbox-launcher code is authorized until Tormod answers.
This revision specifies future proofs; none was run. Validation is document
review and git diff --check. No runtime change, build or execution was needed.
Stop after submitting this revision. DEPLOY HOLD and the phase-3 gate stand.
