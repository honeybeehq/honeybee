---------------------------- MODULE LeaseVerbs ----------------------------
(* One account share, one leased row on one satellite, one bulk key.      *)
(* Owner side: v2/daemon/src/daemon.ts mintLeaseGrant (account.lease.grant) *)
(* Satellite side: v2/daemon/src/accountsService.ts installLease (the      *)
(*   "Lease origin conflicts with the installed lease" rule) and removeLease *)
(* Bulk key: v2/daemon/src/daemon.ts rpcAccountLeaseBatch                  *)
EXTENDS Naturals, FiniteSets

CONSTANTS W,                   \* lease windows are 1..W (larger = later expiresAt)
          MaxEpoch,            \* share epochs are 1..MaxEpoch; +1 on take-over
          RegressCheck,        \* TRUE = installLease refuses a shorter window at the same epoch
          ReplayReusesReceipt  \* TRUE = a replayed batch key answers from its receipt

Windows == 1..W
Epochs == 1..MaxEpoch
OwnerOf(e) == IF e % 2 = 1 THEN "A" ELSE "C"   \* A owns odd epochs, C owns even ones (take-over)

VARIABLES ownerEpoch,   \* the share epoch Apiary's authority record carries now
          payloads,     \* install payloads minted so far: Apiary may deliver any of them, late or twice
          epoch,        \* satellite row: 0 = no row yet, else the installed epoch
          window,       \* satellite row: the installed lease window (expiresAt)
          authority,    \* satellite row: authorityNodeId of the installed lease
          revoked,      \* satellite row: lease.remove ran (disposition revoked)
          accepted,     \* history of every install the satellite accepted
          keyState,     \* the one bulk key: "none" | "recorded"
          receipt,      \* what the key recorded: the grant window and whether the install item was accepted
          installRuns,  \* how many times the key's install item really executed
          replayWindow  \* the grant window the last replay answered (0 = no replay yet)

vars == <<ownerEpoch, payloads, epoch, window, authority, revoked, accepted, keyState, receipt, installRuns, replayWindow>>

Payload(e, w) == [epoch |-> e, window |-> w, node |-> OwnerOf(e)]
Max(S) == CHOOSE m \in S : \A x \in S : x <= m

Init ==
  /\ ownerEpoch = 1
  /\ payloads = {}
  /\ epoch = 0 /\ window = 0 /\ authority = "none" /\ revoked = FALSE
  /\ accepted = {}
  /\ keyState = "none"
  /\ receipt = [grantWindow |-> 0, installOk |-> FALSE]
  /\ installRuns = 0
  /\ replayWindow = 0

\* account.lease.grant on the owner: mint for the current share epoch with a chosen window.
GrantWindow(w) ==
  /\ payloads' = payloads \cup {Payload(ownerEpoch, w)}
  /\ UNCHANGED <<ownerEpoch, epoch, window, authority, revoked, accepted, keyState, receipt, installRuns, replayWindow>>

\* Apiary's take-over commits a new authority record: epoch + 1, authored by the new owner.
TakeOver ==
  /\ ownerEpoch < MaxEpoch
  /\ ownerEpoch' = ownerEpoch + 1
  /\ UNCHANGED <<payloads, epoch, window, authority, revoked, accepted, keyState, receipt, installRuns, replayWindow>>

\* installLease's origin rule for a row that already holds a lease.
Admits(p) ==
  \/ epoch = 0
  \/ p.epoch > epoch
  \/ /\ p.epoch = epoch
     /\ p.node = authority
     /\ (RegressCheck => p.window >= window)

Apply(p) ==
  /\ epoch' = p.epoch /\ window' = p.window /\ authority' = p.node /\ revoked' = FALSE
  /\ accepted' = accepted \cup {<<p.epoch, p.window>>}

\* account.lease.install (or an install item of account.lease.batch) with any payload minted so far.
InstallPayload(p) ==
  /\ p \in payloads
  /\ IF Admits(p) THEN Apply(p) ELSE UNCHANGED <<epoch, window, authority, revoked, accepted>>
  /\ UNCHANGED <<ownerEpoch, payloads, keyState, receipt, installRuns, replayWindow>>

\* account.lease.remove (or a release item): the row stays, its lease is revoked.
Release ==
  /\ epoch > 0 /\ ~revoked
  /\ revoked' = TRUE
  /\ UNCHANGED <<ownerEpoch, payloads, epoch, window, authority, accepted, keyState, receipt, installRuns, replayWindow>>

\* account.lease.batch under the one key, first time: [grant w, install Payload(1,1)].
BatchFirstWindow(w) ==
  /\ keyState = "none"
  /\ Payload(1, 1) \in payloads
  /\ keyState' = "recorded"
  /\ installRuns' = installRuns + 1
  /\ IF Admits(Payload(1, 1))
       THEN Apply(Payload(1, 1)) /\ receipt' = [grantWindow |-> w, installOk |-> TRUE]
       ELSE UNCHANGED <<epoch, window, authority, revoked, accepted>> /\ receipt' = [grantWindow |-> w, installOk |-> FALSE]
  /\ payloads' = payloads \cup {Payload(ownerEpoch, w)}
  /\ UNCHANGED <<ownerEpoch, replayWindow>>

\* The same key again: the receipt answers; a grant item is minted again under its recorded window.
BatchReplayWindow(w) ==
  /\ keyState = "recorded"
  /\ IF ReplayReusesReceipt
       THEN /\ replayWindow' = receipt.grantWindow
            /\ UNCHANGED <<epoch, window, authority, revoked, accepted, installRuns, payloads>>
       ELSE /\ replayWindow' = w
            /\ installRuns' = installRuns + 1
            /\ payloads' = payloads \cup {Payload(ownerEpoch, w)}
            /\ IF Admits(Payload(1, 1)) THEN Apply(Payload(1, 1)) ELSE UNCHANGED <<epoch, window, authority, revoked, accepted>>
  /\ UNCHANGED <<ownerEpoch, keyState, receipt>>

Grant == \E w \in Windows : GrantWindow(w)
Install == \E p \in payloads : InstallPayload(p)
BatchFirst == \E w \in Windows : BatchFirstWindow(w)
BatchReplay == \E w \in Windows : BatchReplayWindow(w)

Next == Grant \/ TakeOver \/ Install \/ Release \/ BatchFirst \/ BatchReplay

Spec == Init /\ [][Next]_vars

\* Rules the reader agrees to.
WindowNeverShrinks == epoch > 0 => window = Max({w \in Windows : <<epoch, w>> \in accepted})
EpochNeverFalls == \A a \in accepted : a[1] <= epoch
AuthorityMatchesEpoch == epoch > 0 => authority = OwnerOf(epoch)
ReplayIsQuiet == installRuns <= 1 /\ (replayWindow = 0 \/ replayWindow = receipt.grantWindow)
TypeOK == epoch \in 0..MaxEpoch /\ window \in 0..W /\ ownerEpoch \in Epochs
=============================================================================
