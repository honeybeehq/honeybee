# Mail wakes delivery

The native fixture measures one generated stub bee on each of two disposable owners (metal-2 and metal-3), 30 sends per arm and five 2-second idle windows. A remote collector drives the existing Unix RPC through a source-IP/verb/stub-restricted tailnet relay. It is not the Apiary mirror or a provider benchmark.

Build native artifacts with npm run build first. Launch every lab process with env -i, a fake HOME, HIVE_NO_KEYCHAIN=1, HIVE_GATEWAYS_DISABLE=1 and HIVE_NODE_PATH set to node. Save shell $! for owned processes. The peer runner has owner and collector modes listed in the JSON recipe. The local single-process precursor remains scripts/perf/mail-wake.mjs; its two-line treatment is a separate series. Burst attribution is scripts/perf/mail-wake-burst.mjs; the runtime tick wrapper never edits daemon source.

Raw values and source identities stay uncommitted under .proof/mail-wake/native-and-burst.json and are attached to the proof. Loaded-host recipe proof only: no idle-host baseline or latency budget. Median averages the middle pair; p95 uses nearest rank. Under the final source, owner-clock durable delivery median/p95 was 115.5/199→7/9 ms on metal-3 and 106/196→7/13 ms on metal-2. Both arms used the same built runner/native helpers and TypeScript source mode. These loaded shared-host observations prove the recipe and scheduling mechanism, not production latency.

Watch p95 was 47–49 ms after the change; a second roughly 40 ms mode may come from relay TCP buffering (setNoDelay is absent). That attribution is unverified. Do not subtract owner and collector timestamps.

Idle tick callbacks were identical, 9 or 10 per 2 seconds. No new idle timer or wake path exists: only committed sends/answers/dismissals request an early tick. CPU variance was inconclusive; context switches are not exact wakeups.

Active cost remains: on 9733 stopped bees plus one inbox, 100 back-to-back sends caused 2→50 ticks and 100 paced sends 7→100 ticks. CPU scales with send rate; running-fleet tick cost is unmeasured. The single-flight wake prevents trailing-debounce starvation; it does not solve burst amplification. Dirty/due scheduler work has a separate owner. Tick-internal mail retains the existing loop order and can wait one cadence (200 ms default).
