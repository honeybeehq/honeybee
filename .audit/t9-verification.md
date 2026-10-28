# Vault isolation verification

Source head: 6299a0543842cb20dd9edac656f7ba352b3a40f3, based on origin/main d00025fb70681cd84a25433a32e5c10892e42db3.

All runs occurred on metal-2 in this task's Cell, with disposable HOME under .audit/test-home and corrected local Node identity. No deployment, service restart, live store query, or credential operation was performed.

Passed:

- npm run check (exit 0): check-final.log.
- npm run v2:check (exit 0): v2-check-final.log.
- npm run build (exit 0): build-final.log.
- Vault isolation, Node entry, config and service environment tests: 70 passed, zero failures: vault-fixture-final.log.
- Service unit tests: 12 passed; original socket isolation integration suite: 25 passed, zero failures: socket-fixture-final.log.

One reproducible fixture command on a Linux satellite after npm ci:

```sh
env -u HIVE_NODE_VERSION -u HIVE_NODE_SHA256 -u HIVE_V2_SOCKET_PATH -u HIVE_V2_VAULT_DIR HOME="$(mktemp -d /tmp/hb-t9-home-XXXXXX)" HIVE_NODE_PATH="$(readlink -f "$(command -v node)")" HIVE_NO_KEYCHAIN=1 node --test v2/daemon/tests/vault-isolation.test.ts v2/daemon/tests/node-pin-entry.test.ts v2/daemon/tests/config.test.ts v2/cli/tests/update-service.test.ts
```

Expect 70 passing tests, zero failures. Service ownership is mocked in these fixtures. The sentinel default vault under temporary HOME remains unchanged. Refused starts produce vault_root_required before startup writes; explicit flag/environment/config vaults pass resolution; the default service owner retains the default vault. The inherited socket never becomes a listen target.

Known unrelated failure: the shutdown suite waits for a fake bee to become idle and times out. Worker ee3a49d6 reproduced the same natural-mode timeout on unchanged origin/main d00025fb using a source archive inside its own Cell and corrected Node pin environment. No shutdown behavior was changed. The full daemon suite is not claimed green. See Project tasks/T9-fixture-evidence.md for the worker's baseline receipt.

Incident metadata is in t9-incident.md and Project tasks/T9-vault-incident.md. The key and directory remain untouched per Needle's 2026-10-28 07:44Z decision. Open follow-up: other existing custom-data-dir daemons may still share the default vault; creator attribution came from the incident brief. DEPLOY HOLD remains in force, so this change does not alter running daemons.

Cross-model incident audit: claude-opus-5-5, session 616a2d8d; retention sound, remaining limitations stated above. Repository verification skill was not installed; documented commands and isolated fixtures were used.
