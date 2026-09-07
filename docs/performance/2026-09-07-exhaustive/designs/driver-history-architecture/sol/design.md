# Built-in HSR and Cell delivery-history retention

## Problem

At `501710c1`, each `HsrDriver` allocates one `Map<number, number>` and keeps the latest accepted generation for every distinct message ID for the driver's lifetime. `CellDriver` delegates to the same map in its inner HSR driver. The built-in daemon never reads this evidence, but source callers can construct either exported class and call `consumedGeneration()` or `consumedCount()`. This unit must remove the recorder from built-in direct HSR and Cell without changing default callers, protocol acknowledgement state, delivery outcomes, Core mailbox truth, or any root, RPC, CLI, `RuntimeDriver`, or daemon extended-driver contract.

## Usage

[`usage.md`](usage.md) defines both caller sketches. Candidate A adds an optional `HsrDriverConfig.recordDeliveryHistory` policy. Omission and `true` retain current behavior. The daemon passes `false` in the HSR config that it already shares with direct HSR and Cell. Candidate B splits runtime-only and compatibility behavior into separate HSR and Cell classes.

## Recommended shape

Use Candidate A. Store `consumed` as `Map<number, number> | null` and choose its value once in the `HsrDriver` constructor. A false option stores `null` and allocates no history map. Keep the two record operations at the current acceptance sites in `deliver()`:

- A confirming adapter records only after `confirmedDeliveries.delete(messageId)` succeeds on the acknowledgement retry.
- A non-confirming adapter records only after `writeLine()` succeeds.

Each site changes only from `this.consumed.set(...)` to `this.consumed?.set(...)`. Do not record from `{ accepted: true }` outside the driver. That result is also the value Core trusts, so an outer recorder would make I1 evidence tautological.

When recording is disabled, both history queries throw `Error`. They throw for every ID and count, including before the first delivery. Returning `undefined` and `0` would be indistinguishable from valid empty evidence. Do not add a status method. Delivery never invokes a caller hook, so this change adds no callback exception or synchronous reentry path.

The daemon defines its shared object with `satisfies Omit<HsrDriverConfig, "resolve">` and `recordDeliveryHistory: false`. It passes that object to direct `HsrDriver` construction and `CellDriverConfig.hsr`. The existing Cell spread forwards the option, so `v2/driver-cell/src/driver.ts` needs no production change. This is construction policy, not operator configuration. Tmux and `SimDriver` remain unchanged in this unit.

This interface is deep enough for the bounded job. One construction option hides allocation, recording points, overwrite behavior, and the disabled-query guard. Callers do not coordinate stages or learn protocol state.

## Module map

| File | Planned responsibility |
| --- | --- |
| `v2/driver-hsr/src/driver.ts` | Add the optional config field, nullable map, guarded writes at both acceptance sites, and throwing query guard. |
| `v2/daemon/src/daemon.ts` | Set `recordDeliveryHistory: false` on the existing shared HSR config. |
| `v2/driver-cell/src/driver.ts` | No production edit. Its existing `cfg.hsr` spread forwards the policy. |
| `v2/driver-tmux/**` | No unit-1 edit. |
| `v2/harness/src/sim-driver.ts` | No edit. Simulation keeps its test-owned evidence. |
| Focused HSR, Cell, and daemon tests | Prove compatibility, acceptance parity, forwarding, and actual daemon wiring. |

## Semantics that cannot move

`pendingDeliveries`, `confirmedDeliveries`, `pendingWrites`, observations, recovery cursors, session evidence, Core delivery marks, and per-bee FIFO remain unchanged. Refused and wrong-generation calls do not record. Default mode still overwrites the generation for a repeated message ID without increasing the distinct count. Its records survive stop, revive, detach, and dispose for the driver lifetime. Disabled mode changes only the recorder and its two queries.

## Proof plan for implementation

Use owned temporary stores and provider-free real runner hosts. No production inspection API is needed.

