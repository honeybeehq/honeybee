# CI-only repair of the macOS gate change

This revises proof-15025dfc0445af9a0ae978dce440d6d4 after exact-head Linux CI run 42486756515 exposed two teardown failures introduced by a36511e4. No production source or confinement assertion changes.

The new survivor-ownership recovery wait queried RPC even when the fixture had no runner hosts. The strict-host test intentionally refuses that caller. Another test removed its directory in an earlier FIFO cleanup hook, so the later RPC connection saw ENOENT. Teardown now skips ownership RPC only when its initial host scan is empty and readable; live hosts, unreadable/torn receipts and directory errors retain the existing recovery wait. The affected test closes its client, awaits daemon stop, then removes its directory through one cleanup hook registered before acquisition.

The new no-host regression poisons the RPC client factory. It fails with the old unconditional RPC path and passes with the repair. Survivor adoption, torn receipt and never-release regressions still run; the strict four-second reap postcondition, native identity fences and emergency cleanup remain unchanged.

## Verification

Authenticated worker 58fd3c0b-f5a0-482d-b5f8-bccbb4fc319c executed on Linux trmd-metal-2, Debian kernel 6.12.94, x86_64, Node v24.18.0. Clean a365 reproduced exactly the reported ENOENT and confined_peer_refused failures (4 pass, 2 fail); parent 077d4519 passed all six tests using the same native build (production source unchanged between those revisions). The exact supplied three-file patch passed confined-peer 6/6, teardown 7/7 and quiet-RPC 3/3. Both original failures passed three more repetitions, 2/2 each. No skips or cancellations; real unshare tests ran. Native Linux typecheck and build passed. The worker committed nothing.

Local macOS typecheck/build passed, and all seven teardown plus three quiet-RPC cases passed. The poisoned-client regression was observed red before applying the helper fix. The earlier two complete stressed macOS suites validate base a365 only; they were not rerun for this CI-only repair. The original full-run checker intentionally remains bound to its original source manifest and is not a checker for this revision.

Linux commands use isolated HOME/XDG/HIVE paths under /tmp/hb-ci-58fd, HIVE_NO_KEYCHAIN=1 and offline npm. Inherited HIVE_NODE_VERSION/HIVE_NODE_SHA256 were unset along with HIVE_NODE_PATH/HIVE_V2_DATA_DIR/HIVE_V2_SOCKET_PATH/HIVE_GATEWAYS_DISABLE so each fixture owns its native Node identity. An initial attempt with inherited pin drift is a setup diagnostic, not CI reproduction. No live daemon was used.

## Attention

The first empty host scan is a point-in-time observation, not an atomic process census. Existing owned-runtime disposal and the strict final fresh scan remain; no surviving-host check is waived. Static review of the exact patch found no Medium-or-higher issue. The Linux worker independently ran the tests but applied the author's supplied patch. Cross-model trail review was unavailable under the requested codex/gpt-6.1-sol worker restriction.

Original proof limitations remain, including unknown historical macOS trigger and release-only driver2 failures. A targeted Linux pass does not establish a new whole-suite or exact-head CI pass. No deployment was performed.
