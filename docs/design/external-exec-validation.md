# External execution dev validation

Original base: 77d877c0c9cb19c4e93451635ae27d9f713a8765.
Review fixes start at 5182bf0eac730b9d538ddd77026cae531b28dec1.
Satellite Cell only. No merge, deploy, live configuration change, real bridge
lifecycle invocation, guest start, provider request or guest credential delivery.
This is review code; the Cell registration is now disabled.

## Review-fix checks

- `git diff --check`.
- `npm run check`, `npm run v2:check`, and `npm run build`.
- `npm run v2:test`: 604 core tests and 6 fleet projection checks pass.
- `npm run v2:driver`: 172 adapter/HSR tests pass, including survivor adoption.
- Final external suite: 21 passing tests. Covers attempt/fence/dispatch/install binding, private
  bootstrap absent from SQLite/config/transcript, prototype plaintext refusal,
  restrictive mode reapplied to an existing config, separate management and
  observation slots, registered workspace overriding spoofed context, challenge
  relay refusal, owner-file policy, default-off capability, path safety, fd exec,
  per-stream caps, owner stop, escalation, and a missing-adapter stop fallback.
- Targeted config/local RPC regression run: 41 passing tests (overlaps the above).
- Current FINAL install check: `external_exec_install_chain_writable`, before
  any exec. The exact candidate pins remain in external-exec-owner-candidate.json.
  This is a refusal row, not evidence that the package is executable under policy.

Logs and the eventual patch are under `.local/external-exec-dev/`, prefixed `fix-`.
The candidate owner JSON is deliberately inside the Cell and cannot be loaded as
management authority. No protected outside-Cell owner files were provisioned;
temporary test fixtures contain only synthetic keys and dispatches.

## Failures and limits

The first review-fix targeted run caught an incorrectly located authority fixture
(the Cell's group-writable ancestors correctly refused it). A later run exposed a
real early-stop race: the host control lane was still connecting after output had
arrived. Stop now queues control while retaining its bounded escalation deadline.
One new fallback test initially emitted no ready event; its fixture was corrected.
These failures are retained here rather than presented as clean first runs.

The previous review's full daemon run stopped at two delivery-file-read fixture
setup errors: no base outside private mounts with a socket pathname <=103 bytes.
It reported 770 pass, 2 fail and 1 skip; later serial files were not reached.
The review-fix full daemon run reproduced exactly those two fixture refusals:
773 tests, 770 pass, 2 fail and 1 skip. Later serial files were not reached.
Its log is fix-daemon-tests.log; no unrelated fixture code was changed.

No KVM round trip or real bridge start/wait/stop/reconcile has been exercised.
The current home-directory install is refused even when all three hashes match.
Trusted management must arrange an immutable root-owned install chain and protected
management filesystem/socket authority. An unrestricted same-uid bee can read
0600 management files; mode checks alone do not isolate it. Likewise, omitting HOME
does not prevent getpwuid or direct access to the real home. A separate uid or
sandbox is required. Relocating the launcher may require new pins from Ur Bench.

Schema 48 is unreleased. Plaintext prototype stores/configs must remain private
and be retired; opening an old binding refuses and does not silently convert or
securely erase its pages/WAL. Use a fresh isolated dev store. Apiary's schema-47
swap authority remains unsupported rather than widened.

Queen must review this fix head before any guest proof. DEPLOY HOLD remains in
force. Phase 3 has no code; Tormod decision 7a0b4e6b is still pending.
