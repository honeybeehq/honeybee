# H10 driver delivery-history ownership study

Status: read-only architecture and blast-radius study. This review made no source, benchmark, or test changes and started no provider, host, daemon, broad suite, or Mini workload.

Apiary remained unavailable as already reported for this session, so the inspection used native read-only Git commands.

Source under review: `501710c18515c4ac077a643c50daba2ce9043958`.

Parent hypothesis reviewed: `/tmp/honeybee-driver-delivery-history-parent-plan.md`, SHA-256 `376e8282c35bbe87f98f17c55f7a27e36f7ec3b596f3e6425c7e6fb88a27d217` (the version read after its completed-structural-probes update).

## Judgment

The `HsrDriver.consumed` and `TmuxDriver.consumed` maps are driver-instance-lifetime accepted-delivery recorders added for test/invariant checking. In the built-in daemon that normally means daemon-process lifetime. No production decision reads them. They are not part of `RuntimeDriver`, the daemon's duck-typed extended interface, `SubstrateRouter`, RPC, or CLI behavior. Cell has no second history: it delegates to its inner HSR driver.

The maps are nevertheless source-public indirectly: `HsrDriver`, `TmuxDriver`, and `CellDriver` are exported classes and their `consumedGeneration()` / `consumedCount()` methods are public class members. The root package does not export a v2 driver subpath, and the harness package is private, so this is not a supported root npm API. Out-of-repository relative/source imports cannot be ruled out. A default-on compatibility policy is therefore the least disruptive first slice.

The parent's default-on recorder plus explicit daemon-off policy is a viable bounded candidate for eliminating this retention in the shipped daemon. It is not selected or authorized. It has two wording/acceptance corrections:

1. Because omission means the compatibility default (`on`), the daemon must explicitly pass `false`; it cannot merely omit the option. The shared `hsrConfig` at `v2/daemon/src/daemon.ts:575-590` can disable both direct HSR and Cell's inner HSR without a Cell source change. Tmux needs its own explicit field at `:594-601`.
2. This removes deployed-daemon growth, not recorder ownership or retention from every production-class construction. Direct constructors, smokes, and future embeddings still retain by default. Call it a daemon opt-out, not complete production extraction.

Also replace “byte-equivalent” with “observably compatible by default.” The built artifact and hot acceptance path necessarily change, even if default return values and history remain equal.

Longer term, the clean ownership is an optional test-owned recorder invoked at the four existing writes—the current acceptance-proof/policy evidence origin—with no recorder in ordinary constructions. A generic outer wrapper that records every `{accepted:true}` is not equivalent ground truth: it mirrors the same outcome that causes Core to call `markDelivered`, so the checker becomes tautological and cannot catch a driver that lies about acceptance.

## What the maps actually record

| Driver | Writes | Meaning | Retention |
| --- | --- | --- | --- |
| HSR | `driver-hsr/src/driver.ts:587,614` | Latest generation for a distinct message ID after the driver reaches its acceptance policy. Confirming adapters record only when a prior confirmation is consumed on a later retry; non-confirming adapters record after `writeLine()` succeeds. | One `Map<number, number>` per `HsrDriver`; no delete/clear/recovery. |
| Tmux | `driver-tmux/src/driver.ts:365,384` | Latest generation for a distinct message ID on both normal accepted submission and the deliberate `echo_mismatch` assume-best acceptance path. | One map per `TmuxDriver`; no delete/clear/recovery. |
| Cell | `driver-cell/src/driver.ts:190-192,291-296` | Exactly the inner HSR recorder. | Same HSR map; Cell allocates no additional consumed map. |
| Sim | `harness/src/sim-driver.ts:57-58,93-104` | Simulation-only ground truth retained by the private harness. | Intentionally remains test-owned and is outside a production H10 change. |

`Map.set()` means this is not a complete event history. Reusing a message ID overwrites its generation and does not increase `consumedCount()`. It contains no body, ordering, timestamp, Bee ID, or acceptance count. With normal Core mailbox allocation, IDs are globally distinct, so its size generally follows lifetime delivered-row count.

There is no lifecycle cleanup:

