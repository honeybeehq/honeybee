# Selected H10 unit 1 design

The built-in daemon will disable lifetime delivery-history recording in direct HSR and Cell-inner-HSR. Existing source callers retain current recording by default. Tmux and SimDriver remain outside this unit.

Caller usage is one added field in the daemon's existing shared HSR configuration:

```ts
const hsrConfig = {
  sessionLogDir: this.cfg.sessionLogDir,
  stopKillGraceMs: this.cfg.stopKillGraceMs,
  adoptToleranceMs: this.cfg.adoptToleranceMs,
  recordDeliveryHistory: false,
};
```

The existing direct HSR spread and Cell hsr assignment remain. Cell already forwards its hsr config into its inner HSR driver. No Cell production change is needed.

## Contract

- Add `recordDeliveryHistory?: boolean` to HsrDriverConfig. Exactly false disables. Omission and true preserve recording.
- Replace the private initialized history Map with `Map<number, number> | null`. Initialize it once in the constructor. Null is the entire disabled state; no second flag, sink, wrapper or cache.
- Guard Map.set at the two existing HSR acceptance sites only. Preserve confirmation consumption, successful write ordering, pending and confirmed delivery sets, write queues, observations, sessions, recovery cursors, and return values.
- Both queries throw `Error("delivery history recording is disabled for this driver")` whenever disabled, including before any delivery. Use inline guards; keep their existing public signatures. No error class or status API.
- Default overwrite, distinct-count and driver-lifetime retention behavior stays unchanged across stop, revive, detach and dispose. A new driver remains empty.
- This is a daemon opt-out, not complete extraction of test evidence from production classes. Core mailbox truth and invariant telemetry are unchanged.

## Selection and grafts

The independent parent and cross-judge both scored a 19/20 tie and chose Fable's smaller recommended shape. Both final candidates independently converge on the same policy. The judge's source check found the closed class-split alternative incomplete at the common Cell API seam; the parent accepts that correction to its initially higher alternative-completeness score.

Use Fable as the implementation base. Graft Sol's omitted/true/false acceptance table and its real CoreStore plus DaemonCore differential for direct and confirmed delivery, with exact mailbox generation and audit ordering. Keep Fable's actual HiveDaemon construction test, including both built-in query pairs throwing and an unchanged Tmux default-on query check. The Tmux check does not need to deliver anything.

Do not add Sol's requiredDeliveryHistory helper for two query guards. The judge also proposes a satisfies annotation on the shared daemon literal. The parent declines that optional graft: current constructor uses already typecheck the inferred object, and an optional boolean annotation cannot enforce false. The actual-daemon test is the required omission tripwire. This is a small interface-cost choice, not a disagreement over the policy.

Reject the external sink for changed defaults and arbitrary callback effects. Reject the closed runtime/compatibility class split for extra HSR/Cell classes and widened router/daemon types without a better daemon result. Reject caps/pruning for losing lifetime invariant evidence. No new RuntimeDriver/ExtendedDriver/Core/RPC/CLI/operator contract is introduced.

## Verification and measurement

The isolated implementation starts at c7440572. Author owns production and focused tests, with cheap serial local checks and relevant TypeScript checks. Parent owns the broad build, relevant suites and serial Mini captures. No accepted performance claim precedes these gates.

Use real provider-free hosts for default/disabled direct and confirming acceptance, refusal, wrong generation, duplicate/overwrite, stop/revive and lifetime checks. Keep exact delivered bytes and outcome semantics. The durable differential must use real CoreStore and DaemonCore; test observations and committed rows, not an outcome-recording wrapper. Actual HiveDaemon wiring is inspected only through existing private-field reflection narrowed with instanceof and public SubstrateRouter children.

The parent ruler uses independent serial ABBA processes at 0/10k/100k, exact-source A/A first, candidate opt-out A/B, and omitted-option A/B compatibility control. It verifies every wire frame, transcript and observation bytes, exact outcomes/evidence/cursors, and zero live queues before the retained reading. It tests the non-confirming site; confirming acceptance remains a separate functional gate. Numeric values are driver-process occupancy after best-effort GC, excluding host/agent processes. Snapshot mode is diagnostic-only and uses the classification-fixed analyzer. No CPU or Tmux claim follows from these memory runs.

V4's booted reading additionally waits for the socket connection, after the Mini v3 zero-count smoke exposed that parsed boot can arrive earlier. The failed report and successful cleanup receipt remain in the evidence. Any zero-count run could encounter that race; the observed failure was count 0, run 0.

## Corrections and phase position

The actual daemon is HiveDaemon, not HoneybeeDaemon as the shared task originally called it. The package's approximate caller counts are not an exact inventory, and the observed 3,670,056-byte table divided by 100,000 entries is a fixture-specific quotient, not an allocation law. Unit 1 changes two HSR record sites; the other two cited sites belong to deferred Tmux work. Frozen originals and the judge's detailed corrections are retained.

Ground, sketch, cross-judge, pick and graft are complete. Human checkpoint is skipped because none was requested. Implementation is authorized against this synthesis; broad verification and measured acceptance remain pending. Reopen the design if implementation needs new contracts or repeated workarounds.
