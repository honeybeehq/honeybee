Queen must review this runner before execution. It launches real Codex and Claude against deterministic local mock providers inside separate sandbox-ON Cells. It never uses a production daemon, account, token, or git remote. No real harness run was performed while preparing the script.

Run from a clean checkout of the reviewed script branch on the Queen Linux host, outside any Cell. Build that checkout first so its peer identity bridge is available. Supply the exact approved projection-capable commit already present in this own repository, the actual absolute Apiary executable paths, and the projection function export name approved with that commit. There is no default export-name guess or production test marker.

Create an owned, private, short scratch parent with mode 0700. Do not reuse a previous fixture directory. Invocation:

```sh
node scripts/queen-cell-real-harness.mjs \
  --approved-head <40-character-approved-sha> \
  --node /opt/node-v24.18.0-linux-x64/bin/node \
  --codex <absolute-Apiary-Codex-path> \
  --claude <absolute-Apiary-Claude-path> \
  --scratch-parent <owned-0700-short-directory> \
  --projection-export <approved-apiaryHarness-function-export>
```

The runner archives the exact approved source into a new 0700 scratch directory, records build provenance and lockfile hash, installs only lockfile-pinned dependencies, and builds there. The reviewed fixture scripts are copied separately with their hashes recorded. The fixture worker requires a function exported from that build's `v2/driver-cell/src/apiaryHarness.ts` before starting a provider or harness. Missing capability refuses execution.

Each lane uses a fresh daemon config, database, socket, origin repository, Cell, and synthetic account home. The real harness receives one deterministic shell call, then a final response only after the mock sees successful tool output. The call lists files, prints Node version and PATH, records git status, and commits a local fixture file with an explicit fixture identity. No git push occurs. The worker independently verifies the resulting commit, author, file, clean status, final transcript, and actual wrapped bwrap launch argv.

The mock accepts only loopback requests to its supported Responses/Messages routes, plus Claude's local token-count route. It never proxies requests. Unexpected routes, unsupported tool schemas, extra turns, missing tool results, projection failure, and launch failure produce a failed receipt. Version-specific harness compatibility remains unverified until Queen runs the reviewed script; mocks must not be relaxed to hide a real tool failure.

The output names `receipt.json` in retained owned scratch. It includes exact source, executable hashes, build commands, per-harness outputs, PATH, git commit, launch arguments/binds, transcript locations, and cleanup results. The scratch also contains bounded build logs and synthetic model request bodies; request headers are never recorded. Successful daemon shutdown explicitly disposes fixture runtimes. Supervisor fallback signals only birth-verified owned process groups and marks the run failed if forced cleanup was needed. Unverifiable cleanup is a failed receipt. Keep scratch for review; dispose it with the repository's trash convention after reviewing process cleanup.

Mock-only verification (does not launch either harness):

```sh
node --test scripts/queen-harness-mocks.test.mjs
node --check scripts/queen-cell-real-harness.mjs
node --check scripts/queen-harness-worker.mjs
```

An eviction/resume phase can be added after the first verified turn; it is deliberately absent from this script.
