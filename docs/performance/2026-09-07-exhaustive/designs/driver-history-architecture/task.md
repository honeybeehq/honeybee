# Design H10 unit 1: built-in daemon HSR/Cell delivery-history retention

Produce a design package only. No production edits, tests, new captures, processes, Mini, or benchmark changes. Use your assigned subdirectory under /tmp/honeybee-driver-history-architecture. Do not read or coordinate with the other candidate. Existing frozen autoTitle worktrees and rulers remain untouched.

Read the architect skill and its references/runner-prompt.md and rationale-template.md. The parent owns orchestration; do not recursively spawn an arena. Write caller usage FIRST, then signatures.ts with not-implemented bodies/pseudocode, then design.md with rationale/module map/alternatives/risks. One bounded page of rationale plus the sketches is enough.

Grounding, complete and frozen:
- /tmp/honeybee-driver-delivery-history-study.md (independent source/ownership/anti-tautology inventory at501710c1).
- /tmp/honeybee-driver-history-heap-study.md (independent real stopped/released snapshot analysis, including classification/smi addendum).
- /tmp/honeybee-driver-delivery-history-parent-plan.md (parent provisional option, NOT a selected architecture).
- Source baseline501710c1; current mainc6cf01f2 has identical runtime bytes.
- Real public HSR deliveries through an owned detached host verified0/1k/10k/100k exact ids/generations/body/order/receipt; after stop100k history remains. A source-verified Map backing table is3,670,056 shallow bytes. These are Studio structural observations, not a candidate win or canonical whole-process attribution.

Goal of this FIRST unit: built-in daemon direct HSR and Cell-inner-HSR retain no historical accepted-delivery records. PendingDeliveries, confirmedDeliveries, pendingWrites, observations/cursors, Core mailbox truth, and delivery outcomes must remain unchanged. Tmux and SimDriver are OUTSIDE the production diff for this unit. Explain how the design could extend to Tmux later without implementing it or claiming its end-to-end metrics.

Compatibility is a hard constraint. Omitted-option existing HsrDriver/CellDriver callers must retain current public consumedGeneration/consumedCount semantics, including overwrite and lifetime behavior. Root/RPC/CLI/RuntimeDriver/ExtendedDriver contracts stay unchanged. No new operator-facing configuration is needed. Cell already forwards HsrDriverConfig through cfg.hsr and the daemon shares hsrConfig between direct HSR and Cell.

Compare at least TWO structurally distinct whole designs in the package, with a real caller/type sketch for each: e.g. compatibility-default retention policy versus a test-owned/compatibility-driver architecture. Choose the strongest as your recommendation. Do not merely compare boolean spellings. The alternative may lose on compatibility or surface cost; state the concrete reason. The parent requires actual consideration of ownership, not automatic agreement with its provisional policy.

If you choose explicit opt-out, resolve the disabled-query contract. Returning0/undefined can masquerade as valid ground truth; throwing both queries is a viable new-mode contract without changing default callers. Do not add a status API without a concrete need. A generic wrapper recording returned accepted:true is INVALID: it makes I1 tautological and changes pre-return/throw ordering. Test evidence must still originate at the existing internal acceptance sites. A callback/sink/hook design must address new exceptions and synchronous reentry rather than assuming a no-throw comment is enforcement.

Describe precise real-store/real-host tests that prove default behavior, direct and confirmed acknowledgement acceptance, duplicate/refused/wrong-generation/stop/revive cases, Cell forwarding, and ACTUAL daemon construction. HoneybeeDaemon.driver is a private class property; SubstrateRouter has public readonly hsr/cell/tmux fields, so test-side Reflect plus instanceof can inspect existing objects without a production diagnostic API. An isolated disabled driver test alone does not prove daemon wiring or absent allocation.

Parent owns measurement and broad verification. Outline requirements only. The post-candidate ruler must prove exact wire/outcome parity, same-source A/A, ABBA at0/10k/100k, default-on compatibility control, separate numeric and snapshot modes, and source-verified no-history allocation. Do not invent gains. Scope every memory statement; genuinely live protocol queues remain separate.

Hand off paths and a concise recommendation. Hashes only from completed output, or omit. No production authorization is implied by this design task.
