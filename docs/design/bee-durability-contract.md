# Bee durability — Honeybee contract (H6a, 2026-10-30)

Plan and decisions: `bee-durability-plan.md`. This file is the wire and storage contract for what is built.

## H6a — resume bundles

Flag `durability.resumeBundle.enabled` (default `false`). Keys under `durability.resumeBundle`: `keyFile` (default `<data-dir>/keys/resume-bundle.key`; a 32-byte key as 64 hex chars, mode 0600; minted at boot when absent and logged `durability.resume_bundle.key_created`; the Home provisions the same key onto every executor of a workspace), `keep` (default 5, pointer rows kept per bee).

**What is bundled.** At every turn end and runtime exit of a bee with a recorded `providerSessionId`, debounced per bee (one bundle per minute, trailing coalesce, a request during a bundle reruns once), the harness-native conversation state, opaque:

| harness (adapter) | root | paths |
|---|---|---|
| claude | the account home (`HOME_ENV`, else the account row's `homePath`) | `projects/<claudeProjectKey(cwd)>/<sessionId>.jsonl` and the sibling `<sessionId>/` directory when present |
| codex | the account home | the rollout file the thread index (`state_5.sqlite`) names for the thread id |
| stub (tests) | the account home, else the bee cwd | `projects/<claudeProjectKey(cwd)>/<sessionId>.json` |
| others | — | no bundle; `bee.resume.push_skipped reason=no_state`; the H6c re-seed is the fallback |

Credential files beside the state (`.claude/.credentials.json`, `.claude.json`, `.codex/auth.json`) are never in the path list.

**Object.** `tar -cf -` of the paths relative to the root, zstd level 3, then `chacha20-poly1305` with a per-bundle key `HKDF-SHA256(workspaceKey, salt, "honeybee-resume-bundle-v1")`, random 16-byte salt and 12-byte nonce, the bee id as associated data. Layout `hbrb1 | salt | nonce | ciphertext | tag`; the ref is the sha256 of the whole object; written temp-then-rename to `<transcripts.segments.storeDir>/blobs/resume-bundles/<ref>`. Nothing in the object is readable without the key, including file names. The walk, tar, compression and encryption run in the transcript segment worker.

**Pointer row** `bee_resume_bundles { id, bee_id, generation, harness, provider_session_id, cwd, state_key, scope, ref, digest, bytes, size, files, closed_at, epoch }` (schema v55, additive; `bee_epochs { bee_id, epoch, fenced_at }` beside it for H6b). `digest` is the sha256 of the plaintext tar: an unchanged state produces no new row and the duplicate object is removed (`bee.resume.unchanged`). `scope` is the account scope the bundle was taken under (claude `org:<organizationUuid>` else `account:<accountUuid>` from the home's `.claude.json`; codex `account:<account_id>` from `auth.json`; null when unknown). `epoch` is the bee's current epoch (0 until a takeover). On insert, rows beyond `keep` are deleted oldest first; their objects are reclaimed by the daily sweep (unreferenced objects older than an hour, the same tick as transcript and home objects). A fenced bee (`bee_epochs.fenced_at`) stops bundling.

**Surfaces.** Capability `bee.resume_bundle.v1`; read verb `bee.resumeBundles {beeId}` → `{beeId, epoch: {beeId, epoch, fencedAt}, bundles[]}` (newest first, 100); `deployInfo.resumeBundles {enabled, keyFile, keyPresent, store, bees, bundles, bytes, objects}`; informational audit rows `bee_resume_bundle.put {bundle}` and `bee.epoch {beeId, epoch, fencedAt}` for the Home to mirror as pointers. Log lines: `bee.resume.pushed|unchanged|push_skipped|push_failed`, `bee.resume.objects`.

**Measured** (`.proof/h-track/h6/`): a 62.8 MB claude session file bundles to 20.1 MB in 0.35 s and restores in 0.39 s; a 5.8 MB codex rollout to 1.9 MB in 47 ms; v55 on a copy of the live store adds two empty tables in milliseconds (the 16 s open is the backup copy plus the v52–v54 steps).

**Rollback.** Flag off: no bundles, no rows, the key file stays. A v55 store refuses to open under a pre-v55 release; `hive deploy --rollback` restores the backup the open path made.
