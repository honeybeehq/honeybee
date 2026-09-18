# Nightly review — 2026-09-17

Reviewed six new team-authored commits: structured Codex quota/auth failures, Darwin process census, Cell-ready wakeups, performance mapping, and the opt-in central credential pilot on its separate branch. Existing reviewed history was reused, not reopened.

The performance census could hang on a zero-width regular expression, and invalid negative/non-finite comparison tolerances were accepted. The repair advances empty matches and rejects invalid tolerances. Regression tests failed before the repair and all eight passed afterward. Typecheck and build passed; process census, quota and isolated credential tests also passed. No live credentials, deployed daemon, or account state were changed.

The bounded simplification pass retained explicit process identity and credential-generation checks; removing either would weaken correctness. Native behavior and external credential-provider integration beyond the retained isolated checks are not certified by this source review.
