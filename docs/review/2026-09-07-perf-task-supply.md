# Task-supply predicate review

Reviewed author commit `6cc402de`, integrated as `7dfd8ca3`. No blocking findings.

The change preserves `evaluateSupplyGate()` and its public reason ordering. `tryFeedTaskSupply()` exposes only a feed or null, so disabled, paused, exhausted, empty-list, question-blocked and mail-blocked decisions can short-circuit without changing a returned reason. Supported writes require a Bee before enabling supply; the task-supply foreign key cascades on deletion. A missing Bee therefore resolves to the existing disabled default and still returns null after removal of the unused full Bee read.

The positive path still passes the complete ordered task list to the existing pure gate, preserves remaining-task counts and feed-body construction, records the same mailbox sender/urgency, and applies the same consecutive-feed breaker. The new mailbox predicate also replaces full hydration in stall detection without changing runtime eligibility or the selected in-flight task. Existing partial indexes serve both boolean probes; there is no schema or storage change.

Tests cover negative read avoidance, missing Bees, feed-limit-only exhaustion, paused supply, empty task lists, blocked question/mail decisions, positive task order and exact bodies, breaker reset, stall idempotency, and replay equality. The parent additionally compared every returned effect, body, full state and audit in 30 paired samples per side for positive feeds and two busy negative cases. All matched.

Parent integration at `c027f347` passed the full core suite, focused daemon loop/account-swap/argument tests, all v2 TypeScript checks, and repository build on Node 24.18.0. Counts and logs are in the performance verification directory. The measured residual per-supply cost remains open; this review does not claim that task-supply scaling is fully optimized.
