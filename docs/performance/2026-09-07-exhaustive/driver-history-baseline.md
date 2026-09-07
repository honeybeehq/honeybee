# Historical driver delivery records

The real HSR driver retains all accepted-message history after its runtime stops. Four provider-free Studio probes completed at 0, 1,000, 10,000, and 100,000 accepted messages. Each used a real detached runner host and a stub that verified every message id, order, body, and final count. Every public recorded-generation lookup passed, and the recorded count remained unchanged after stop. Production code is unchanged for this study.

The historical `consumed` Map is distinct from protocol `pendingDeliveries` and `confirmedDeliveries`. Those sets control acknowledgements and retries. Initial source search places all consumers of historical ground truth in invariant/test harnesses. Independent ownership review is pending before deciding whether the daemon can omit those records.

| Delivered ids | Recorded ids after stop | Stopped heapUsed bytes | Released heapUsed bytes |
|---|---:|---:|---:|
| 0 | 0 | 10,003,056 | 10,002,584 |
| 1,000 | 1,000 | 10,131,656 | 10,099,784 |
| 10,000 | 10,000 | 10,579,376 | 10,116,880 |
| 100,000 | 100,000 | 13,844,528 | 10,169,528 |

The entry counts are exact structural evidence. Memory values are whole-process managed occupancy after best-effort GC in separate processes on a contended workstation. They suggest a retention target but do not establish exact Map bytes or an A/B performance gain. The fixed protocol runs three collections with a timer turn after each, then another timer turn before memoryUsage. No delivery CPU claim is made.

The [100,000-id report](evidence/honeybee-driver-history-probe-100000.json) records source revision/hashes, tool hash, host identity, all raw memory phases, and the verified receipt. [The probe](tools/honeybee-driver-history-probe.mjs) uses public driver operations and removes only its own fixture after host exit. It does not start providers, use live daemon state, or inject a private process map. It is a structural probe, not a complete A/B ruler.

The [separate snapshot-mode report](evidence/honeybee-driver-history-snapshot-100000.json) labels every memory reading diagnostic-only. Snapshot collection materially changes later heap occupancy, so those numeric phases must not be compared with the table above. [Compressed snapshots](evidence/driver-history-snapshot-archive.json) preserve stopped and released structures for independent inspection. Numeric Map keys and values commonly appear as smis without heap edges; counting table edges as entries would be invalid.

The [parent plan](designs/driver-history/parent-plan.md) proposes measurement and regression obligations. Its smallest provisional option preserves existing driver defaults while explicitly omitting historical recording in the daemon's built-in drivers. The shared HSR configuration already reaches Cell's inner driver. No retention policy or architecture is accepted yet. Default API behavior, true acknowledgement sets, and driver outcomes must remain exact.

Next gates are independent ownership/heap findings, architecture alternatives, an exact-source before/before control and candidate ruler, then implementation and broad serial verification. This study advances H10 and the corresponding tmux retention question. It does not close either item.