- HSR `onExit()` removes the live process at `:1372`, but not history. `stop()`, `detachAll()` (`:1145-1165`), and `disposeAll()` (`:1168-1180`) do not clear it.
- Tmux `onExit()` removes the runtime at `:825`, but not history. `detachAll()` (`:612-620`) and `disposeAll()` (`:622-635`) do not clear it.
- Cell's detach/dispose methods delegate to the inner HSR.
- `HoneybeeDaemon.stop()` invokes detach or dispose at `daemon.ts:693-703` and retains its `driver` field. In normal deployment the daemon process then exits, which finally releases the maps. A long-running daemon retains them across Bee exits, stops/revives, Bee deletion, and generations.
- A fresh driver starts with an empty map. HSR adoption reconstructs protocol confirmation state, not consumed history. The runner-host restart test creates a fresh driver at `driver-hsr/tests/runner-host.test.ts:307-317`; old session-log delivery remains real, but it is absent from the new driver's history.

That last fact bounds the “ground truth” claim: it is valid only within one driver/checker lifetime. It is not durable audit or cross-daemon history.

### Parent structural probe assessment

The current parent plan reports provider-free real-HSR runs at 0/1k/10k/100k distinct IDs with exact public outcomes, generations, child input order/body/count, and stopped-runtime history. That is consistent with the source ownership and lifecycle findings above.

Its diagnostic stopped-minus-released managed-occupancy gaps are 472 bytes at 0 IDs, 462,496 bytes at 10k, and 3,675,000 bytes at 100k. Those nonlinear whole-process deltas are enough to prioritize an A/B heap ruler and are compatible with Map capacity changes. They are not an exact per-entry size, a candidate win, or proof for Tmux/Cell/daemon wiring. The plan correctly keeps heap snapshots separate from numeric runs and labels the readings diagnostic-only.

## The load-bearing state is different

The following must remain untouched by this unit:

| State | Role | Lifecycle |
| --- | --- | --- |
| HSR `pendingDeliveries` | Suppresses duplicate outbound requests while a confirming adapter's request has no reply. A repeated daemon delivery attempt refuses `not_ready`. | Created per `ManagedProcess`; removed on confirm/refuse; discarded with that runtime. It is deliberately not recovered after uncertainty. |
| HSR `confirmedDeliveries` | Bridges an adapter acknowledgement to the next daemon retry. `deliver()` removes the ID, returns accepted, and only then can Core durably mark the mailbox row delivered. | Created per runtime. Exact-generation adoption rebuilds it from the committed output-only observation journal at `driver-hsr/src/driver.ts:241-297,927-971`. Refusal removes it; accepted retry consumes it. |
| Tmux `pendingConfirms` | Produces observer-confirmed turn behavior or a visible retryable `unconfirmed` note after grace. | Per runtime; cleared by turn evidence at `driver-tmux/src/driver.ts:774-799`, aged into notes at `:753-770`, and released with the runtime. |
| HSR `pendingWrites` | Buffers non-mail protocol lines before the host socket connects. Mail itself refuses rather than entering this daemon-only queue. | Separate H10 concern; not delivery history and not changed here. |

The HSR signal transition is load-bearing: `delivery_confirmed` moves an ID from pending to confirmed (`driver-hsr/src/driver.ts:1331-1334`); `delivery_refused` removes it from both (`:1336-1339`). The history map is never consulted during any of those transitions or during delivery.

Removing history therefore must not be described as bounding all delivery-related memory. Outstanding confirmations and non-mail pending writes remain intentional live protocol state. A memory ruler must settle them to zero or account for them separately before attributing retained bytes to history.

## Exhaustive reader and interface inventory

This inventory comes from exact-symbol `git grep` over `501710c1`, excluding generated performance logs. No computed-property or reflective reader was found; deliberately assembled names outside the repository cannot be ruled out.

### Interfaces and production surfaces