1. Run one table-driven HSR scenario in omitted, explicit-true, and false modes. Assert exact `DeliverOutcome` sequences and exact child wire frames. Cover no process, wrong generation, boot or socket refusal, direct non-confirming acceptance, write refusal, and duplicate message IDs. In retained modes, assert exact generations and counts before and after stop, generation-2 revive, detach, and dispose. In false mode, assert both queries throw at construction and after every transition.
2. Run a confirming-adapter scenario. The first call writes once and returns `not_ready`; a repeat before acknowledgement writes nothing; `delivery_confirmed` moves the existing protocol state; the next retry accepts without a second write. A `delivery_refused` signal permits a later resend. Compare retained and disabled modes on outcomes, frames, observations, session evidence, and recovery cursors. Only retained mode gains the accepted record.
3. Exercise the same direct and confirmed paths through a real `CoreStore` and `DaemonCore`. Assert identical mailbox delivery generation, audit sequence, and delivery outcome in both modes. Run `InvariantChecker` only with retained evidence. Disabled queries must fail rather than fabricate ground truth.
4. Extend the real Cell round trip with two constructions. Omitted `cfg.hsr` records as before. `cfg.hsr.recordDeliveryHistory: false` delivers the same body through the real inner host, preserves provisioning and runtime evidence, and makes both delegated queries throw. Include stop and generation-2 revive.
5. Start an actual empty `HiveDaemon` from a temporary resolved node config. Read its private `driver` only in the test with `Reflect.get()` into `unknown`, narrow with `instanceof SubstrateRouter`, then inspect the router's public `hsr` and `cell` objects. Both query pairs must throw. This test fails if either built-in construction falls back to the compatibility default. Shut down through the public daemon API. Do not add a production getter.
6. Keep a compile-time guard that `RuntimeDriver` and the daemon extended-driver shape have no history methods. The implementation diff must leave Core, RPC schemas, CLI output, durable rows, and audit types untouched.

The source diff plus a corrected heap inspector proves that false mode has no hidden `Map`. The existing heap analyzer must first classify a null slot instead of treating every `consumed` property target as a map.

## Synthesis decision

Candidate A wins for the first unit. It preserves every omitted-option caller and keeps the production delta in the two modules that own the decision. Candidate B gives runtime-only storage cleaner ownership, but it adds `HsrRuntimeDriver` and `CellRuntimeDriver`, widens the router's concrete child types, and creates parallel Cell construction paths. That is a larger compatibility and reader cost for the same built-in daemon result.

## Tradeoffs accepted

- We accept that direct `HsrDriver` and `CellDriver` constructions retain history by default in exchange for source compatibility.
- We accept throwing diagnostic queries in explicitly disabled mode in exchange for never presenting missing instrumentation as empty ground truth.
- We accept a daemon-specific opt-out rather than claiming that all production-class ownership is clean.

## Alternatives considered

Candidate B is the viable class-split alternative in [`signatures.ts`](signatures.ts). Internal base classes keep acceptance logic single-sourced, compatibility classes own closed map recorders, and runtime-only classes expose no history methods. It loses because Cell and `SubstrateRouter` must understand both class families, while Candidate A adds one field and no new call chain.

An externally injected sink loses even if it records at the correct sites. TypeScript cannot enforce a no-throw or no-reentry callback contract, and catching failures would hide broken test evidence. A wrapper that records accepted return values is invalid because it duplicates Core's trust source. Pruning or capping the map changes lifetime and overwrite evidence and still fails to bound a busy live runtime.

## Tmux follow-up

Design and measure Tmux as a separate unit. The likely extension is the same compatibility-default policy, a nullable Tmux map, guards at its two existing acceptance sites, and an explicit daemon false option. Its tests must preserve normal acceptance and the `echo_mismatch` assume-best path, including the current order where recording precedes the `now()` dependency. HSR measurements do not establish Tmux process or memory results.

## Measurement requirements

After implementation, use same-source A/A and symmetric ABBA A/B runs at 0, 10,000, and 100,000 distinct IDs. Preserve exact wire IDs, bodies, order, generations, outcomes, and receipts. Include a default-on compatibility control. Keep numeric memory and heap snapshots in separate processes. Verify the disabled source has no history map and that live protocol queues are drained or counted separately. Report HSR and Cell-inner-HSR only. Do not claim a Tmux or whole-daemon gain from this unit.

## Open questions and risks

- Could a future built-in construction omit `false`? The actual-daemon wiring test is the required guard.
- Does the parent want a named disabled-history error later? This unit needs only an unambiguous throw contract, so an exported error type would add unused public API.

## Grounding

The design uses the frozen ownership study `0c1528b1fef51ddedceef733bd4dfe4392e9fdf9401528889dd6a98843272b07`, heap study `bd087403a6c9c9f0809be51f7001828b2ad3415c615041dc9af121a9071b814c`, and provisional parent plan `376e8282c35bbe87f98f17c55f7a27e36f7ec3b596f3e6425c7e6fb88a27d217`.

## Next implementation step

Add the HSR config policy and focused default-versus-disabled acceptance tests before wiring the shared daemon config.
