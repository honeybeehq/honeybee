---
name: verify-lease-verbs
description: Check the account-lease ordering rules and the bulk-key replay of account.lease.grant / account.lease.batch / account.lease.install / account.lease.remove with a TLA+ model (TLC) and the two-daemon end-to-end test. Use for /verify-lease-verbs, before landing any change to installLease's origin rule, removeLease, mintLeaseGrant or rpcAccountLeaseBatch, or when a lease window, epoch or replay question comes up.
---

# Verify the lease verbs

## What is verified, in one sentence each

- **A lease window never shrinks within an epoch.** Harm if broken: a stale or replayed payload shortens a live lease on a satellite, and bees there lose their account before the grid says they will.
- **Epochs only rise and the row's authority is the epoch's owner.** Harm: after a take-over, an old authority's payload resurrects itself on a satellite and two machines renew the same login. Since H6 the epoch and share id live on the authority's account row (`accounts.share_id`, `accounts.share_epoch`); a grant derives them and a caller-supplied value must agree.
- **A replayed bulk key is quiet.** Harm: a retried `account.lease.batch` installs or releases twice, or opens a second lease window for the same grant.
- **A replayed key answers only its own items, and every mint is audited.** Harm if broken: anyone holding a key (it appears in the `rpc.dedup` log line) pulls fresh credential material for other items, unaudited.
- **The owner signs the authority.** Harm if broken: a caller names another node as `authorityNodeId`, and node X's material renews node Q's lease on a satellite while the audit blames Q.
- **An enrolled row renews from its own authority, and from nobody else at its epoch.** Harm if broken: a row enrolled under the old scheme (`enrol: true`, the satellite's own access-only login handed to the authority's share) whose last publication was left unknown (`materialPublished: false`) and whose expired material hived swept re-proves local material on every install and finds none, so the authority's renewal is refused `account_lease_enrol_refused` (unknown_material) for ever (claude-tormod-polytext.io on mini05 and mini06, Nov 2026). Now a plain payload from the row's own share and authority republishes it without a local primary; the gate's other refusals (native row, private authority or refresh chain, busy, locked Keychain, foreign home) and the ordering rule (same epoch, other authority is `account_lease_conflict`) stay.

## Does my change touch the verified code?

The model describes these places. If a diff touches any of them, run the check and re-read the model against the code before trusting the result.

