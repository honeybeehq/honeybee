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

## Agent caller path: proposed narrow trusted broker

1. An Ur Bench agent requests an external attempt through a dedicated Apiary tool.
   Apiary derives the authenticated session, ur workspace and authorized role
   from its own session registry, never a workspace string or bee id in input.
   Workspace external-exec permission is checked before forwarding. An agent
   cannot self-grant or change its workspace, role, bridge registration or policy.
2. Trusted Apiary management forwards a bounded, versioned request over a
   mutually authenticated channel to a dedicated metal-3 broker. The broker is
   provisioned outside Cells, runs as honeybee-exec-dev, and accepts only the
   pinned Apiary management identity. Bind workspace, actor, request id, attempt
   and expiry in the authenticated request; reject expired/replayed conflicting
   requests. Network location or possession of a Cell socket is not authority.
   No bearer secret or signing key is installed in Cells.
3. The broker independently permits only ur and owner-registered urbench-v2,
   checks operation/size/deadline/concurrency quotas, and binds request id,
   attempt id and fence to a durable broker record. It obtains the dispatch from
   the trusted Ur Bench coordinator, or validates supplied data against an
   owner-approved schema/policy: no arbitrary host paths, environment, command,
   executable, account, auth slot or install pins. Receipt/capture locations are
   owner-derived under private attempt roots. No credentials in phases 1–2.
4. As the service UID, from outside every Cell, the broker reads the protected
   endpoint/key and connects directly to the management Unix socket. It verifies
   the daemon instance and its own UID/PID/birth challenge, signs the ur-bound
   challenge, and registers its connection in the separate management slot.
   It calls existing spawn with agent external-exec-v1, named bridge, validated
   dispatch and stable idempotency key. Honeybee still checks LocalRpcTrust,
   workspace capability, immutable registration, pins and receipt fencing.
5. Broker status/wait/stop/reconcile are restricted to attempts in its ownership
   record and the authenticated workspace. They use existing authorized daemon
   operations, not direct guest/process control. A lost response queries or
   reconciles the same attempt; it never blindly starts a replacement. Revocation
   denies new requests and defines owner-controlled teardown for existing runs.
   On broker restart, process-bound registration is renewed; attempt/fence
   recovery uses protected records and authenticated coordinator resupply.
6. Return scoped handles and sanitized status; raw output is explicitly untrusted
   evidence. Never return management keys, dispatch fences, private host paths or
   a generic RPC/exec/file interface. Raw provider/model evidence remains subject
   to the separate capture policy before publication. Phase-3 token delivery is
   absent and gated.

This broker is NEW design work, not present or usable in ad460aca or the LOW-fix
head. Its Apiary tool, authenticated channel and policy enforcement need review,
implementation and negative tests before agent usability can be claimed.
The owner CLI alone is an operator diagnostic, not the agent integration.

## Enable and isolation acceptance

After design/provisioning approval: install the reviewed artifact under the
dedicated UID; create protected root/key/config and separate data/socket; verify
all three install pins and chains without execution; prove isolation; then grant
ur/external-exec.v1/urbench-v2 and register only the approved broker.

From an actual Cell and its shell/file helpers, owner root/key reads, management
socket access, cross-UID /proc/root/fd access, ptrace, sudo/su/nsenter and service
control must fail. Check aliases, inherited descriptors and broker descendants;
ordinary bees never inherit privileged FDs or the service UID. Cross-workspace,
spoofed identity, arbitrary paths/argv/env, unknown bridges, replay conflicts and
attempt-handle theft must be refused at the broker and daemon boundaries.
Positive operator tests must validate protected owner access and registration;
ordinary live Cell hive commands must continue working. Any Cell escalation path
blocks enablement. Existing read-only bwrap root binds do not establish secrecy.

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
