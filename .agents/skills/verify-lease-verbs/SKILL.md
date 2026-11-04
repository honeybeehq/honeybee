---
name: verify-lease-verbs
description: Check the account-lease ordering rules and the bulk-key replay of account.lease.grant / account.lease.batch / account.lease.install / account.lease.remove with a TLA+ model (TLC) and the two-daemon end-to-end test. Use for /verify-lease-verbs, before landing any change to installLease's origin rule, removeLease, mintLeaseGrant or rpcAccountLeaseBatch, or when a lease window, epoch or replay question comes up.
---

# Verify the lease verbs

## What is verified, in one sentence each

- **A lease window never shrinks within an epoch.** Harm if broken: a stale or replayed payload shortens a live lease on a satellite, and bees there lose their account before the grid says they will.
- **Epochs only rise and the row's authority is the epoch's owner.** Harm: after a take-over, an old authority's payload resurrects itself on a satellite and two machines renew the same login.
- **A replayed bulk key is quiet.** Harm: a retried `account.lease.batch` installs or releases twice, or opens a second lease window for the same grant.

## Does my change touch the verified code?

The model describes these places. If a diff touches any of them, run the check and re-read the model against the code before trusting the result.

| model part | code |
|---|---|
| `Admits(p)` | `v2/daemon/src/accountsService.ts`, `installLease`, the `throw new RpcError("account_lease_conflict", "Lease origin conflicts with the installed lease.")` rule (shareId / epoch / authorityNodeId / expiresAt comparison) |
| `Apply(p)` | same function: `this.store.setAccountLease(id, origin)` with `revokedAt: null` |
| `Release` | `v2/daemon/src/accountsService.ts`, `removeLease` (disposition `revoked`, row kept) |
| `GrantWindow(w)` | `v2/daemon/src/daemon.ts`, `mintLeaseGrant` (window = `grantedAt + ttlMs`, carried as `install.expiresAt`) |
| `TakeOver` | Apiary's authority record epoch bump (not Honeybee code); the model only assumes epoch+1 with a new owner |
| `BatchFirstWindow` / `BatchReplayWindow` | `v2/daemon/src/daemon.ts`, `rpcAccountLeaseBatch`: receipt recorded under the key, replay answers from it, grants re-minted under the recorded window |

Sync commit: the commit that added this skill (`git log -1 --format=%H -- .agents/skills/verify-lease-verbs/SKILL.md`) describes the code at the time of the last confirmation. After a change to the files above, re-read the model, rerun, and only then move this line forward by committing the updated skill.

## Run

Two parts, both from the repository root.

1. The model. Use `/statechart` on `.agents/skills/verify-lease-verbs/LeaseVerbs.tla` with `LeaseVerbs.cfg` and `view.mjs`, in a scratch folder outside the repo. Read every result with `/statechart`; it names the rule that breaks and the shortest path in plain words. Without `/statechart`, plain TLC also works:

   ```sh
   java -cp "$TLA2TOOLS" tlc2.TLC -workers 1 -config LeaseVerbs.cfg LeaseVerbs.tla
   ```

   where `TLA2TOOLS` points at a `tla2tools.jar` (TLA+ tools 1.8.x, Java 11+). Expected: `Model checking completed. No error has been found.` with about 672 distinct states, in a few seconds.

2. The real code. Run the two-daemon test (needs the native bridge once: `node scripts/build-peercred.mjs`):

   ```sh
   node scripts/with-fixture-warden.mjs node scripts/run-v2-daemon-tests.mjs v2/daemon/tests/lease-grant-rpc.test.ts
   ```

   Expected: `pass 1`. Set `HB_LEASE_PROOF_LOG=<file>` to get the readable transcript.

## Make sure the check can still fail

Each rule has a broken variant of the model that must fail:

- `LeaseVerbs-broken-regress.cfg` (`RegressCheck = FALSE`, the expiresAt comparison removed from `Admits`) must break **WindowNeverShrinks** with a 4-step path: mint window 2, mint window 1, install 2, install 1.
- `LeaseVerbs-broken-replay.cfg` (`ReplayReusesReceipt = FALSE`, replay re-executes) must break **ReplayIsQuiet** in 3 steps.

The same break in the real code (delete the `input.expiresAt < knownAccountLease(account)!.expiresAt!` clause in `installLease`) makes the test fail at "a shorter window at the same epoch is refused". Last seen: `.proof/hb-lease-verbs/formal/scratch-break-run.log`.

## Reading a failure

- A rule breaks on the main config: that is a finding against the code (or an intended contract change). Do not weaken the rule. Report the path in the code's words: which payload (epoch, window, authority) installed after which.
- A rule passes on the main config but not on its broken variant: the model is fine.
- A broken variant passes: the model no longer models that rule; fix the model, not the code.
- The test fails but the model passes: the daemon's handler diverged from the model (parameter validation, ingress gate, receipt shape); read the assertion message and the transcript.

## Change the verification on purpose

When the contract changes (for example a release that frees the window for a shorter re-grant), change `Admits`/`Release` in the model to match the new code first, update the rule text above, confirm the broken variants still fail, rerun the test, and commit the skill with the code.

## Scope and bounds

- One share, one satellite row, one bulk key; windows 1..2, epochs 1..2 (`W = 2`, `MaxEpoch = 2`). Payloads may be delivered in any order and any number of times.
- Not modelled: adoption / enrolment / forwarded fences / native backups in `installLease`, keychain state, authority-instance and generation floors, interleaving of other RPCs inside one batch, time (a window is an ordinal, not a clock).
- The model's `TakeOver` is Apiary's epoch bump as an assumption, not Honeybee code.