| model part | code |
|---|---|
| `Admits(p)` | `v2/daemon/src/accountsService.ts`, `installLease`, the `throw new RpcError("account_lease_conflict", "Lease origin conflicts with the installed lease.")` rule (shareId / epoch / authorityNodeId / expiresAt comparison) |
| `Enrol`, `PublishLost`, `Admitted(p)` | same function: the enrolment branch (`enrolment`, `materialPublished`), the gate `if (input.enrol || enrolment && previous?.materialPublished !== true)` with `assertEnrolmentQuiescent` and `assertEnrolmentMaterial(current, codec, state, !republish)` where `republish` is a plain install whose `shareId`/`authorityNodeId` match the row (`sameOrigin`); `PublishLost` is the `setAccountLease(id, { ...origin, materialPublished: false })` write that never reached the final `setAccountLease(id, origin)` |
| `Apply(p)` | same function: `this.store.setAccountLease(id, origin)` with `revokedAt: null` |
| `Release` | `v2/daemon/src/accountsService.ts`, `removeLease` (disposition `revoked`, row kept) |
| `GrantWindow(w)` | `v2/daemon/src/daemon.ts`, `leaseGrantParams` (authorityNodeId must be `ownNodeIds()`; `shareId`/`epoch` optional) and `mintLeaseGrant` (share facts from `deriveShareFacts`: the account row's `shareId`/`shareEpoch`, seeded once; window = `grantedAt + ttlMs`, carried as `install.expiresAt`; audits `account.lease.granted`) |
| caller gate (not modelled) | `v2/daemon/src/rpc.ts`, the `account.lease.grant` / `account.lease.batch` branch (registered local authority only) and `v2/daemon/src/confinedPeer.ts`, `assertConfinedVerb` |
| `TakeOver` | the credential handoff plane: `v2/daemon/src/credentialHandoff.ts` `export` derives epoch = row epoch + 1 when the caller gives none, and `v2/core/src/store.ts` `putCredentialAuthorityEpoch` raises the row's `share_epoch` on adoption, release and stand-down (never lowers it); the model assumes epoch+1 with a new owner |
| `BatchFirstWindow` / `BatchReplayWindow` | `v2/daemon/src/daemon.ts`, `rpcAccountLeaseBatch`: receipt `{principal, itemsDigest, entries}` reserved under the key before items run, replay refused on another principal / other items / an unfinished first run, grants re-minted under the recorded window with `replay: true` audits |

Sync commit: the commit that added this skill (`git log -1 --format=%H -- .agents/skills/verify-lease-verbs/SKILL.md`) describes the code at the time of the last confirmation. After a change to the files above, re-read the model, rerun, and only then move this line forward by committing the updated skill.

## Run

Three parts, all from the repository root.

1. The model, without Java. `lease-verbs.ts` is the same model (one action per TLA+ action, the same constants and invariants) searched breadth-first by the pinned Node, the way the Champion lifecycle model is checked; it is what runs on a satellite with no Java:

   ```sh
   node --experimental-strip-types .agents/skills/verify-lease-verbs/lease-verbs.ts
   ```

   Expected: `Model checking completed. No error has been found.` with 20685 distinct states (W 2, MaxEpoch 2, at most 3 mints), in about a second, exit 0. A violation prints the rule, the state in the code's words and the shortest path of verbs, exit 12. Keep `lease-verbs.ts` and `LeaseVerbs.tla` in step: a change to one is a change to the other.

2. The model under TLC, where Java exists. Use `/statechart` on `.agents/skills/verify-lease-verbs/LeaseVerbs.tla` with `LeaseVerbs.cfg` and `view.mjs`, in a scratch folder outside the repo, or plain TLC:

   ```sh
   java -cp "$TLA2TOOLS" tlc2.TLC -workers 1 -config LeaseVerbs.cfg LeaseVerbs.tla
   ```

   where `TLA2TOOLS` points at a `tla2tools.jar` (TLA+ tools 1.8.x, Java 11+). Expected: `Model checking completed. No error has been found.`; the state count should match the Node checker's. The enrolment extension (`Enrol`, `PublishLost`, `ForeignGrant`, `Admitted`, `OwnerRenews`) was written on a satellite without Java and has not yet been run under TLC; the first run with Java confirms it and may move this line.

3. The real code. The security cases (caller gate, owner-signed authority, node-bound payloads, key binding, audited replays, redacted CLI) are the `hb-lease-fix` test in `v2/daemon/tests/lease-export-rpc.test.ts`; run it under the fixture warden (needs the native bridge once: `node scripts/build-peercred.mjs`):

   ```sh
   HB_LEASE_PROOF_LOG=/tmp/lease-run.md node scripts/with-fixture-warden.mjs node scripts/run-v2-daemon-tests.mjs v2/daemon/tests/lease-export-rpc.test.ts
   ```

   Expected: `pass 2`, and `/tmp/lease-run.md` holds the readable transcript. The original grant/install/renew/release/move/bulk driver stays as evidence at `.proof/hb-lease-verbs/lease-grant-rpc.e2e-driver.ts.txt` (recorded run: `.proof/hb-lease-verbs/e2e-two-daemons.md`); copy it into `v2/daemon/tests/` to rerun it, do not commit it.

   The enrolled-row rule is the three-daemon driver `.proof/lease-enrolled-renewal/driver.ts` (authority, satellite with a row enrolled the old way and left revoked with an unknown publication, and a foreign node), with every `HIVE_*` variable unset:

   ```sh
   HB_LEASE_RENEWAL_LOG=/tmp/lease-renewal.md node scripts/with-fixture-warden.mjs node --experimental-strip-types .proof/lease-enrolled-renewal/driver.ts --expect after
   ```

   Expected: `AFTER THE FIX: ALL CHECKS PASSED` (recorded: `.proof/lease-enrolled-renewal/run-after.md`); `--expect before` on the code without the fix records the refusal (`.proof/lease-enrolled-renewal/run-before.md`). The gate's own refusals (native row, refresh chain in home, vault, mirror, Keychain, profile or temp copy, private authority, busy, symlinks) are `v2/daemon/tests/lease-enrol.test.ts`.

## Make sure the check can still fail

Each rule has a broken variant of the model that must fail:

- `LeaseVerbs-broken-regress.cfg` (`RegressCheck = FALSE`, the expiresAt comparison removed from `Admits`) must break **WindowNeverShrinks** with a 4-step path: mint window 2, mint window 1, install 2, install 1.
- `LeaseVerbs-broken-replay.cfg` (`ReplayReusesReceipt = FALSE`, replay re-executes) must break **ReplayIsQuiet** in 3 steps.
- `LeaseVerbs-broken-authority.cfg` (`OwnerSignsAuthority = FALSE`, the caller's authorityNodeId is copied in) must break **AuthorityMatchesEpoch** in 2 steps.
- `LeaseVerbs-broken-items.cfg` (`ReplayChecksItems = FALSE`, a key answers for other items) must break **ReplayAnswersOwnItems** in 3 steps.
- `LeaseVerbs-broken-audit.cfg` (`AuditReplay = FALSE`, re-mints on replay are silent) must break **EveryMintAudited** in 3 steps.
- `LeaseVerbs-broken-supersede.cfg` (`SupersedeEnrolled = FALSE`, the 9d95df22 gate: an enrolled row with an unknown publication refuses every payload) must break **OwnerRenews** in 4 steps: grant, enrol, publication lost, the owner's install refused.
- `LeaseVerbs-broken-foreign.cfg` (`ForeignSupersedes = TRUE`, an enrolled row also takes a same-epoch payload from another node) must break **AuthorityMatchesEpoch** in 3 steps: enrol, foreign grant, install.

With the Node checker the same variants are `--break regress|replay|authority|items|audit|supersede|foreign`, each exit 12 with the path above (recorded: `.proof/lease-enrolled-renewal/checker-run.log`).

The same break in the real code (delete the `input.expiresAt < knownAccountLease(account)!.expiresAt!` clause in `installLease`) makes the two-daemon driver fail at "a shorter window at the same epoch is refused". Last seen: `.proof/hb-lease-verbs/formal/scratch-break-run.log`.

## Reading a failure

- A rule breaks on the main config: that is a finding against the code (or an intended contract change). Do not weaken the rule. Report the path in the code's words: which payload (epoch, window, authority) installed after which.
- A rule passes on the main config but not on its broken variant: the model is fine.
- A broken variant passes: the model no longer models that rule; fix the model, not the code.
- The two-daemon driver fails but the model passes: the daemon's handler diverged from the model (parameter validation, ingress gate, receipt shape); read the assertion message and the transcript.

## Change the verification on purpose

When the contract changes (for example a release that frees the window for a shorter re-grant), change `Admits`/`Release` in the model to match the new code first, update the rule text above, confirm the broken variants still fail, rerun the driver, and commit the skill with the code.

## Scope and bounds

- One share, one satellite row, one bulk key; windows 1..2, epochs 1..2 (`W = 2`, `MaxEpoch = 2`), at most 3 mints per behaviour. Payloads may be delivered in any order and any number of times.
- The caller gate (registered local authority, confined peers, relayed lanes) and the principal binding of a key are checked by the test, not the model.
- Enrolment is modelled as the row's receipt (`enrolled`) and the state of its last publication (`published`); the owner's payloads are what `account.lease.grant` mints. Not modelled: adoption, forwarded fences and native backups in `installLease`, keychain state, authority-instance and generation floors, the local material the gate inspects (its refusals are tests), interleaving of other RPCs inside one batch, time (a window is an ordinal, not a clock).
- The model's `TakeOver` is Apiary's epoch bump as an assumption, not Honeybee code.