- `RuntimeDriver` (`v2/harness/src/driver.ts:102-142`) includes `deliver()` but neither history query.
- The daemon's `ExtendedDriver` (`v2/daemon/src/loops.ts:144-163`) includes neither history query.
- `SubstrateRouter` implements `RuntimeDriver` and forwards delivery (`v2/daemon/src/substrates.ts:45-100`), but exposes no combined history query. It does retain public references to its three child drivers at `:46-48`.
- Daemon delivery reads only `DeliverOutcome.accepted`; on true it calls `store.markDelivered()` (`v2/daemon/src/loops.ts:1095-1107`). No daemon path reads consumed history.
- HSR defines the queries at `v2/driver-hsr/src/driver.ts:1124-1132`; Tmux at `v2/driver-tmux/src/driver.ts:598-606`; Cell delegates at `v2/driver-cell/src/driver.ts:291-297`; Sim implements them at `v2/harness/src/sim-driver.ts:209-216`.
- `DeliveryGroundTruth` declares only `consumedGeneration()` plus `liveProcesses()` (`v2/harness/src/invariants.ts:56-60`). The private harness barrel exports that interface (`v2/harness/src/index.ts:32-41`). `consumedCount()` has no shared interface.
- `HsrDriver`, `TmuxDriver`, and `CellDriver` and their configs are exported from their source barrels. Those directories have no package manifests. Root `package.json:8-20` exports only `.`, `./comb`, and `./execution/v1`; `@honeybee/harness-v2` is explicitly private. The v2 build bundles a CLI executable rather than publishing the driver classes as a package subpath.
- No RPC schema, CLI command, durable row, audit event, or operator config exposes consumed history.

### Executable `consumedGeneration()` readers

- The only generic consumer is `InvariantChecker.checkI1()` at `v2/harness/src/invariants.ts:250-263`. It scans every delivered mailbox row and compares its durable generation with the supplied recorder.
- Simulation supplies `SimDriver` on every check at `v2/harness/src/simulation.ts:175,342`.
- Real HSR harness: checker construction/calls at `v2/driver-hsr/tests/harness/real.test.ts:139,192,280,292,310`.
- Real Cell harness: `v2/driver-cell/tests/harness/real.test.ts:127,176,250,261,278`.
- Real Tmux harness: `v2/driver-tmux/tests/harness/real.test.ts:120,169,242,253,270`.
- `checkBoot()` accepts the same interface but uses only `liveProcesses()` at `v2/harness/src/invariants.ts:306-339`; it does not read consumed history.
- Direct assertions: HSR driver test `v2/driver-hsr/tests/driver.test.ts:104,108`; HSR runner-host tests `v2/driver-hsr/tests/runner-host.test.ts:68,71,166,179`; Cell driver test `v2/driver-cell/tests/driver.test.ts:135`; Tmux driver test `v2/driver-tmux/tests/driver.test.ts:32`; Tmux equal-treatment scenario `v2/driver-tmux/tests/eq-matrix.test.ts:48` (with result contract at `:14-22,55-60`); Sim extra test `v2/harness/tests/harness-extra.test.ts:77`.

### Executable `consumedCount()` readers

- Simulation final statistics: `v2/harness/src/simulation.ts:353`.
- Real HSR final statistics: `v2/driver-hsr/tests/harness/real.test.ts:315`.
- Real Cell final statistics: `v2/driver-cell/tests/harness/real.test.ts:283`.
- Real Tmux final statistics: `v2/driver-tmux/tests/harness/real.test.ts:275`.

These statistics count distinct recorded IDs, not calls. No production telemetry reads the count.

### Constructor/compatibility sites

Production construction is limited to `v2/daemon/src/daemon.ts:580,584,594` plus Cell's inner HSR at `v2/driver-cell/src/driver.ts:121`. Developer smokes construct HSR at `driver-hsr/smoke.ts:104`, Cell at `driver-cell/smoke.ts:171`, and Tmux at `driver-tmux/smoke.ts:358`.

Direct test constructors found by the same source search are:

- HSR: `v2/daemon/tests/loops.test.ts:374,1673`; `v2/driver-hsr/tests/driver.test.ts:223,243,430,486,520,591,618,636,670,699,753,795,886,927,952`; `v2/driver-hsr/tests/helpers.ts:33`; `v2/driver-hsr/tests/runner-host.test.ts:40,185,222`; `v2/driver-hsr/tests/harness/real.test.ts:99`.
- Cell: `v2/driver-cell/tests/driver.test.ts:49`; `v2/driver-cell/tests/harness/real.test.ts:83`.
- Tmux: `v2/driver-tmux/tests/helpers.ts:90`; `v2/driver-tmux/tests/harness/real.test.ts:81`.

Helper consumers inherit the helper's default. This inventory matters because a default-off change would alter many test harnesses and every source-level direct constructor, whereas default-on plus the three daemon wiring changes preserves them.

## Correctness counterexamples and contract limits

### 1. “Consumed” is not universally literal process consumption

