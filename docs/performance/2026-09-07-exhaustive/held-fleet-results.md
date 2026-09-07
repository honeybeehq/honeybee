# Skip move lookups for mail held by urgency

Accepted commit `4ebf43c9` moves the existing active-move lookup after the existing eligibility filter. It still reads current move state before any interrupt or delivery of eligible mail. Every message can be ineligible during a real running turn, so a fleet of N Bees with held idle mail previously issued N joins without being able to deliver anything.

The change does not cache move state, change urgency, skip move reconciliation, alter scale-to-zero fences, or move the post-delivery placement check. Pending metadata and I1 work remain unchanged. The test counts real activeMoveOf calls while preserving the original method, first failing with five unnecessary calls, then passing with zero during the held turn and one when the turn ends and delivery becomes eligible.

## Paired measurements

The frozen [v2 ruler](designs/held-fleet-v2.mjs) compares immutable `476559e5` and `4ebf43c9`. Exactly loops.ts differs among runtime/package/helper sources. A/A uses two distinct identical 476 checkouts. Each case has byte-identical database copies, real CoreStore/DaemonCore, FakeDriver, three symmetric warmup rounds, and 15 ABBA rounds for 30 samples per side. The uninstrumented timed operation is one complete core.step. SQL attribution runs in a separate later step and includes cached statements. Complete state digests, audit sequence, pending counts, callbacks, and all driver effects are checked.

| Bees, one held idle message each | I1 | A/A CPU p50, ms | Before / after CPU p50, ms |
| ---: | --- | ---: | ---: |
| 1 | off | 0.02 / 0.02 | 0.021 / 0.02 |
| 1 | on | 0.024 / 0.024 | 0.024 / 0.023 |
| 1,000 | off | 2.616 / 2.591 | 2.606 / 1.77 |
| 1,000 | on | 3.328 / 3.151 | 3.112 / 2.42 |
| 10,000 | off | 27.975 / 27.604 | 27.723 / 18.879 |
| 10,000 | on | 34.945 / 34.519 | 35.066 / 26.002 |

The 10,000-Bee reductions are 31.9% with I1 disabled and 25.8% with I1 enabled. The SQL diagnostic records 10,000 activeMoveOf joins before and zero afterward. The one-Bee difference is near measurement resolution and is not the headline. No real processes are spawned; these are whole-core-step results, not whole-daemon CPU or message-delivery latency.

## Opposing workload

An active stopping move can block delivery before urgency is checked in the baseline. Moving the lookup later adds filtering before that fence. The ruler therefore also admits a real Cell move through the public API, leaves its source runtime running and stop command unexecuted, and checks that all 10,000 messages remain pending with no effects or phase changes.

| Pending urgency, one blocked move | I1 | A/A CPU p50, ms | Before / after CPU p50, ms |
| --- | --- | ---: | ---: |
| idle | off | 5.198 / 5.253 | 5.255 / 5.362 |
| idle | on | 4.797 / 4.775 | 4.86 / 4.893 |
| next | off | 5.203 / 5.235 | 5.412 / 5.478 |
| next | on | 4.707 / 4.707 | 4.794 / 4.868 |

The opposing case adds about 0.03–0.11 ms of measured CPU, up to about 2%. This cost is retained rather than hidden in the fleet result. Removing the temporary eligibility array is a separate possible improvement; it is not part of this change.

## Verification

Mini passed repository build, all v2 typechecks, and all 68 loop tests with the exact production/test file hashes captured in `verification/mini-held-eligibility-source.json`. Existing move, mixed-urgency, synthetic-boot, interruption, and delivery-order tests remain intact. Studio passed typecheck and build; its loop run passed 67/68 with the previously observed budget.11 real-process boot timeout under heavy load. The exact failed log is retained. The same case passed in the complete Mini loop run.

Combined `4ebf43c9` passed core 213/213 and the serial daemon suite with 358 passes and one platform skip. The exact combined production source also passed all v2 typechecks, repository build, and the 68-test loop suite. Logs are `verification/mini-move-held-integrated-*.log` and `mini-held-eligibility-*.log`. The original v1 ruler/A/A and rejected dirty-source smoke logs are diagnostic history only; the v2 A/A and A/B results above use one frozen tool and committed source.
