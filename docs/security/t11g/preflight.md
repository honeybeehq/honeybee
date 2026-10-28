# Reviewed host-side preflight design

Do not run until Quiet reviews the exact script commit and the operator authorizes that node. This script has not been run on live nodes. Use a host-side checkout at the reviewed SHA; do not run from a Cell or register a Cell as operator. Failure of account.list admission is a node FAIL, never a reason to tunnel or loosen policy.

Exact command template, after verifying that checkout's HEAD matches the reviewed SHA:

```
node /absolute/reviewed-checkout/scripts/preflight-cell-codex.mjs --data-dir /absolute/node-data-dir --authority-node FULL_STUDIO_NODE_UUID
```

Use the full issuing node UUID from the authorized inventory, whose prefix is 92b40d08. The script requires exact UUID equality; it does not accept a prefix or guess the rest. Node dataDir is an explicit operator-supplied local path, never inferred from another checkout.

The script invokes that same checkout's source CLI for `account list --harness codex --json`. It captures the redacted metadata internally and validates every returned account: harness codex, source leased, exact Studio authority UUID, materialPublished true, status ok, not revoked, and a future finite lease expiry. It then calls the reviewed readAccessOnlyCodex on installed auth.json and .codex/auth.json if present. The read occurs inside this reviewed repository script, not in the agent's context. Raw documents, buffers and metadata responses are never printed or saved. Native/full/null-refresh/unproven credentials fail. Home and mirror-directory symlinks fail. No new package, gateway verb, token action or registration is used.

Stdout is JSON Lines, exactly three fields per account:

```
{"id":"codex-account-id","source":"leased","result":"PASS"}
```

Source is leased, local or unknown; result is PASS or FAIL. No bytes, digests, token fields, home paths or authority fields are output. Any FAIL exits 1 and stops the node. Metadata/CLI failure exits 1 without forwarding stdout/stderr. No accounts returns no rows and exit 0; it authorizes no Codex Cell placement. Unexpected inputs also fail closed.

A successful preflight is only one gate. The first actual Cell must produce a host prepared/mounted receipt and a separately labelled Cell-controlled authentication hint. Any auth_needed during the rollout means stop and roll back. Existing T11 per-node gates and exclusions remain binding. The script's commit SHA is supplied in the source-review handoff, not self-embedded.
