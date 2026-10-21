# External execution dev review

The adapter is `external-exec-v1`. Spawn chooses `bridgeId: urbench-v2`, never an
executable or arguments. The four permitted bridge operations are start, wait, stop
and reconcile. No guest credentials or provider calls are implemented.

Owner configuration has an `externalExec` object with `bridges` and `workspaces`.
Each bridge pins executable, filesManifest and payloadManifest absolute paths and
their SHA-256 values. Workspace entries must explicitly grant `external-exec.v1`
and the bridge id. Absent configuration grants nothing. The existing local RPC
trust challenge must authenticate the management caller; workspace context is an
assertion by that service, not by an ordinary bee. Agents with the same unrestricted
OS uid as management are not isolated by configuration alone; the management key
must remain outside their filesystem authority. Production integration needs Apiary
to carry the workspace assertion through its authenticated management channel.

The CLI `hive external-exec NAME --bridge urbench-v2 --workspace WORKSPACE --file
PRIVATE-DISPATCH --idempotency-key KEY` sends a typed spawn through daemon RPC.
It does not install an account, inject a preamble, resolve native Codex, or seed MCP.
No ordinary spawn profile may alias this adapter.

Before every bridge exec, the driver opens all three pinned files with O_NOFOLLOW,
requires root ownership and no write bits, and checks their bytes. On Linux the
executable is invoked through its already-open fd rather than re-opening its path.
The pinned launcher checks its runtime closure; host root/kernel remain trusted.
The environment is exactly PATH=/usr/sbin:/usr/bin:/sbin:/bin, LANG=C.UTF-8,
LC_ALL=C.UTF-8. Dispatch is canonical JSON with a trailing newline on stdin.

SQLite schema 48 adds external_exec: immutable attempt/bridge/workspace binding,
dispatch ownership, and validated terminal receipt. Claiming dispatch commits before
launch; every subsequent runtime reconciles, never blindly starts. Existing HSR hosts
own pipes, exact PID/birth identities and generation journals across daemon restart.
Stop is an in-band owner control invoking bridge stop, preserving capture and VM
ownership. Ordinary messages remain durable mail and are never converted into native
prompts. Conversation/account mutations are refused. Delete requires terminal proof.

Bridge events are validated for schema, invocation sequence and attempt/fence binding.
Terminal receipts additionally bind canonical dispatch and pinned payload. Native
stdout/stderr are copied unchanged into private generation output files and never
parsed as lifecycle commands. Bridge stderr is stored separately. Missing receipts,
exit 75, protocol failure or transport loss require reconciliation. A terminal model
failure is recorded independently of process exit; zero exit is not model success.

Public views optionally include externalExecution with bridge/workspace/attempt,
dispatch ownership and terminal status. No fencing capability, dispatch body, raw
receipt or host authentication material is mirrored. Snapshot/delta consumers must
accept this optional field and the new external_exec audit notifications. Schema 48
refuses older writers; rollback requires restoring the prior isolated store.

The only intended registration is the FINAL Ur Bench main 786395452f59b286fc328e7a491f0553606d7857.
The Cell-local .local/external-exec-dev/config.json pins its complete executable,
files.json and payload.sha256 hashes. It is not the live node configuration.
No bridge proof or guest start is permitted until Queen receives the code.
DEPLOY HOLD prohibits merge and deploy.

## Review limits

The current evidence is static/type checks, synthetic protocol/admission/path/HSR
stop tests, existing regression suites and a dev build. The FINAL pin checker reads
all three installed files and proves each mismatch refuses without executing the
bridge. No KVM round trip, live daemon registration, provider call or credential
probe has run. Usability requires Queen's code review followed by a separately
reported no-inference end-to-end exercise. Run the Cell CLI from this checkout:
its owner config uses /proc/self/cwd/.local/external-exec-dev/hived.sock to avoid
Linux's Unix-socket pathname length limit in this long Cell path. Accounts roots
are Cell-local empty directories and automatic naming/limits refresh are disabled.
The earlier Apiary swap storage contract remains unsupported at schema 48 rather
than silently widening its schema-47 authority attestation.
