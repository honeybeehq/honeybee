# Driver delivery-history retention: parent measurement and architecture notes

Status: report-first study. No production edits or acceptance. Grounded at 501710c1.

## Phase position

1. Ground: active. Source/configuration trace and provider-free real-host baselines completed; independent ownership/heap reviews pending.
2. Sketch: pending. Compare at least two structurally distinct design packages after grounding.
3. Agree: skip human checkpoint; none requested. Parent synthesis must resolve public compatibility before implementation.
4. Implement: pending. No production authoring is authorized for this candidate yet.
5. Scrap: conditional; return to grounding if the design needs repeated exceptions.

The corresponding arena phases are Frame, Fan out, Cross-judge, Pick, Graft, Verify. None has started; the current agents are grounding/inspection lanes rather than design candidates.

## Hypothesis

HsrDriver and TmuxDriver retain a historical Map<number,number> for every accepted message. The historical consumed Map has no deletion path in the inspected drivers. Cell delegates its ground-truth methods to its inner HSR. Initial repository search finds readers only in test/invariant harness code, not daemon execution. Independent ownership review is pending.

This is separate from per-process pendingDeliveries and confirmedDeliveries, which participate in real protocol acceptance. Those sets, write ordering, durable delivery, generations, and stop/retry behavior are outside any proposed optimization.

## Smallest provisional option

An optional driver-construction retention policy defaults to retaining history, preserving existing callers and public consumedGeneration/consumedCount behavior. The daemon explicitly omits historical recording for its built-in HSR, Cell-inner-HSR, and tmux instances. The daemon already builds a shared hsrConfig and passes it to both HSR and Cell. No RPC/config-file/operator option is needed. Cell's HsrDriverConfig-derived config already forwards the field.

This is provisional, not an implementation order. An absent Map plus a guarded record at the existing acceptance sites is likely enough. The disabled query-method behavior must be documented as recorder contents, not fabricated historical evidence. Default behavior remains byte-equivalent. The new option must not alter adapters, pending/confirmed acknowledgements, RuntimeDriver return values, or mailbox mutations.

Alternatives to review: move the recorder entirely to test injection, make recording opt-in globally with explicit compatibility cost, prune on runtime exit with loss of historical invariant evidence, or retain the current behavior. Pure test extraction may create broader API/test churn than this bounded production opt-out. Exit pruning does not bound long-lived busy runtimes and may invalidate cross-generation checks.

## Measurement plan before a candidate

1. Prove the actual driver-owned Map's growth and lifetime with public deliveries on a provider-free real host fixture. The stub accepts mid-turn input, emits one boot witness, drains input, and emits no per-message output. All messages must be accepted exactly once and the stub must confirm its exact received count outside measurement.
2. Use independent serial processes, byte-identical setup, fixed message counts such as 0/10k/100k, and a before-before control before comparing source roots. Do not size a million-message fixture until the smoke establishes its cost.
3. Record raw memoryUsage after a fixed GC/yield procedure at constructed, delivered-and-drained, stopped, and released phases. Numeric runs must exclude heap snapshots. Whole-process values alone do not establish exact recorder bytes.
4. Capture separate diagnostic snapshots and follow the source-verified consumed property to its Map and backing table. This Map has numeric ids/generations, so map entry values normally lack heap edges. Public recorded count, source/type proof, and backing-store shallow size are the evidence; a generic edge-count-as-Map-size claim would be wrong.
5. Measure delivery CPU separately only if fixture I/O and draining can be scoped honestly. A real host's transcript/socket work may dominate; no CPU win is required for a memory fix. Record parent-only versus descendant scope and bytes written. Storage is expected unchanged.
6. Candidate provenance must include the actual daemon configuration wiring. A ruler constructing a disabled driver alone cannot prove production opts out. Test the built-in daemon/router construction and Cell pass-through independently.

## Regression obligations

Default recorder history, overwrite semantics for repeated ids, refused writes, direct acceptance, acknowledgement-before-acceptance, wrong generation, stop/revive, and default consumedCount statistics remain exact. The disabled policy must preserve accepted/refused results, delivered wire content and count, observations, cursor state, and pending/confirmed behavior. A daemon configuration regression must fail if any built-in driver accidentally returns to historical recording. No live daemon or provider is used for these tests.

Author studies stay read-only until source ownership and API compatibility are resolved. Broad gates and captures remain parent-owned and serial on Mini. New source roots require their own A/A, A/B, and broad verification. Nothing from the accepted autoTitle captures can establish this candidate's effect.


## Completed structural probes

`/tmp/honeybee-driver-history-probe.mjs` drives the real HsrDriver, detached runner host, and a provider-free input-counting child. Four independent Studio processes delivered 0, 1,000, 10,000, and 100,000 sequential unique ids. All public delivery results, every recorded generation, and the child's full input order/body/count passed. Every stopped runtime still had the full historical count in its owning driver. The fixture was removed after host exit.

At 100,000 ids, post-GC whole-process managed occupancy was 13,844,528 bytes while stopped and 10,169,528 after driver release. This is a diagnostic signal, not an A/B result or exact Map attribution. At 10,000 ids the corresponding values were 10,579,376 and 10,116,880. The 0-id control values were 10,003,056 and 10,002,584. Host/socket/parser/code state can contribute to these phase differences.

The separate `/tmp/honeybee-driver-history-snapshot-probe.mjs` completed at 100,000 with all memory readings diagnosticOnly. Its stopped and released snapshots are ready for independent structural analysis. Snapshot-triggered collection changes the released memory figure; do not mix it with the none-mode run. No production change, canonical Mini capture, or performance-win claim has occurred.
