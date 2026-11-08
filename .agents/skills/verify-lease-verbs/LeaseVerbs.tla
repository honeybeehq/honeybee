---------------------------- MODULE LeaseVerbs ----------------------------
(* One account share, one leased row on one satellite, one bulk key.      *)
(* Owner side: v2/daemon/src/daemon.ts mintLeaseGrant (account.lease.grant) *)
(* Satellite side: v2/daemon/src/accountsService.ts installLease (the      *)
(*   "Lease origin conflicts with the installed lease" rule) and removeLease *)
(* Bulk key: v2/daemon/src/daemon.ts rpcAccountLeaseBatch                  *)
(* Enrolled row: installLease's enrolment re-proof gate (a plain payload     *)
(*   from the row's own share and authority republishes an enrolled row     *)
(*   whose last publication was left unknown, without a local primary)      *)
EXTENDS Naturals, FiniteSets

CONSTANTS W,                   \* lease windows are 1..W (larger = later expiresAt)
          MaxEpoch,            \* share epochs are 1..MaxEpoch; +1 on take-over
          RegressCheck,        \* TRUE = installLease refuses a shorter window at the same epoch
          ReplayReusesReceipt, \* TRUE = a replayed batch key answers from its receipt
          OwnerSignsAuthority, \* TRUE = account.lease.grant stamps its own node as authorityNodeId (M2)
          ReplayChecksItems,   \* TRUE = a replayed key must carry the recorded items digest (M1)
          AuditReplay,         \* TRUE = every re-mint on replay writes account.lease.granted replay:true (M1)
          SupersedeEnrolled,   \* TRUE = a payload from the row's own authority republishes an enrolled row whose publication is unknown (FALSE = 9d95df22: refused unknown_material)
          ForeignSupersedes    \* TRUE (broken) = an enrolled row also takes a same-epoch payload from another node

Windows == 1..W
Epochs == 1..MaxEpoch
OwnerOf(e) == IF e % 2 = 1 THEN "A" ELSE "C"   \* A owns odd epochs, C owns even ones (take-over)

VARIABLES ownerEpoch,   \* the share's authority epoch on the owner's account row (accounts.share_epoch, H6)
          payloads,     \* install payloads minted so far: Apiary may deliver any of them, late or twice
          epoch,        \* satellite row: 0 = no row yet, else the installed epoch
          window,       \* satellite row: the installed lease window (expiresAt)
          authority,    \* satellite row: authorityNodeId of the installed lease
          revoked,      \* satellite row: lease.remove ran (disposition revoked)
          enrolled,     \* satellite row: carries an enrolment receipt (installed with enrol: true under the old scheme)
          published,    \* satellite row: the enrolled material's last publication completed (leasedFrom.materialPublished)
          ownerRefused, \* history: the row's own authority sent a payload the ordering rule admits and the row refused it
          accepted,     \* history of every install the satellite accepted
          keyState,     \* the one bulk key: "none" | "recorded"
          receipt,      \* what the key recorded: the grant window and whether the install item was accepted
          installRuns,  \* how many times the key's install item really executed
          replayWindow, \* the grant window the last replay answered (0 = no replay yet)
          replayAsked,  \* the grant window the last replay call asked for (0 = no replay yet)
          mints,        \* how many times material was minted on the owner
          audits        \* how many account.lease.granted audit rows the owner wrote

vars == <<ownerEpoch, payloads, epoch, window, authority, revoked, enrolled, published, ownerRefused, accepted, keyState, receipt, installRuns, replayWindow, replayAsked, mints, audits>>

Payload(e, w) == [epoch |-> e, window |-> w, node |-> OwnerOf(e)]
ForgedPayload(e, w) == [epoch |-> e, window |-> w, node |-> OwnerOf(e + 1)]   \* a caller-chosen authorityNodeId
ForeignPayload(w) == [epoch |-> epoch, window |-> w, node |-> OwnerOf(epoch + 1)]  \* another node's material at the row's epoch
Max(S) == CHOOSE m \in S : \A x \in S : x <= m

Init ==
  /\ ownerEpoch = 1
  /\ payloads = {}
  /\ epoch = 0 /\ window = 0 /\ authority = "none" /\ revoked = FALSE
  /\ enrolled = FALSE /\ published = FALSE /\ ownerRefused = FALSE
  /\ accepted = {}
  /\ keyState = "none"
  /\ receipt = [grantWindow |-> 0, installOk |-> FALSE]
  /\ installRuns = 0
  /\ replayWindow = 0 /\ replayAsked = 0
  /\ mints = 0 /\ audits = 0

\* account.lease.grant on the owner: mint for the row's share epoch (deriveShareFacts) with a chosen window.
\* The owner stamps its own node id; with OwnerSignsAuthority off, the caller's authorityNodeId is copied in.
GrantWindow(w) ==
  /\ payloads' = payloads \cup {Payload(ownerEpoch, w)} \cup (IF OwnerSignsAuthority THEN {} ELSE {ForgedPayload(ownerEpoch, w)})
  /\ mints' = mints + 1 /\ audits' = audits + 1
  /\ UNCHANGED <<ownerEpoch, epoch, window, authority, revoked, enrolled, published, ownerRefused, accepted, keyState, receipt, installRuns, replayWindow, replayAsked>>

\* Another node (not the row's authority) hands the satellite material stamped with the row's share and epoch.
ForeignGrantWindow(w) ==
  /\ epoch > 0
  /\ payloads' = payloads \cup {ForeignPayload(w)}
  /\ UNCHANGED <<ownerEpoch, epoch, window, authority, revoked, enrolled, published, ownerRefused, accepted, keyState, receipt, installRuns, replayWindow, replayAsked, mints, audits>>

\* The old scheme: the satellite's own access-only login is enrolled in place under the owner's share and
\* epoch (account.lease.install with enrol: true); the row keeps an enrolment receipt.
Enrol ==
  /\ epoch = 0
  /\ epoch' = ownerEpoch /\ window' = 1 /\ authority' = OwnerOf(ownerEpoch) /\ revoked' = FALSE /\ enrolled' = TRUE /\ published' = TRUE
  /\ accepted' = accepted \cup {<<ownerEpoch, 1>>}
  /\ UNCHANGED <<ownerEpoch, payloads, ownerRefused, keyState, receipt, installRuns, replayWindow, replayAsked, mints, audits>>

\* A republish of the enrolled material whose outcome was lost (installLease wrote materialPublished: false and
\* never reached its final write: a crash, or a Keychain publish that failed); the row stays enrolled.
PublishLost ==
  /\ enrolled /\ published
  /\ published' = FALSE
  /\ UNCHANGED <<ownerEpoch, payloads, epoch, window, authority, revoked, enrolled, ownerRefused, accepted, keyState, receipt, installRuns, replayWindow, replayAsked, mints, audits>>

\* A take-over through the credential handoff plane: the new owner's row adopts at epoch + 1
\* (credentialHandoff.ts export derives it from the row; store.putCredentialAuthorityEpoch raises share_epoch).
TakeOver ==
  /\ ownerEpoch < MaxEpoch
  /\ ownerEpoch' = ownerEpoch + 1
  /\ UNCHANGED <<payloads, epoch, window, authority, revoked, enrolled, published, ownerRefused, accepted, keyState, receipt, installRuns, replayWindow, replayAsked, mints, audits>>

\* installLease's origin rule for a row that already holds a lease.
Admits(p) ==
  \/ epoch = 0
  \/ p.epoch > epoch
  \/ /\ p.epoch = epoch
     /\ p.node = authority
     /\ (RegressCheck => p.window >= window)

\* An enrolled row whose publication is unknown re-proves its local material before installing (installLease's
\* enrolment gate). The swept material of a revoked row proves nothing, so in 9d95df22 (SupersedeEnrolled off)
\* every payload is refused unknown_material; now the row's own authority republishes without a local primary,
\* and every other refusal of the gate (native, refresh chain, busy, locked Keychain) stays.
Admitted(p) ==
  IF enrolled
    THEN \/ Admits(p) /\ (published \/ SupersedeEnrolled /\ p.node = authority)
         \/ ForeignSupersedes /\ p.epoch = epoch /\ (RegressCheck => p.window >= window)
    ELSE Admits(p)

Apply(p) ==
  /\ epoch' = p.epoch /\ window' = p.window /\ authority' = p.node /\ revoked' = FALSE
  /\ published' = enrolled
  /\ accepted' = accepted \cup {<<p.epoch, p.window>>}
  /\ UNCHANGED enrolled

Refuse(p) ==
  /\ UNCHANGED <<epoch, window, authority, revoked, enrolled, published, accepted>>
  /\ ownerRefused' = ownerRefused \/ (Admits(p) /\ p.node = authority)

\* account.lease.install (or an install item of account.lease.batch) with any payload minted so far.
InstallPayload(p) ==
  /\ p \in payloads
  /\ IF Admitted(p) THEN Apply(p) /\ UNCHANGED ownerRefused ELSE Refuse(p)
  /\ UNCHANGED <<ownerEpoch, payloads, keyState, receipt, installRuns, replayWindow, replayAsked, mints, audits>>

\* account.lease.remove (or a release item): the row stays, its lease is revoked; an enrolled row stays enrolled.
Release ==
  /\ epoch > 0 /\ ~revoked
  /\ revoked' = TRUE
  /\ UNCHANGED <<ownerEpoch, payloads, epoch, window, authority, enrolled, published, ownerRefused, accepted, keyState, receipt, installRuns, replayWindow, replayAsked, mints, audits>>

\* account.lease.batch under the one key, first time: [grant w, install Payload(1,1)].
BatchFirstWindow(w) ==
  /\ keyState = "none"
  /\ Payload(1, 1) \in payloads
  /\ keyState' = "recorded"
  /\ installRuns' = installRuns + 1
  /\ IF Admitted(Payload(1, 1))
       THEN Apply(Payload(1, 1)) /\ UNCHANGED ownerRefused /\ receipt' = [grantWindow |-> w, installOk |-> TRUE]
       ELSE Refuse(Payload(1, 1)) /\ receipt' = [grantWindow |-> w, installOk |-> FALSE]
  /\ payloads' = payloads \cup {Payload(ownerEpoch, w)}
  /\ mints' = mints + 1 /\ audits' = audits + 1
  /\ UNCHANGED <<ownerEpoch, replayWindow, replayAsked>>

\* The same key again, asking for grant window w: with the recorded items (w = receipt.grantWindow) the
\* receipt answers and the grant is minted again under its recorded window; other items are refused
\* idempotency_conflict (ReplayChecksItems) or, broken, answered from the old receipt.
BatchReplayWindow(w) ==
  /\ keyState = "recorded"
  /\ IF ReplayChecksItems /\ w /= receipt.grantWindow
       THEN UNCHANGED <<epoch, window, authority, revoked, enrolled, published, ownerRefused, accepted, installRuns, payloads, replayWindow, replayAsked, mints, audits>>
       ELSE IF ReplayReusesReceipt
       THEN /\ replayAsked' = w
            /\ replayWindow' = receipt.grantWindow
            /\ mints' = mints + 1 /\ audits' = IF AuditReplay THEN audits + 1 ELSE audits
            /\ UNCHANGED <<epoch, window, authority, revoked, enrolled, published, ownerRefused, accepted, installRuns, payloads>>
       ELSE /\ replayAsked' = w
            /\ replayWindow' = w
            /\ installRuns' = installRuns + 1
            /\ mints' = mints + 1 /\ audits' = audits + 1
            /\ payloads' = payloads \cup {Payload(ownerEpoch, w)}
            /\ IF Admitted(Payload(1, 1)) THEN Apply(Payload(1, 1)) /\ UNCHANGED ownerRefused ELSE Refuse(Payload(1, 1))
  /\ UNCHANGED <<ownerEpoch, keyState, receipt>>

Grant == \E w \in Windows : GrantWindow(w)
ForeignGrant == \E w \in Windows : ForeignGrantWindow(w)
Install == \E p \in payloads : InstallPayload(p)
BatchFirst == \E w \in Windows : BatchFirstWindow(w)
BatchReplay == \E w \in Windows : BatchReplayWindow(w)

Next == Grant \/ ForeignGrant \/ Enrol \/ PublishLost \/ TakeOver \/ Install \/ Release \/ BatchFirst \/ BatchReplay

Spec == Init /\ [][Next]_vars

\* Rules the reader agrees to.
WindowNeverShrinks == epoch > 0 => window = Max({w \in Windows : <<epoch, w>> \in accepted})
EpochNeverFalls == \A a \in accepted : a[1] <= epoch
AuthorityMatchesEpoch == epoch > 0 => authority = OwnerOf(epoch)
ReplayIsQuiet == installRuns <= 1 /\ (replayWindow = 0 \/ replayWindow = receipt.grantWindow)
ReplayAnswersOwnItems == replayWindow = 0 \/ replayAsked = receipt.grantWindow
EveryMintAudited == audits = mints
OwnerRenews == ~ownerRefused
TypeOK == epoch \in 0..MaxEpoch /\ window \in 0..W /\ ownerEpoch \in Epochs /\ enrolled \in BOOLEAN /\ published \in BOOLEAN
\* Mint and audit counters only grow; bound them so TLC explores a finite space (three mints suffice for every rule).
Bounded == mints <= 3
=============================================================================
