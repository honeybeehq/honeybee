# P2-honeybee-freeze evidence

- `byte-compare.md`: scenario-by-scenario diff of `hive deploy` (artifact, replay, list, rollback, init, usage errors), `update-owner`, `deploy-info` and completion between the build of 4531a680 (before) and the freeze commit (after), same fixture artifact. Produced by `compare.mjs`.
- `before/`, `after/`: raw stdout, stderr and exit codes per scenario. Produced by `capture.mjs <dist/cli.js> fixture/ <out>`.
- `fixture/`: the release-like runtime artifact (tarball, identity.json, admission.json, the stand-in daemon CLI) built by `make-fixture.mjs` with the before build's runtimeArtifact module.
- `terminal-deploy-rollback-completion.txt`: `script` recording of a scratch-home session: artifact deploy, owner shim, two rollbacks, completion scripts and candidates, usage refusal, help.
- `loc-removed.md`: lines and files removed, moves with similarity.
- `ci-and-package.diff`: the CI workflow and package.json changes.
- `batteries-summary.txt`, `battery-*.log`: typecheck, core, daemon+CLI, driver, driver2, harness and release-inventory batteries with real exit codes (TMPDIR=/tmp; this Cell's own TMPDIR exceeds the unix socket path limit).
- `decisions.tsv`: the decision trail.

Replay: `node .proof/p2-honeybee-freeze/capture.mjs dist/cli.js .proof/p2-honeybee-freeze/fixture /tmp/out && node .proof/p2-honeybee-freeze/compare.mjs .proof/p2-honeybee-freeze/before /tmp/out /tmp/compare.md`.
