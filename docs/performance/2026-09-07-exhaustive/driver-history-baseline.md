# Historical driver delivery records

The real HSR driver retains all accepted-message history after its runtime stops. Four provider-free Studio probes completed at 0, 1,000, 10,000, and 100,000 accepted messages. Each used a real detached runner host and a stub that verified every message id, order, body, and final count. Every public recorded-generation lookup passed, and the recorded count remained unchanged after stop. Production code is unchanged for this study.

The historical `consumed` Map is distinct from protocol `pendingDeliveries` and `confirmedDeliveries`. Those sets control acknowledgements and retries. Initial source search places all consumers of historical ground truth in invariant/test harnesses. The completed [independent ownership study](designs/driver-history/ownership-study.md) confirms no production decision reads them. Public concrete-driver query methods still require compatibility.

| Delivered ids | Recorded ids after stop | Stopped heapUsed bytes | Released heapUsed bytes |
|---|---:|---:|---:|
| 0 | 0 | 10,003,056 | 10,002,584 |
| 1,000 | 1,000 | 10,131,656 | 10,099,784 |
| 10,000 | 10,000 | 10,579,376 | 10,116,880 |
| 100,000 | 100,000 | 13,844,528 | 10,169,528 |

The entry counts are exact structural evidence. Memory values are whole-process managed occupancy after best-effort GC in separate processes on a contended workstation. They suggest a retention target but do not establish exact Map bytes or an A/B performance gain. The fixed protocol runs three collections with a timer turn after each, then another timer turn before memoryUsage. No delivery CPU claim is made.

The [100,000-id report](evidence/honeybee-driver-history-probe-100000.json) records source revision/hashes, tool hash, host identity, all raw memory phases, and the verified receipt. [The probe](tools/honeybee-driver-history-probe.mjs) uses public driver operations and removes only its own fixture after host exit. It does not start providers, use live daemon state, or inject a private process map. It is a structural probe, not a complete A/B ruler.

The [separate snapshot-mode report](evidence/honeybee-driver-history-snapshot-100000.json) labels every memory reading diagnostic-only. Snapshot collection materially changes later heap occupancy, so those numeric phases must not be compared with the table above. [Compressed snapshots](evidence/driver-history-snapshot-archive.json) preserve stopped and released structures for independent inspection. Numeric Map keys and values commonly appear as smis without heap edges; counting table edges as entries would be invalid.

The [selected design](designs/driver-history-architecture/synthesis.md) preserves existing driver defaults and explicitly disables historical recording in the daemon's built-in HSR drivers. The shared HSR configuration already reaches Cell's inner driver. Implementation is authorized in an isolated worktree, but no production candidate is accepted yet. Default API behavior, acknowledgement sets, and driver outcomes must remain exact.

Ownership, heap analysis, architecture comparison and the first exact-source Mini control are complete. Implementation, broad serial verification and candidate comparisons remain. This study advances H10 and the corresponding tmux retention question. It does not close either item.


## Independent heap finding

The [source-aligned heap analysis](designs/driver-history/heap-study.md) finds exactly one stopped HsrDriver, one consumed Map, and its backing array with 3,670,056 shallow bytes. The backing array exposes one internal edge and zero element edges despite the externally proven 100,000 entries. On release, neither the driver nor its consumed Map remains. This directly measures that table node, not a dominator total or whole-process savings.

The [revised analyzer](tools/honeybee-driver-history-heap-analyze.py) checks each consumed target's type and name before classifying it as map, not_map or missing. The original remains as v1. Synthetic Map, null, plain-object, missing-property and released controls pass. A parent metadata-mutation control proves that a missing table edge produces a JSON anomaly report before exit 1. Source alignment remains required for each candidate. Numeric values without heap edges are a property of this small-integer fixture, not all numeric ids. Parent interpretation does not rely on the optional backing-layout arithmetic.


## Ownership and first-unit scope

The independent study confirms that these maps are per-driver-lifetime accepted-delivery recorders, not complete event histories or durable audit. Repeated ids overwrite generation without increasing count. A new driver has no old history. No Core/RPC/CLI/RuntimeDriver/ExtendedDriver path consumes it. Default concrete classes remain source-public, so their historical query behavior must stay compatible.

A generic wrapper recording returned `accepted:true` is rejected because it would trust the same outcome as Core and weaken the invariant test. Existing internal record sites remain the evidence origin. Tmux has a deliberate echo-mismatch assume-best accepted path without Enter, so its recorder must not be described as universal model consumption. The first design unit covers HSR and Cell only; Tmux needs its own semantic and measurement unit. Both independent designs and the cross-judge select a default-on construction policy with a null history field when explicitly disabled. Both disabled queries throw instead of presenting missing evidence as an empty history.

## Mini A/A control

The reviewed v4 ruler completed 12 independent serial children on two distinct, runtime-identical checkouts at 8e57e746. Each count ran in A-B-B-A order. All input frames, transcript bytes, observation bytes, outcomes, session evidence and recovery cursors matched exact oracles. Both protocol sets, write queues, partial output and socket write buffers were empty at the delivered reading. Every owned-fixture receipt ends in fixture_removed.

| Delivered ids | Stopped heapUsed, side A bytes | Stopped heapUsed, side B bytes | Released heapUsed, all four runs bytes |
| --- | --- | --- | --- |
| 0 | 9,928,680 / 9,926,744 | 9,928,728 / 9,928,656 | 9,925,952–9,927,944 |
| 10,000 | 10,558,616 / 10,564,216 | 10,557,680 / 10,557,816 | 10,095,320–10,101,848 |
| 100,000 | 13,774,144 / 13,773,272 | 13,774,064 / 13,772,736 | 10,099,088–10,100,488 |

These are whole driver-process managed-heap readings after best-effort collection. They exclude the separate host and agent and do not attribute exact Map bytes. RSS and all other raw phases remain in the [canonical control report](evidence/h10-mini/mini-h10-aa-canonical-v4.json). There are two independent observations per side per count, so the table describes variation rather than an estimated population distribution. No candidate win, CPU gain or Tmux result is claimed.

The initial Mini v3 smoke failed before completing a child because the zero-message fixture observed boot before the socket connection. Its report and cleanup receipt are retained. V4 explicitly waits for boot and connection before its booted reading, then requires the same zero queues before delivery-state sampling. The failure changed the ruler, not production. The [review and append-only corrections](designs/driver-history-architecture/ruler-review.md) and [authoring attempts](designs/driver-history-architecture/ruler-attempts.md) record the sequence. Any zero-count run could encounter the earlier race; the observed failure was count 0, run 0.
