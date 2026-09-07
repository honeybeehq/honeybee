# Cell exit ruler review

Author commit `9652fa61`, integrated as `0e1de805`, supplies eight deterministic capture cases: merge/rebase land and conflict, fast-forward, branch creation, no new work, and checked-out refusal. The parent hardened checkout invariants and diagnostic provenance before accepting measurements.

Every sample now checks origin and Cell HEAD, Cell refs and clean working tree, plus the existing origin ref digest, exact reports, trees, parent order, and deterministic result SHA checks. Separate Git Trace2 diagnostics fail on missing or malformed data, retain hashed raw sidecars, and summarize top-level Git durations without counting nested durations twice. Source, helper, Git version, boot, completion, and expected case counts are checked. Headline timing refuses an inherited GIT_TRACE2_EVENT.

Mini validation: ruler tests 2/2 and repository build passed on Node 24.18.0. Logs are retained under verification/mini-cell-ruler-*. No canonical performance comparison is claimed yet.

Wall time includes Git children. Parent CPU excludes them. Traces are separate diagnostic runs. Fixture origin/Cell repositories disable automatic maintenance; production scratch clones keep defaults. Same-root A/A shares module identity, so acceptance captures must use distinct identical checkouts. This ruler measures synchronous capture, not RPC latency or daemon readiness. Canonical and stress sizes require a Mini smoke to establish their cost.