Tmux's known echo-mismatch path proves the distinction. At `v2/driver-tmux/src/driver.ts:357-374`, the driver clears the residue, does not press Enter, explicitly says “not submitted,” records the ID in `consumed`, emits an immediate retryable note, and returns `{accepted:true}`. The corresponding test requires assume-best acceptance and no turn at `v2/driver-tmux/tests/deliver-verify.test.ts:80-100`.

The precise cross-driver name is therefore “accepted-delivery recorder under that driver's policy,” not proof that a model read the body. HSR confirming adapters provide stronger evidence because recording waits for the protocol confirmation and a retry; HSR non-confirming adapters record a successful write.

### 2. The invariant is only partly independent

The checker comments call this “actual consumption” (`v2/harness/src/invariants.ts:7-10,250-260`). The simulation meta-test catches a `DroppingDriver` because its override returns accepted without executing `SimDriver`'s internal record site (`v2/harness/tests/spec02.test.ts:188-207`). That is useful separation.

For real drivers, however, the recorder and acceptance live in the same method. It can catch some control-flow regressions (for example, returning accepted before reaching an existing record site), but it cannot independently prove downstream model consumption. The HSR roundtrip test separately inspects the agent log at `v2/driver-hsr/tests/driver.test.ts:96-119`; that independent wire/agent evidence is stronger than the map.

A generic wrapper around `deliver()` would erase even the existing separation: Core and the wrapper would both trust the same boolean. If extraction follows later, preserve an accept-point hook/sink at the present sites or collect independent host evidence.

### 3. Fresh-driver and duplicate-ID behavior limit “history”

- History is not serialized or reconstructed, so a new daemon/driver cannot answer for prior durable deliveries. Supplying a fresh real driver to `checkStep()` against an old mailbox would report every old delivered row as a ghost.
- A second accepted call for the same ID replaces the generation. That can make a previously matching durable row appear mismatched if a caller violates Core's no-redelivery assumption.
- Real harness “daemon crash” exercises rebuild of `SimDaemon`/store while retaining one driver instance (`v2/driver-hsr/tests/harness/real.test.ts:94-113,161-193`). It does not prove consumed-history continuity across a real driver reconstruction.

### 4. A test-owned outer recorder is observably non-exact with custom dependencies

Tmux records before calling its public `now` dependency on both accepted branches: `consumed.set()` at `:365` precedes `this.now()` at `:372`, and `consumed.set()` at `:384` can precede `this.now()` at `:386`. A throwing custom `now` leaves current history updated even though `deliver()` throws and never returns an outcome. An after-return wrapper would not record it. This edge may not be desirable policy, but it is existing observable behavior and blocks claims of exact wrapper equivalence.

### 5. Referenced reset specifications are absent at the accepted commit

Source barrels refer to `docs/design/specs/reset-02-harness.md`, `reset-03-hsr-driver.md`, and `reset-05-cell-tmux.md`, but those paths do not exist in `501710c1`. The available contract evidence is therefore the current interfaces, comments, tests, and introduction commits (`171dfc29`, `d7b20a8a`, `7198772f`), not those missing documents.

## Minimal architecture options

### Option A — compatibility slice: default-on recorder, daemon explicitly off

Add an optional, honestly named construction policy such as `recordDeliveryHistory?: boolean`, interpreted as on unless exactly `false`. Allocate no Map when false and guard only the four existing write sites. Those sites must remain the test evidence origin; do not reconstruct evidence from the returned outcome.

Daemon wiring explicitly passes `false` in shared `hsrConfig` and the Tmux config. This preserves every omitted-option caller and all source-public default behavior while removing lifetime growth from the built-in daemon's HSR, Cell, and Tmux instances.

Advantages: smallest change; no RuntimeDriver/Core/RPC/CLI change; no acknowledgement-state change; no Cell source change; easy historical A/B.

Limits: the production classes still own test state, direct constructions still retain, and future daemon construction can regress if it omits the flag. This option is viable only if its acceptance claim is explicitly “built-in daemon retention removed.”

#### Disabled-query policy is an explicit unresolved choice

Default-on construction preserves current query behavior under either policy. The new explicitly disabled mode has two materially different contracts:

- **Return `undefined` / `0`.** This preserves the method return shapes and can be described as an empty recorder. It also looks exactly like valid evidence that no delivery occurred. A future checker can pass on an empty mailbox, report misleading ghosts on a populated mailbox, and a statistics caller can publish zero without learning that instrumentation was disabled. Documentation alone does not remove that ambiguity.
- **Throw from both queries.** This makes accidental use of a disabled driver fail immediately and distinguishes “instrumentation unavailable” from “nothing recorded.” No current production reader would be affected, and the option itself is new, so default-on source callers remain compatible. The cost is that explicitly disabled objects no longer have total query methods; diagnostic code must know the mode or handle the error.

