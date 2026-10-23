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

Both raw stdout and stderr pass through byte redactors before the shared output cap, decoding, durable capture, or RPC response. Each stream matches longest exact values, retains longest-value-length minus one bytes between chunks, and flushes on stream error and child close. Spawn/callback failures on this path use generic text. Truncation applies after redaction so it cannot expose a cut secret prefix. Placeholder is `[REDACTED]`; short values may coincide with placeholder bytes, so a placeholder does not promise elimination of every possible one-byte value from all protocol text.

`cell.execSecret.cancel` takes only `{nodeId,beeId,cellId,executionId}` and context `{}` from the same registered authority. It checks Cell ownership, durably tombstones an unseen ID, and aborts an active child group (TERM, then KILL after one second if needed). It returns `{cancelled:boolean}`: true means cancellation was submitted or a pre-execution tombstone exists, not that reaping has completed. A late execute for a tombstoned ID refuses. Completed results remain available. Apiary must map revoked grants to execution IDs and call cancel, including admission/dispatch races. Archive admission also aborts this bee's active secret commands. Final execution result uses the existing `CellExecResult`; interruption yields `status:"failed"`, `reason:null`, with safe captured output. The internal durable failure is `interrupted`.

No harness shell interception is claimed. Only this dedicated command path is protected. JavaScript strings, child environments, swap and privileged process inspection preclude forensic memory-erasure guarantees. Abrupt daemon death loses in-memory cancellation handles; durable process identity and attempted state prevent replay but cannot retract already released material. Grant revocation cannot undo effects or copies already produced by an authorized command.

Verification uses only synthetic sentinels in `v2/driver-cell/tests/secret-output.test.ts` and `v2/daemon/tests/secret-execution.test.ts`, plus existing exec/local-trust tests. The daemon fixture scans raw SQLite/WAL files and fixture output, checks duplicate/reopen behavior and cancellation-before-spawn, and prints counts without values. TLS enrollment enforcement must additionally be verified in the Apiary receiver integration.
