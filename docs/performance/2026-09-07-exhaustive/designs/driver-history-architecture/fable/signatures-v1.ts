/**
 * H10 unit 1 design sketch (fable candidate): built-in daemon HSR/Cell
 * delivery-history retention. Types and signatures only — bodies are
 * `not implemented` pseudocode. Baseline 501710c1 (main c6cf01f2 identical
 * runtime bytes). Tmux and SimDriver are OUTSIDE this unit's production
 * diff; the Tmux extension path is described but not implemented.
 *
 * TWO structurally distinct whole designs are sketched. Design 1 is the
 * recommendation; Design 2 is the fully-shaped alternative. Both keep the
 * four existing acceptance-site writes as the only evidence origin (no
 * outer wrapper — a wrapper recording {accepted:true} is tautological for
 * I1 and misses pre-return/throw ordering).
 */

// ===========================================================================
// DESIGN 1 (RECOMMENDED) — construction retention policy, default ON,
// daemon explicitly OFF, disabled queries THROW
// ===========================================================================

// ---------------------------------------------------------------------------
// v2/driver-hsr/src/driver.ts — config field + nullable map + guarded sites
// ---------------------------------------------------------------------------

export interface HsrDriverConfigAddition {
  /**
   * Record accepted-delivery history (messageId → generation) for the
   * driver's lifetime, exactly as today. Interpreted as ON unless exactly
   * `false` — omission preserves current behavior for every existing
   * caller, so the ~20 direct test constructors, helpers, three real
   * harnesses, and smokes are untouched. The built-in daemon passes
   * `false` explicitly (omission is NOT how the daemon opts out).
   * When false, NO Map is allocated and the two query methods THROW —
   * an explicitly disabled recorder must be loud, never a fake empty
   * ground truth (0/undefined masquerades as "nothing was delivered").
   */
  recordDeliveryHistory?: boolean;
}

export declare class HsrDriverSketch {
  /**
   * Replaces `private readonly consumed = new Map<number, number>()`
   * (driver.ts:320). Null IS the disabled state — the absence of the Map
   * is the whole memory claim, verifiable in a heap snapshot by the
   * (classification-fixed) inspector finding zero consumed Maps.
   */
  private readonly consumed: Map<number, number> | null;
  // constructor: this.consumed = cfg.recordDeliveryHistory === false ? null : new Map();

  /**
   * The two existing write sites (driver.ts:587 confirm-consume retry,
   * :614 non-confirming successful write) become guarded IN PLACE:
   *
   *   if (this.consumed !== null) this.consumed.set(messageId, generation);
   *
   * Nothing else moves: acceptance policy, pendingDeliveries,
   * confirmedDeliveries, pendingWrites, observations, cursors, outcome
   * values, and write ordering are byte-identical in the default arm and
   * observably identical in the disabled arm (the guard is the only new
   * instruction). The sites remain the test evidence origin.
   */
  // not implemented — two one-line guards at the existing sites

  /**
   * Disabled-mode contract: THROW. No production reader exists (inventory:
   * the only executable readers are the invariant checker and harness
   * statistics), so no default caller changes. The error message is stable
   * for assert.throws matching; no new exported error class (smallest
   * surface — revisit only if a caller needs programmatic discrimination).
   */
  consumedGeneration(messageId: number): number | undefined;
  // if (this.consumed === null) throw new Error("delivery history recording is disabled for this driver");
  // return this.consumed.get(messageId);
  consumedCount(): number;
  // same throw guard; return this.consumed.size;
}

// ---------------------------------------------------------------------------
// v2/driver-cell/src/driver.ts — NO CHANGE (verified at 501710c1)
// ---------------------------------------------------------------------------
// CellDriver builds its inner HSR as `new HsrDriver({ ...cfg.hsr, resolve })`
// (driver.ts:121-124) and delegates consumedGeneration/consumedCount to it
// (:291-297). The new field flows through the existing spread; Cell's
// delegation inherits the throw contract automatically.