A discriminated result or separate `historyEnabled()` query would avoid both ambiguity and exceptions, but expands the public surface and is not the smallest slice. On ownership safety, throwing is stronger than empty values; this report does not select either policy.

### Option B — test-owned sink at the exact write sites, default absent

Inject an optional external sink/recorder into HSR and Tmux and invoke it exactly where the four `Map.set()` calls are now. Tests own the Map and supply `consumedGeneration` / `consumedCount` through a small harness helper. Cell forwards the HSR sink through its existing config spread. Ordinary production constructors supply nothing.

This is the cleanest eventual ownership: no production history Map, while a broken override that never reaches the accept point still lacks evidence. The sink's exception contract must be explicit; a general public callback that can throw or re-enter delivery is a new behavioral hazard. A narrow recorder object with a synchronous no-throw contract is preferable to an arbitrary callback.

Compatibility cost: removing or changing the concrete query methods breaks source-level callers, even though it changes no declared RuntimeDriver or root package API. It also requires migrating the direct assertions and three real harnesses. Keep SimDriver's test-owned Map unchanged.

### Option C — protected accept-point hook plus test subclasses

Replace the Map writes with a protected no-op hook and let test subclasses retain history. This keeps acceptance-site separation without a constructor callback and leaves production allocations at zero. It still exposes a subclass API in production and removes the concrete query methods unless compatibility shims remain. Cell needs its own recording subclass or an inner-HSR hook path. This is viable but broader and less explicit than an injected sink.

### Option D — internal recorder default off, tests opt in

Keep the Map and public methods but default it off everywhere; tests and compatibility consumers opt in. This bounds direct production constructions but silently changes existing source-call behavior (`undefined`/`0`) and retains test ownership in production code. It is a poor intermediate unless the source-public compatibility break is accepted explicitly.

### Rejected as solutions

- Pruning on process exit, stop, generation rotation, or Bee deletion loses the full-lifetime checker evidence and does not bound a long-lived busy runtime.
- A fixed cap or LRU makes old delivered rows fail I1 when the checker scans the complete mailbox and changes `consumedCount()` semantics.
- Recording in a generic wrapper after `{accepted:true}` makes the ground-truth comparison tautological and misses pre-return/throw ordering.
- Weak storage cannot use numeric keys and would make correctness depend on GC.
- Keeping the current code preserves compatibility but leaves H10 growth unchanged.

## Cheap regression obligations for a default-on/daemon-off candidate

All checks use owned temporary state and provider-free fixtures.

1. HSR default-on: boot/no-process/wrong-generation/socket/write refusal do not record; successful non-confirming write records; socket backpressure remains one accepted write; synchronous write failure remains unrecorded.
2. HSR confirming adapter: first request is `not_ready` and pending but unrecorded; repeated pre-confirm attempt writes nothing; confirmation moves pending to confirmed; the next retry returns accepted, consumes confirmed, and records exactly once. Refusal permits a later resend. Re-adoption retains only journal-confirmed protocol state, not old history.
3. Default overwrite/lifecycle: distinct IDs increase count, a duplicate key overwrites its generation without increasing count, and stop/revive/detach/dispose do not change default history. A fresh driver begins empty. These preserve the current concrete-method contract.
4. Disabled HSR: run the same transition matrix and compare return values, exact wire frames/body/count, observations, session evidence, recovery cursors, pending/confirmed contents, and stop/revive behavior. Assert the selected query contract explicitly: both empty values or both throws. Source/heap evidence separately proves there is no hidden growing Map.
5. Tmux default and disabled: cover wrong generation, multiline refusal, injection failure, successful verified submission, Enter failure, normal pending-confirm/note lifecycle, and the deliberate echo-mismatch accepted-but-not-submitted path. The recorder policy must not change return values, Enter calls, notes, timing dependency order, or process state.
6. Preserve the current custom-dependency edge: with default recording, a throwing Tmux `now` after the record site has the same observable history as before. Do not centralize recording after a returned outcome while claiming exact compatibility.
7. Cell pass-through: set the HSR option through `CellDriverConfig.hsr`, perform an accepted delivery, and prove the selected disabled query behavior with unchanged provisioning/delivery/process evidence. This specifically verifies the no-Cell-source-change assumption.
8. Actual daemon construction: start the real built-in daemon and real drivers with provider-free fake harness/host fixtures, deliver through each configured substrate as cheaply as practical, and inspect the concrete children retained by `SubstrateRouter`. Assert the chosen disabled-query signal on all three. The test must fail if direct HSR, Cell-inner-HSR, or Tmux returns to default recording. Constructing a disabled driver in isolation is insufficient.
9. Compile-time/API guard: `RuntimeDriver` and daemon `ExtendedDriver` remain unchanged; root exports, RPC schemas, CLI output, durable store, and audit stay unchanged.

