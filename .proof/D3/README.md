# D3: runtime.install, runtime.status, runtime.prune

Change commit (the first of the two D3 commits), first built on origin/main 6000b313 and rebased as a landing fix onto a6cd9ad7 (D1: schema 59, `store.schemaInfo()`, the rollback check reading `deployInfo.store`); `change.diff` is its full diff on that base, and the runs below were repeated on the rebased tree (status reports schema 59 / min reader 59). Lab on metal-1 (trmd-metal-1), Node 24.18.0, npm 12.0.1 (the repo pins npm 11, so `npm ci --force` and the pinned `node_modules/.bin/tsc` were used instead of `npm run`).

Receipts:

- `d3-lab.jsonl` / `d3-lab.stdout.log`: `lab.mjs` (`MODE=d3`) against one scratch hived started directly from a scratch build with its own data dir under `/var/tmp/hb-D3-*` and stopped by its own pid. The daemon consults only the compiled-in key list (`v2/core/src/release/trustedKeys.ts`, empty on this branch); the scratch build is this tree built in a throwaway worktree whose only difference is the scratch public key in that constant (`keyed-build.diff`), so the scratch key is compiled in exactly the way D2's keys will be. Steps: hello capability tags (79, `runtime.update.v1` present, no `update.reservation.*`), status on an empty root, 13 typed refusals with no version directory left behind, `hive runtime install` of the scratch release (87,711,810 bytes unpacked from a 22,260,559-byte tarball, tree digest byte-identical to the staged tree, `current` untouched), a quiet second install, idempotency-key replay, five seeded versions plus `current` and a deploy-history `previous`, `hive runtime prune 1` removing exactly the three unprotected ones, a quiet second prune, `hive runtime status` and `list`, the deleted `hive update-owner`, `hive deploy --artifact` and `update.*` verbs refusing, the audit rows `runtime.installed` / `runtime.pruned`, the daemon log, and timings.
- `envkey-lab.jsonl` / `envkey-lab.stdout.log`: `MODE=envkey`: the committed build (empty key list) started with `HIVE_TEST_RELEASE_KEYS=<scratch key>` in its environment. Nothing reads that variable: status reports 0 trusted keys, `hive runtime status` prints `keys 0 trusted`, and installing the scratch release is refused `runtime_refused` / `key_unknown` with no version directory created.
- `baseline-lab.jsonl` / `baseline-lab.stdout.log`: the same driver in `MODE=baseline` against a scratch hived built from origin/main 6000b313 (80 tags, both reservation tags, `runtime.status` unknown).
- `v2-check.log`, `build.log`: the pinned tsc over every v2 package and the build.
- `tests-cli-deploy.log` (73 pass on the rebased tree), `tests-daemon-gate.log` (19 pass, 1 fail), `tests-core-release.log` (50 pass, 1 fail): targeted suites under the warden with HIVE_* unset. The two failures (`release-settle`'s npm pack under npm 12; `confined-peer-rpc`'s unsandboxed Cell inside this Cell) fail identically on origin/main here: `baseline-origin-main-two-failures.log`.
- `keygen.mjs`, `sign.mjs`: the scratch key and descriptor tooling. The private key lived under the gitignored `.local/` and is not recorded anywhere; the throwaway keyed worktree was removed after the run.

Timings (scratch daemons on the same host, same session):

| measure | origin/main 6000b313 | this change |
|---|---|---|
| hello capability tags | 80 | 79 |
| `deployInfo` RPC p50 / max (50 calls) | 0.4 / 19 ms | 0.3 / 10.6 ms |
| `hive deploy-info --json` p50 (5 runs) | 68.9 ms | 71.8 ms |
| `runtime.status` RPC p50 / p95 (50 calls) | unknown verb | 1.0 / 1.1 ms |
| `hive runtime status --json` p50 (5 runs) | n/a | 71.3 ms |
| `hive runtime install` (22 MB tarball, 87.7 MB tree) | n/a (`--artifact` dead on every node) | 1585 ms |
| second install of the same bytes (verify, compare, quiet) | n/a | 2086 ms |
| `runtime.prune` of 3 versions | n/a | 66 ms |
| daemon boot to socket | 362 ms | 363 ms |

Rerun: build (`node scripts/build-v2-artifact.mjs` after the peercred and delivery-file scripts), build a keyed copy the same way in a worktree whose `trustedKeys.ts` lists the scratch public key, stage `dist`, `contracts`, `package.json` and `package-lock.json` with `npm ci --omit=dev`, stamp `dist/build-identity.json` release/dirty=false, tar the stage, `node --experimental-strip-types .proof/D3/keygen.mjs <key>`, `BUILD_IDENTITY_JSON=<stage>/dist/build-identity.json node --experimental-strip-types .proof/D3/sign.mjs <tarball> <key> <out>`, then `REPO=$PWD MODE=d3 CLI_DIST=<keyed worktree>/dist/cli.js ARCHIVE=<tarball> DESCRIPTOR=<out>.json SIGN_SCRIPT=.proof/D3/sign.mjs PRIVATE_KEY=<key> STAGE=<stage> node --experimental-strip-types .proof/D3/lab.mjs` with every HIVE_* variable unset; `MODE=envkey ENV_KEY_HEX=<pub hex>` with the committed `dist` for the ignored-variable case.
