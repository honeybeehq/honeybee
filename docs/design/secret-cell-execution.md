# Per-command Cell credential execution v1

Honeybee advertises `cell.secret.exec.v1` only with ready local process authentication. Apiary owns Hem release policy, grants, current membership, durable admission audit, and enrolled TLS. Honeybee owns Cell execution and capture. Arbitrary authorized commands are trusted: transformed output and deliberate exfiltration are outside exact-value masking. No Hem authority token belongs on a satellite.

The destination Apiary receiver must accept material only over enrolled peer TLS, check current enrollment/work inclusion, and require `nodeId` to equal its own node. It forwards one transient request over the local Unix socket from its registered process. It must never send this request through a durable command, retry queue, general request logger, outbox, or legacy transport. Honeybee cannot independently attest the upstream TLS leg.

Register using the existing `rpc.localTrust.challenge` and HMAC protocol, adding `nodeId` to `rpc.localTrust.register` parameters. The HMAC input remains `localTrustMessage(challenge)`. The node binding is an assertion by the authenticated local authority, pinned to its UID/PID/birth and registration lifetime. No node-relayed, remote, unregistered or session-principal connection may invoke the sensitive lane.

`cell.execSecret` params contain only:

```ts
{
  nodeId: string;
  beeId: string;
  cellId: string;
  executionId: string;
  idempotencyKey: string;
  argv: string[];
  argvDigest: string;
  expiresAt: number;
  cwd?: string;
  timeoutMs?: number;
}
```

The frame's protected context contains only `secretExecution`:

```ts
{
  secretExecution: {
    nodeId: string;
    beeId: string;
    cellId: string;
    executionId: string;
    argvDigest: string;
    expiresAt: number;
    env: Record<string, string>;
  }
}
```

All binding fields must match params, `nodeId` must match the local registration, and `idempotencyKey` must equal `executionId`. `argvDigest` is lowercase hex SHA-256 of UTF-8 `JSON.stringify(argv)`. `expiresAt` is integer Unix milliseconds, strictly in the future and at most 30 seconds away at admission and still unexpired immediately before spawn. The authenticated broker supplies a stable unique execution ID for each request. IDs use 1–256 ASCII alphanumeric/underscore/dot/colon/hyphen characters.

The bee must currently be active and own the registry Cell (`sourceBeeId`). Active and retained Cells are supported. Evicted/removed Cells refuse. The existing Cell-operation gate serializes command execution; this dedicated lane permits an existing harness runtime without changing its environment. A Cell command receives only the sanitized baseline plus validated per-command env; nothing is installed into daemon, harness, profile, account homes, or credential files. Existing Cell cwd containment and sandbox policy apply.

Environment input has 1–32 names, each uppercase identifier up to 128 characters; values are nonempty UTF-8 strings without NUL, at most 16 KiB each and 64 KiB total. Parent-location and common loader/hook variables are refused by `validateSecretEnv`. This is an accidental-injection control, not a confinement boundary for malicious commands.

Material exists only in protected frame context and child environment. Durable Cell-operation rows contain argv, cwd, timeout, a metadata binding digest, safe state/process identity and redacted output. Neither material nor its hash enters a durable row. The command is marked attempted before spawn. Duplicate IDs with changed argv/cwd/timeout/identity fail `idempotency_conflict`; duplicates with identical metadata return the original safe operation result. Interrupted recovery never blindly reruns the command. A retry after envelope expiry needs fresh broker admission and a renewed envelope; the same execution ID still resolves to the original operation.

