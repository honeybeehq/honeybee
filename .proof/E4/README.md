E4 relative proactive admission, Queen revision

Base main76d1560a; branch review/sar-E4-relative-proactive. No deploy; DEPLOY HOLD.

90% prompts comparison, not a hard cap. The revised rule scores each account by its tightest projected absolute remaining allowance and tightest allowance-per-hour rate over all applicable windows (weekly/Fable included). Source windows resetting within1h are individually excluded, so another long-lived protected window can still trigger. Compare configured capacityUnits, not provider-reported token balances: unlike plans need both configured values; identical known plans may use equal units.

The target must clear both scores by max(10%of the SMALLER plan, one additional projected completion-start cost), with a6h floor for reset horizons. The rate margin uses the longer binding horizon. This allows20x99.9%to1x0% when it has demonstrably more allowance, while20x90%stays if it has more remaining than1x50%. An independent accounts.proactiveDwellMs defaults30minutes, minimum30seconds. Returning to any historical recovery source requires2xmargin.

Source fresh and targets stale creates a proactive refresh obligation with admission.candidateAccountIds:null. Background IO refreshes all relevant accounts. It then publishes a sorted eligible-ID array, cancels when fresh comparisons prove no advantage, or cancels after one failed/inconclusive refresh and gives delivery a30sgrace. Idle polling does not create new episodes; a later new mail opening can retry. Stale targets alone never imply restored source headroom. Fresh unreadable targets are non-targets.

C2e restricts owner acquire and swap using candidateAccountIds intersected with authorization and leases. Proactive null OR omitted field waits; provider_limit ignores it. Executor checks actual current relative eligibility again and fences/releases bad claims. Committed confirmation and stable uncertain replay are preserved. C2e is the separate Apiary integration dependency.

Shadow uses existing local pending/active work counts, NOT durable reservation rows. The synchronous writer compares and selects, then performs transcript IO outside the new comparison transaction, then rebinds in its separate transaction with no async interleaving. Active reservations remain durable; own local unconfirmed owner claim is charged once. Cross-node shadow herding remains open.

Run lab.ts(16shadow),active.ts(4owner triggers),herd.ts(2five-bee),queen.ts(12Queen regressions),policy.ts(6pure controls), with env-i fakeHOME/private0700/var/tmp TMPDIR/Cell caches. All provider traffic is fake harnesses and loopback usage. Do not invoke helper cleanup. The30min control uses logical time, not30wallminutes.

Human7794 authorizes90%+continuation if no materially better alternative, with actual exhaustion handled by provider_limit. Both99%stay replaces former both-protected hold. Needle for Tormod7796: once E4 lands with Queen PASS, accounts.proactiveAdmission defaults ON in BOTH active and shadow mode. Explicitfalseoptsout. These are accepted decisions, not outstanding judgement.

Run check,v2:check,build and the existing scoped allocation/admission/accounts/config/accounts-RPC suites; these are not the full daemon suite. Repository verification skill remains missing (known setup issue); it did not run. No new unit tests or production comments.

Carried LOWs: protected-opening scans; short-sample velocity noise; shadow remote activity is unknown, local facts are lower bounds; refreshed failure may briefly hold mail for one background attempt; later new turns after30sgrace can add recovery rows, which are not pruned. No schema/capability/provider event change; proactive quota remains null with no fabricated continuation.
