# C4 owner source restoration

Base: `6ed40d71967a24a7791400e41e0ffc83f1dc456a`.
Queen early-reviewed implementation: `7167ea3dbfd94a865de6dcb0b615320c6e7212c5`.
Final production: `6a9c83de2a72b7dc368be342dd64e4527f5eab8c`.

Run `bash .proof/C4/run.sh`. The wrapper creates a private fake HOME and two independent real Honeybee daemon processes. Synthetic Claude credentials and a loopback usage stub exercise a provider reset, owner admission, foreign-owner claim consumption, exact native continuation and deduplicated acquire/apply. Four negative claims are released; one source recovery is confirmed. No real provider or account credentials are used.

The RPC lab deliberately drives the owner saga RPC sequence itself. It does not run apiaryd. G owns the separate combined-tree Apiary integration and its receipts.

Run `bash .proof/C/verify.sh` for existing typechecks/build and accounts-rpc/loops/runner-host suites. Allocation and checkpoint suites are recorded alongside them. No new unit tests were added, as instructed.

The optional claim witness comes from the owner reservation receipt only after source admission was allowed. Execution additionally requires its own valid waiting provider-limit obligation and matching source generation, observation, window and reset. Proactive/null quota and ordinary source swaps remain refused. Correctly targeted source refusals use the existing fence/release signal. A wrong-target or stale-epoch claim is refused without poisoning that claim.

`receipts/additions-after-7167.json` records each pre-evidence followup patch ID. The final proof/report also lists evidence-only commits and their patch IDs. DEPLOY HOLD remains.