Both raw stdout and stderr pass through byte redactors before the shared output cap, decoding, durable capture, or RPC response. Each stream masks the union of all exact-value matching byte intervals, including overlapping or adjacent matches across different values. It retains longest-value-length minus one raw bytes and their match-coverage bits between chunks, so a match beginning inside an earlier masked interval can extend its coverage into a later chunk. Each contiguous masked run emits one placeholder, including across chunks. Finalization follows the execution outcome. Successful zero-exit completion without stream errors masks any final suffix that is a prefix of an injected value, including incomplete UTF-8 bytes, before flushing remaining plain output. Cancellation, timeout, signal death, nonzero exit, stream errors and callback failure discard the held-back tail instead of flushing it. This can omit up to the retained overlap of otherwise ordinary output on abnormal completion. Spawn/callback failures on this path use generic text. Truncation applies after redaction so it cannot expose a cut secret prefix. Once the shared cap is full, further raw chunks are discarded without redaction work; streams continue draining. Placeholder is `[REDACTED]`; short values may coincide with placeholder bytes, so a placeholder does not promise elimination of every possible one-byte value from all protocol text.

`cell.execSecret.cancel` takes only `{nodeId,beeId,cellId,executionId}` and context `{}` from the same registered authority. It checks Cell ownership, durably tombstones an unseen ID, and aborts an active sensitive command (TERM requests immediate supervisor shutdown; Linux namespace teardown kills all descendants, while macOS kills the process group; daemon-side group KILL escalation follows after one second if needed). It returns `{cancelled:boolean}`: true means cancellation was submitted or a pre-execution tombstone exists, not that reaping has completed. A late execute for a tombstoned ID refuses. Completed results remain available. Apiary must map revoked grants to execution IDs and call cancel, including admission/dispatch races. Fresh archive admission also aborts this bee's active secret commands after validated enqueue; duplicate archive receipts do not repeat that effect. Final execution result uses the existing `CellExecResult`; interruption yields `status:"failed"`, `reason:null`, with safe captured output. The internal durable failure is `interrupted`. A busy refusal permanently settles its execution ID; a later attempt needs a fresh ID. The shared Cell-operation idempotency namespace requires globally unique IDs.

No harness shell interception is claimed. Only this dedicated command path is protected. JavaScript strings, child environments, swap and privileged process inspection preclude forensic memory-erasure guarantees.

Sensitive commands (including private capture) run under a separate supervisor. A dedicated inherited pipe carries transient spawn configuration and stays open as an owner lease; it is not inherited by the command. The launcher and supervisor receive only the sanitized baseline environment. Before configuration is sent, the supervisor acknowledges readiness on the private pipe; closure without readiness fails as `secret_execution_containment_unavailable`, preserved as a safe failure string by the daemon. The supervisor sets a monotonic timeout before command spawn and shuts down on owner-pipe EOF, cancellation, deadline, or command exit.

On Linux, `/usr/bin/unshare --user --map-current-user --pid --mount --mount-proc --fork --kill-child=SIGKILL` launches the supervisor as init (PID 1) of a private PID namespace. The supervisor refuses to consume configuration unless it is PID 1. Namespace init automatically adopts orphaned descendants, including ordinary double-fork/`setsid`/Node `detached:true` daemons; a separate `PR_SET_CHILD_SUBREAPER` or sampled `/proc` tree is unnecessary. When init exits or is killed, the kernel kills every remaining process in that namespace, including new sessions/groups and descendants in nested PID namespaces. If the unshare launcher dies, its configured parent-death signal kills init. Thus either launcher or supervisor SIGKILL also tears down detached descendants independently of the Honeybee daemon. No cgroup delegation is required. Run `npm run probe:secret-containment` on each destination before rollout; it checks actual namespace setup and reports kernel/launcher versions without credential material. Each execution also probes readiness before injecting configuration. Availability is verified only on the tested netcup-1 host, not the fleet; util-linux option support and unprivileged-user-namespace policy vary by host. Linux refuses execution if util-linux unshare, user/PID namespace support, or required permissions are unavailable; there is no process-group fallback. Commands retain their numeric UID/GID but observe namespace-local PIDs; this is a process-lifetime mechanism, not a general filesystem/network confinement boundary. A private mount namespace mounts `/proc` for the new PID namespace before the supervisor starts. Namespace-local PIDs therefore match `/proc/<pid>`, and nested bwrap can resolve its namespace handles correctly while still enforcing its own filesystem sandbox. The capability preflight checks this PID/proc agreement. Adopted orphan zombies remain until init exits, bounded by the command timeout. User namespace creation grants namespace-scoped capabilities and exposes additional kernel namespace APIs. Work delegated through pre-existing host services (for example systemd-run, cron, tmux, or ssh multiplexers) is outside this process tree and is not contained.

