# Independent parent comparison

Both final packages were read end to end. Both recommend the same construction policy and preserve the same two acceptance sites. No production selection is final until the cross-judge report is read.

| Rubric criterion | Fable | Sol | Reason |
| --- | ---: | ---: | --- |
| Default compatibility and honest disabled queries | 4 | 4 | Both preserve omitted-option recording, overwrite and lifetime behavior, and throw when explicitly disabled. |
| Actual daemon HSR and Cell wiring | 4 | 4 | Both use the existing shared configuration and require an actual daemon construction test. |
| Interface and ownership cost | 4 | 3 | Fable needs only inline guards. Sol adds a two-caller requiredDeliveryHistory helper and a daemon type annotation that do not strengthen the required opt-out. Neither is a blocker. |
| Real regression and measurement proof | 4 | 4 | Both distinguish live protocol queues and historic evidence. Sol makes real CoreStore/DaemonCore parity and explicit-true coverage clearer; Fable explicitly retains a default direct-driver control and unchanged Tmux assertion in the daemon test. |
| Distinct alternatives and verifiable scope | 3 | 4 | Fable fully sketches an external sink that fails the hard compatibility constraint. Sol also provides a closed class split that preserves defaults, at the cost of additional HSR/Cell classes and router types. |

The scores tie at 19/20. The provisional base is Fable's smaller implementation shape, with the consensus policy and Sol's stronger closed alternative and explicit-true/Core proof obligations. This is a bounded daemon opt-out. It is not a removal of all history from source-level driver constructions.

Parent resolutions to take into synthesis:

- Use Map<number, number> | null as the only retention state. Omission and true record; exactly false disables.
- Guard the existing writes in place. Either optional chaining or explicit null guards is acceptable if effect order stays unchanged. Do not add a recorder wrapper or a second flag.
- Use inline null checks in the two query methods, with Error("delivery history recording is disabled for this driver"). No exported error class or diagnostic method.
- Add one false field to the existing shared daemon HSR configuration. An optional satisfies annotation cannot enforce that future callers supply false, so the actual-construction test is the enforcement mechanism.
- Keep Cell production, Tmux, SimDriver, Core contracts, RPC and CLI outside the production diff. A Core-backed behavior test may use existing APIs.
- Reject the external sink for default compatibility and arbitrary callback effects. Reject the closed runtime/compatibility class split for extra classes, Cell paths and router types without a better daemon result. Preserve both alternatives in the decision record.
- Bare query errors are new only for explicitly disabled constructions. Existing omitted-option callers must retain their observable behavior.

Citation correction for synthesis, without editing frozen packages: Fable's sketch introduction says four acceptance-site writes while unit 1 changes only the two HSR writes; four includes the deferred Tmux sites. The actual daemon class is HiveDaemon at daemon.ts:442, as Sol correctly names it. The task and earlier parent notes called it HoneybeeDaemon; that was a parent naming error, not a source finding. No extra compile-time test is needed solely to mirror the unchanged RuntimeDriver interface.
