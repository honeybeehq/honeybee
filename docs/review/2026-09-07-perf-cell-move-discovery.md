# Cell move discovery performance review

Reviewed `9b22be23..476559e5`. The production delta changes only the ordering expression from a receipt primary key to the equal active foreign-key value. The inner equality join already excludes missing/null pointers, and unique active pointers prevent receipt duplication. Both columns use the existing binary text ordering. Result rows, ordering, and durable reads therefore remain identical.

The main failure risk is a planner change or accidentally bypassed live state. The test captures the production prepared SQL, proves active-index use with no receipt scan, and exercises rollback and reopen. The measured workload checks exact full receipt arrays across zero, one, and ten active moves against up to 100,000 retained failures. No reconciliation condition, mutation, or driver call was edited.

The A/A control shows the unchanged query cost on both roots; A/B changes only store.ts. The whole-step reduction at zero active moves is attributable to discovery because command processing is disabled and all audit/driver assertions hold. Active-move measurements cover discovery alone. Neither proves full move throughput or worker responsiveness.

No correctness finding remains in the reviewed diff. Combined production integration checks remain required before acceptance into main.

Combined `4ebf43c9` passed core 213/213 and the serial daemon suite with 358 passes and one platform skip. The exact combined production source also passed all v2 typechecks, repository build, and the 68-test loop suite. Logs are `verification/mini-move-held-integrated-*.log` and `mini-held-eligibility-*.log`. No remaining merge gate for these two changes.