On macOS the supervisor uses the portable pipe and process-group mechanism only. Ordinary descendants that daemonize into another session/group can survive cleanup; there is no claim of detached-descendant safety or supervisor-SIGKILL containment on macOS. This is an explicit platform limit until a kernel-backed containment mechanism is available. Runtime verification here covers the tested Linux host with both `sandbox:false` and the default satellite bwrap path (`sandbox:null`); macOS remains unverified. Targeted tests verify writable Cell/read-only outside paths, proc/PID agreement, redaction, private capture and grouped/detached descendant teardown with bwrap enabled.

Durable process identity names the launcher (Linux) or supervisor (macOS); attempted state prevents replay. A graceful daemon shutdown closes the owner lease and ends sensitive commands; harness runner-host survival is unchanged. On boot, existing Cell-operation recovery conservatively records absent running attempts as `outcome_unknown`/`process_absent` (effects before termination are unknown), releases the gate, and never replays argv. Pre-PID attempts retain `process_identity_unavailable` fencing. Grant revocation cannot undo effects or copies already produced by an authorized command. Matching covers the union of all matching intervals within each stream, with conservative trailing-prefix masking on successful completion and tail discard on abnormal completion. No byte of a matched value is emitted as plain output, including overlapping matches. Interior fragments that do not match a full value, transformed output and combinations across separate streams remain outside this exact-value guarantee; masking is not general substring concealment.

Linux lifetime semantics: [pid_namespaces(7)](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html), [unshare(1)](https://man7.org/linux/man-pages/man1/unshare.1.html).


Verification uses only synthetic sentinels in `v2/driver-cell/tests/secret-output.test.ts` and `v2/daemon/tests/secret-execution.test.ts`, plus existing exec/local-trust tests. The daemon fixture scans raw SQLite/WAL files and fixture output, checks duplicate/reopen behavior and cancellation-before-spawn, and prints counts without values. TLS enrollment enforcement must additionally be verified in the Apiary receiver integration.


## Private stdout capture

`cell.secret.capture.v1` is advertised with the same local authentication readiness as
`cell.secret.exec.v1`. Capture uses `cell.execSecret` with matching metadata-only
`outputCapture: {name,maxBytes,leaseId,expiresAt}` in params and protected
`secretExecution`. The context omits `env`. Names are credential display names of 1–120 NUL-free characters,
lease IDs follow execution ID syntax, maxBytes is 1–16384, and lease expiry is integer
Unix milliseconds strictly in the future and at most 30 seconds away at admission.

Stdout bypasses ordinary output capture and redaction into a bounded private Buffer.
Stderr is drained and discarded. Normal and durable results have empty stdout/stderr.
Only zero exit, no cancellation, no timeout, no overflow, and an unexpired lease release
bytes. The Buffer is cleared after the synchronous private response callback consumes it.
The registered local process receives the JSON frame
`{id,ok:true,result:CellExecResult,secretCapture:{leaseId,bytesBase64}}`.
The private field belongs to the transport envelope, never CellExecResult. Callers must
extract it through their private response callback and exclude it from ordinary results,
logs, journals, transcripts and durable transports. Duplicate execution IDs return only
the safe durable result and never release bytes again. Admission metadata participates
in the idempotency binding; a changed capture lease requires a fresh execution ID.

Capture delivery is at most once: a dropped response cannot be recovered. The broker
must use a fresh execution ID for a new attempt. `deduped:true` distinguishes replay
from a successful empty stdout capture, which carries `bytesBase64:""`. Buffer clearing
does not erase transient base64 strings, JSON frames, kernel buffers or privileged
process inspection evidence. Capture mode intentionally sends raw stdout to the trusted
authority and performs no exact-value masking on that private response.