// ---------------------------------------------------------------------------
// v2/daemon/src/daemon.ts — ONE line in the shared hsrConfig literal
// ---------------------------------------------------------------------------
// const hsrConfig = {
//   sessionLogDir: ..., stopKillGraceMs: ..., adoptToleranceMs: ...,
//   recordDeliveryHistory: false,   // <-- the entire daemon-side diff
// };
// (daemon.ts:575-579). The literal is spread into the direct HsrDriver
// (:580) and passed as `hsr:` to CellDriver (:590), so BOTH built-in HSR
// instances disable with zero Cell change. The TmuxDriver block (:594-601)
// is deliberately untouched this unit.

// ---------------------------------------------------------------------------
// Tmux extension (LATER unit; described, not implemented)
// ---------------------------------------------------------------------------
// TmuxDriverConfig gains the same field; its two write sites
// (driver-tmux/src/driver.ts:365 verified submission, :384 echo-mismatch
// assume-best) take the same in-place guards; the daemon's tmux block adds
// `recordDeliveryHistory: false`. The echo-mismatch path and the
// record-before-now() ordering edge stay exactly where they are — the
// guard wraps the set() only, so the throwing-now observable edge is
// preserved verbatim in the default arm. No end-to-end Tmux metric is
// claimed until its own measured unit.

// ===========================================================================
// DESIGN 2 (ALTERNATIVE, fully shaped) — test-owned recorder sink injected
// at the write sites, default ABSENT
// ===========================================================================

/**
 * The recorder becomes an injected capability owned by whoever needs the
 * evidence (harness/tests). Ordinary constructions — daemon AND direct —
 * allocate nothing.
 */
export interface DeliveryHistoryRecorder {
  /**
   * Called synchronously at the exact existing acceptance sites with the
   * same arguments the Map.set() receives today. CONTRACT (documented, not
   * enforceable): must not throw and must not re-enter the driver. Today's
   * Map.set() cannot throw, so a throwing recorder would create a NEW
   * mid-acceptance exception path (the analog of the Tmux now() edge); a
   * re-entrant recorder could observe half-updated pending/confirmed
   * state. The harness implementation is a trivial Map wrapper, so the
   * contract is honest there — but the hazard exists for any future
   * third-party recorder and cannot be checked by types.
   */
  record(messageId: number, generation: number): void;
  consumedGeneration(messageId: number): number | undefined;
  consumedCount(): number;
}

export interface HsrDriverConfigAlternative {
  /** Absent (the default everywhere) ⇒ no recorder, queries throw. */
  deliveryHistory?: DeliveryHistoryRecorder;
}

export declare class HsrDriverAlternativeSketch {
  private readonly deliveryHistory: DeliveryHistoryRecorder | null;
  // write sites: if (this.deliveryHistory !== null) this.deliveryHistory.record(id, generation);
  // queries: delegate to this.deliveryHistory or throw as in Design 1
}

// v2/harness/src/… — the test-owned implementation tests would construct
// and pass through every existing direct-construction site:
export declare class RecordingDeliveryHistory implements DeliveryHistoryRecorder {
  private readonly consumed: Map<number, number>;
  record(messageId: number, generation: number): void; // not implemented: Map.set
  consumedGeneration(messageId: number): number | undefined; // Map.get
  consumedCount(): number; // Map.size
}

// Caller cost that decides against Design 2 FOR THIS UNIT: every default
// construction loses its recorder, so the ~19 direct consumedGeneration/
// consumedCount assertions, both HSR/Cell real harnesses, helpers, and
// smokes must be migrated in the same diff that must also prove daemon
// wiring — and the class surface gains a public injectable interface whose
// throw/reentry contract is prose. Design 1 reaches the same daemon-off
// end state with two guards, one field, and one wiring line, and leaves
// Design 2 available as the later ownership-extraction unit behind the
// very same write sites.
