# T11g: host-side Codex refresh and delivery plan

Status: source investigation completed. Queen granted conditional design GO at 2026-10-28 16:44 UTC; the four conditions below govern implementation. No implementation is included in this document. No live credentials, account stores or sockets were read, and no token actions or provisioning were performed. References below are to review/hdm-T11-gateway at 939ae295; the final frozen canonical T11 batch is 75e3004e. The reported expiry around 2026-10-30 11:00 UTC is unverified operator context.

## Finding

Honeybee already has automatic host-side Codex OAuth refresh for enrolled central-authority accounts. The unresolved availability problem is delivery into a running Cell: T11 binds individual credential files read-only, and the host publishes replacements by atomic rename. That mount pins the old inode. Refreshing the host pathname alone therefore does not update an existing Cell's mounted credential file.

## Existing refresh owner and triggers

CodexCredentialAuthority extends the shared CredentialAuthority (v2/daemon/src/codexCredentialAuthority.ts:49), with the provider refresh transport at lines 35–46. AccountsService constructs it at v2/daemon/src/accountsService.ts:1063–1092. There is already one serialized authority lane per account, rather than one refresher per Cell.

The daemon account tick invokes centralEarlyRefreshTick at v2/daemon/src/daemon.ts:1478. Despite its Claude-only comment, the implementation handles Codex too: v2/daemon/src/accountsService.ts:4270–4287 skips paused, unknown-lease and leased receiver accounts; checks earlyRefreshDue; and calls ensure with the Codex 15-minute minimum. The default early window is three hours (v2/daemon/src/config.ts:445), with failure backoff capped at fifteen minutes (accountsService.ts:4284).

This is conditional, not a guarantee that the shared account is enrolled. CredentialAuthority.ensure refuses absent or disabled authority state and login_required (v2/daemon/src/claudeCredentialAuthority.ts:731–738). Its TTL/refresh path is at lines 756–822. Native activateForSpawn returns before the ensure path (accountsService.ts:4342–4352). No live metadata was examined to establish enrollment, authority node, phase, native status, or expiry.

Additional triggers exist: account.credentials.refresh dispatches to the authority (daemon.ts:2121–2134); non-native spawn admission ensures minimum lifetime (accountsService.ts:4350); and mintCodexLease ensures freshness before issuing a lease (accountsService.ts:3906–3923). An enrolled authority does not fall back to native rotation if it fails to produce enough lifetime. A leased receiver must obtain renewed material from the owning authority; centralEarlyRefreshTick explicitly excludes it. This investigation does not establish an automatic cross-node lease-renewal loop.

## Projection semantics

The projection enumerates input source/destination files rather than copying their contents (v2/driver-cell/src/harnessHome.ts:42–79). The launcher mounts each with --ro-bind and sets the private CODEX_HOME (v2/driver-cell/src/sandbox.ts:422–423).

Host refresh publishes auth.json and its access-only mirror using atomicWriteFileSync (accountsService.ts:1082–1090). That helper writes a temporary sibling and renameSync replaces the pathname (v2/daemon/src/homeDefaults.ts:41–47). Lease installation likewise uses atomic writes (accountsService.ts:1753,1761).

The stale-inode conclusion follows from Linux file-bind semantics and these source paths; no credential or mount experiment was performed for this plan. A new launch binds the replacement inode. No existing projection-remount hook was found. Clearing auth_needed alone is insufficient: authResume credential validation and reconciliation queue work, but do not replace these mounts (v2/daemon/src/authResume.ts:101–180).

## Recommended minimal design

Reuse the existing authority scheduler. Do not add a second OAuth writer or a credential verb to the six-verb Cell gateway. Credential operations remain forbidden there, including a tokenless refresh broker.

The owning authority refreshes once; any satellite lease publisher delivers access-only replacement material to the correct host. Host maintenance then schedules a controlled new Cell runtime generation at an explicit safe turn boundary, preserving Bee identity, conversation, private state and durable mailbox. The new launch reconstructs file mounts against the fresh inode. Fence maintenance by account material generation and exact runtime generation/PID/birth; coalesce concurrent refresh events. Queen accepted this relaunch design, conditional on the access-only launch gate, receipts and synthetic verification below; it is not implemented.

Do not mark a Cell restored merely because a host refresh succeeded. Require a receipt that the new generation mounted the intended material generation, followed by the normal harness authentication outcome. If no safe boundary is available before expiry, expose the availability risk to the operator; do not interrupt active work based on silence or fabricate idle.

A later design could mount a dedicated host-owned access-only credential directory read-only, making atomic child replacements visible by pathname. It must isolate mutable Codex state, exclude refresh tokens, and prove that Codex reloads credentials. Do not expose the shared account home, invent an unsupported auth-file option, or replace atomic publication with in-place partial writes.

## Failure behavior

Retain the existing authority single-flight, retry/backoff and login_required rules. Elective transient refresh failure may retain still-valid material; rejected or uncertain refresh outcomes require explicit auth_needed and human recovery, with no agent-driven login or provisioning. A delivery or relaunch failure must not clear the condition on evidence of host freshness alone. Avoid repeated revives against unchanged credentials; preserve queued mail and stop admission when usable authentication cannot be established. No fallback to host sockets or credential APIs is permitted.