If disabled queries return empty values, `consumedCount() === 0` alone is not proof that the Map was never allocated or populated behind a masked getter. If they throw, the exception proves the disabled branch is observable but still does not prove allocation behavior. The implementation diff plus a targeted heap/backing-store diagnostic supplies that proof.

## Measurement/ruler obligations

The parent's plan has the right 0/10k/100k shape. The following details are required for an attributable result:

- Use two distinct source roots and run A/A control plus symmetric ABBA A/B samples. Record full source, ruler, Node, OS, boot, executable, adapter, and fixture hashes at start and end; retain every raw sample and explicit completion/failure evidence.
- Use a real `HsrDriver` with a provider-free owned runner/host fixture. Give every measured delivery a distinct ID and verify exact accepted/refused counts, wire bodies and order outside measurement. Include duplicate-ID overwrite as a separate semantic case, not in the heap slope.
- At each size, record constructed, accepted-and-fully-drained, runtime-stopped while the driver remains referenced, dispose/detach while referenced, and driver-released phases. Use a fixed GC/yield protocol. Do not put heap snapshots or setup/reset in numeric timing samples.
- Ensure `pendingDeliveries`, `confirmedDeliveries`, `pendingWrites`, socket buffers, transcript buffers, observations, and child output are drained or independently counted at the retained-memory point. Otherwise the result cannot be attributed to `consumed`.
- Compare slopes (`0→10k→100k`) rather than assigning all `heapUsed` delta to Map entries. Snapshot diagnostics should follow the source-verified `consumed` property to its Map/backing table and report shallow/retained definitions honestly. Numeric number keys/values usually have no object-edge count equal to logical map size.
- If claiming a worst-case per-entry number rather than only proving unbounded growth/removal, add a separate high-safe-integer ID axis around V8's immediate-integer representation boundary; low sequential IDs alone may understate boxed-number storage. Do not mix this axis into headline samples.
- Measure Tmux separately before claiming a Tmux-specific end-to-end memory number. HSR establishes the common numeric-Map mechanism and Cell reuses the exact HSR implementation, but it does not measure Tmux fixture/process noise. A smaller Tmux semantic/no-growth proof may accompany a source-based inference if labeled as such.
- Prove daemon wiring independently of driver-only ruler results. The after root must show the built-in HSR, Cell-inner-HSR, and Tmux instances all disabled; default-on control must still show the original slope for direct constructors.
- Compare exact delivery outcomes and external effects, not only recorder counts. In particular, Tmux echo mismatch must still return accepted with a retryable note and no Enter, while HSR confirming delivery must still wait for acknowledgement before Core can mark delivered.
- Heap snapshots, retained-path inspection, storage, and any CPU diagnostic are separate calls. Storage should be unchanged. CPU improvement is not required. Do not close all of H10 based on this map: `pendingWrites` and genuinely outstanding protocol state remain separate axes.

## Decision frame — no option selected

Option A is the smallest compatibility-preserving daemon candidate; Option B has the cleaner ownership. Neither is selected or authorized by this report. If Option A is later chosen and measured successfully, its acceptance language should be:

> Built-in daemon HSR, Cell-inner-HSR, and Tmux instances do not allocate or retain accepted-delivery history; default concrete-driver constructions preserve the prior recorder API and semantics. Protocol pending/confirmed state is unchanged.

Do not claim that production driver ownership has been cleaned up. If the measured retained-heap slope justifies a follow-up, Option B is the better end state: test-owned storage attached at the four existing writes, followed by an explicit decision on the source-public concrete query methods. Under either option, those writes—not an outer `DeliverOutcome` wrapper—remain the test evidence origin.