## Named ownership and deadline

Engineering investigation/design owner: 265af7ab-4123-41a6-8779-aeb77951a790 (this T11g worker). Coordination owner: ac05ab9c-2a8e-4e8a-bd7f-690609c67d82. Security/design approval: Queen, 7788f0ba-4d39-4002-a75b-72d276b2eea3. The operational refresh executor is the owning authority node's hived AccountsService/CodexCredentialAuthority, never a Cell. Credential login/enrollment remains a human operation by Tormod or a Queen-authorized human.

The exact account and authority machine cannot responsibly be named from source alone. Queen now authorizes ac05ab9c, or a worker it explicitly names, to use hive’s own redacted account status/list on each node holding a Codex account used by Cells. Record authority node, native/central/leased mode, phase, material generation and exact UTC expiry. Do not read auth.json or any credential file, use keychain/security, or print token fields. If the CLI cannot report expiry without token bytes, stop and report that limitation; do not work around it. Replace the approximate expiry above with the resulting exact UTC metadata. Assign a named human delivery owner from that inventory. If inventory finds a native account, central-authority enrollment is a required human step for Tormod, never an agent token action.

Recommended decision deadline: 2026-10-29 11:00 UTC, giving roughly 24 hours before the reported expiry. If that expiry and default configuration are confirmed, the existing early scheduler would become due around 2026-10-30 08:00 UTC. This is conditional timing, not a promise. Renewed lease delivery and a fresh Cell projection must be demonstrated before expiry. Until then T11g remains a deploy-HOLD precondition; this document grants no rollout approval.

## Required verification before implementation approval

Use synthetic credentials only: simulated-clock early refresh, per-account single-flight, backoff and leased-receiver exclusion; atomic replacement showing a file bind stays stale and the chosen delivery method sees the new marker; no token or refresh bytes crossing the gateway; generation-fenced delivery across restart and failure; auth_needed without revive churn and with mailbox preservation. Test actual Codex credential reload behavior separately under human-approved credential handling. None of these new tests ran in this source-only task.

## Queen conditions incorporated, 2026-10-28 16:44 UTC

Sandboxed Codex Cells may launch only with access-only credential material. Read-only is insufficient: a native auth.json can contain a refresh token. Central publication blanks refresh tokens only on the accessOnly path (accountsService.ts:1079–1090). Before binding either auth.json or .codex/auth.json, the projection must validate that refresh_token is blank and refuse native/full documents with auth_needed. No refresh token may enter the Cell. Validate every projected credential document, not just the mirror. Do not log document contents. Human enrollment is required if inventory identifies native credentials. This launch gate must be implemented and verified before sandboxed Codex rollout.

Refresh and delivery maintenance coalesces per account and never interrupts a turn. At the safe turn boundary it starts a generation-fenced replacement, records the material-generation mount receipt and observes the harness authentication result. A single turn that outlasts the early-refresh window receives a clean auth_needed at its authentication boundary; it must not cause repeated retries or revive churn.

Inventory and conditions must be settled by 2026-10-29 11:00 UTC. If the relaunch path has not been demonstrated before the confirmed expiry, the explicit fallback is visible auth_needed followed by Tormod’s manual restart. The T11 proof must state this fallback so Tormod knowingly accepts the availability limit. This is not automatic permission to interrupt a turn.

The deploy HOLD remains until the listed synthetic-credential verification runs on a satellite, including rejection of native/full documents and a turn that outlasts the early window. Queen’s design GO does not grant a deploy GO. Project publication remains paused pending the Studio all-clear.

## Implementation follow-up

Implementation branch review/hdm-T11g-refresh starts at ca5ccb6e. Queen's subsequent Apiary source trace confirms proactive receiver lease renewal at 60 minutes before expiry, not the authority scheduler's three-hour window. account.lease.install completion is the delivery trigger. Runtime receipts and host-side operator recovery are documented in docs/security/t11g/rollout.md. Source review and synthetic verification continue; proof/Project publication wait for the Studio all-clear. Snapshot retention now keeps all live digests and the newest eight unreferenced documents; the temporary 128-publication refusal was removed after review.


## Final reviewed behavior

Queen and Quiet source-pass e7ef06bd; 04de8e84 adds only the conservative guard rollout note. Identical valid mounted/current bytes now receive a fenced monotonic host expiry/material update with no new digests or restart, bounded by the published source expiry. New-byte publications use the safe-boundary restart. A durable sliding six-hour guard permits one account/publication round for the whole affected cohort, refusing a distinct second round visibly until the window elapses. Account-wide guard attention is conservative, including still-valid Cells. Expired/superseded 401s stay Bee-local. authenticationHintAt is explicitly a Cell-controlled hint; prepared/mounted remain host proofs. Old owned staging files are swept after ten minutes. Final verification receipts bind 04de8e84 in .audit/T11g-final (174 targeted:170pass4skip0fail; check/v2check/build exit0). Live preflight execution, first-Cell rollout receipts, proof submission and deployment remain separately gated.
