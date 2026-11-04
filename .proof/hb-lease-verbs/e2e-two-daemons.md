# hb-lease-verbs end-to-end run 2026-11-04T11:15:00.946Z
owner daemon (node A) data dir: /home/trmd/.hive/v2/tmp/2925010c-c1b3-40c7-b404-8ce3904fd83f/hb-v2-daemon-0TChsh
target daemon (node B) data dir: /home/trmd/.hive/v2/tmp/2925010c-c1b3-40c7-b404-8ce3904fd83f/hb-v2-daemon-0e3xPw
node A advertises account.lease.grant.v1: true; node B: true

## A: account.lease.grant codex-lx → node-b (default window)
{
  "grant": {
    "account": "codex-lx",
    "harness": "codex",
    "nodeId": "node-b",
    "authorityNodeId": "42dee9c2-e556-4942-ba20-1127bbc91ed5",
    "shareId": "share-codex-lx",
    "epoch": 1,
    "ttlMs": 129600000,
    "grantedAt": 1793790902520,
    "expiresAt": 1793920502,
    "materialExpiresAt": 1794482102
  },
  "install": {
    "id": "codex-lx",
    "harness": "codex",
    "label": "lx",
    "shareId": "share-codex-lx",
    "authorityNodeId": "42dee9c2-e556-4942-ba20-1127bbc91ed5",
    "epoch": 1,
    "expiresAt": 1793920502,
    "files": "<secret material elided>"
  },
  "kindNote": "codex: shipped access-token-only auth.json (refresh_token blanked), exp 2026-11-12T11:15:02.000Z"
}

## B: account.lease.install (payload from A)
{
  "account": "codex-lx@share-co",
  "source": "leased",
  "status": "ok",
  "leasedFrom": {
    "shareId": "share-codex-lx",
    "authorityNodeId": "42dee9c2-e556-4942-ba20-1127bbc91ed5",
    "epoch": 1,
    "expiresAt": 1793920502,
    "adoptedAt": null,
    "revokedAt": null
  }
}

## B: renew = install again with the later window
{
  "expiresAt": 1793963702
}
B: a shorter window at the same epoch is refused account_lease_conflict (a lease window never regresses)

## A: typed refusals
{
  "unknown account": "account_not_found",
  "harness without a lease strategy": "lease_unsupported",
  "self grant": "invalid_request (self_grant)",
  "bad window": "invalid_request (ttl)",
  "bad share": "invalid_request (share_id)",
  "grant from a node that only holds a leased copy": "account_leased",
  "paused account": "account_paused"
}

## A: account.lease.batch (4 grants, one key)
{
  "results": [
    {
      "index": 0,
      "op": "grant",
      "id": "codex-lx",
      "nodeId": "node-b",
      "ok": true,
      "result": {
        "grant": {
          "account": "codex-lx",
          "harness": "codex",
          "nodeId": "node-b",
          "authorityNodeId": "42dee9c2-e556-4942-ba20-1127bbc91ed5",
          "shareId": "share-codex-lx",
          "epoch": 1,
          "ttlMs": 259200000,
          "grantedAt": 1793790902766,
          "expiresAt": 1794050102,
          "materialExpiresAt": 1794482102
        },
        "install": {
          "id": "codex-lx",
          "harness": "codex",
          "label": "lx",
          "shareId": "share-codex-lx",
          "authorityNodeId": "42dee9c2-e556-4942-ba20-1127bbc91ed5",
          "epoch": 1,
          "expiresAt": 1794050102,
          "files": "<secret material elided>"
        },
        "kindNote": "codex: shipped access-token-only auth.json (refresh_token blanked), exp 2026-11-12T11:15:02.000Z"
      }
    },
    {
      "index": 1,
      "op": "grant",
      "id": "codex-lx",
      "nodeId": "node-c",
      "ok": true,
      "result": {
        "grant": {
          "account": "codex-lx",
          "harness": "codex",
          "nodeId": "node-c",
          "authorityNodeId": "42dee9c2-e556-4942-ba20-1127bbc91ed5",
          "shareId": "share-codex-lx",
          "epoch": 1,
          "ttlMs": 259200000,
          "grantedAt": 1793790902766,
          "expiresAt": 1794050102,
          "materialExpiresAt": 1794482102
        },
        "install": {
          "id": "codex-lx",
          "harness": "codex",
          "label": "lx",
          "shareId": "share-codex-lx",
          "authorityNodeId": "42dee9c2-e556-4942-ba20-1127bbc91ed5",
          "epoch": 1,
          "expiresAt": 1794050102,
          "files": "<secret material elided>"
        },
        "kindNote": "codex: shipped access-token-only auth.json (refresh_token blanked), exp 2026-11-12T11:15:02.000Z"
      }
    },
    {
      "index": 2,
      "op": "grant",
      "id": "stub-s",
      "nodeId": "node-b",
      "ok": false,
      "error": {
        "code": "lease_unsupported",
        "message": "harness \"stub\" has no credential-lease strategy (supported: claude, codex, grok, kimi, muse, opencode)"
      }
    },
    {
      "index": 3,
      "op": "grant",
      "id": "nope",
      "nodeId": "node-b",
      "ok": false,
      "error": {
        "code": "account_not_found",
        "message": "account not found: nope"
      }
    }
  ],
  "counts": {
    "ok": 2,
    "failed": 2
  }
}

## A: same key replayed
{
  "deduped": true,
  "counts": {
    "ok": 2,
    "failed": 2
  },
  "sameWindows": [
    true,
    true,
    null,
    null
  ]
}

## B: account.lease.batch (installs from the grants)
{
  "counts": {
    "ok": 2,
    "failed": 0
  },
  "ops": [
    "install:codex-lx@share-co:true",
    "install:codex-lx@share-co:true"
  ]
}

## B: account.lease.batch (release)
{
  "results": [
    {
      "index": 0,
      "op": "release",
      "id": "codex-lx@share-co",
      "ok": true,
      "result": {
        "id": "codex-lx@share-co",
        "removed": false,
        "revokedAt": 1793790902861,
        "keychainRemoved": false,
        "nativeBackupKept": false,
        "disposition": "revoked",
        "nativeChain": {
          "account": "codex-lx@share-co",
          "present": false,
          "discarded": false
        },
        "message": "Lease material for codex-lx@share-co was revoked."
      }
    },
    {
      "index": 1,
      "op": "release",
      "id": "absent-account",
      "ok": true,
      "result": {
        "id": "absent-account",
        "removed": false,
        "revokedAt": null,
        "keychainRemoved": false,
        "nativeBackupKept": false,
        "disposition": "absent",
        "nativeChain": {
          "account": "absent-account",
          "present": false,
          "discarded": false
        },
        "message": "Account absent-account is absent."
      }
    }
  ],
  "counts": {
    "ok": 2,
    "failed": 0
  }
}

## move: release on the old node, grant for the new node, install there (B stands in for node-c)
{
  "account": "codex-lx@share-co",
  "source": "leased",
  "revokedAt": null,
  "expiresAt": 1794136502
}
B: node_relay ingress — forwarded-fence/enrol and native-discard items are refused local_required; a plain install item is admitted
A: a client whose hello lacks account.lease.grant.v1 still runs account.list and account.lease unchanged

## CLI: hive account lease grant codex-lx --node node-b --share share-codex-lx --epoch 1 --ttl-ms 7200000 --json
{
  "account": "codex-lx",
  "harness": "codex",
  "nodeId": "node-b",
  "authorityNodeId": "42dee9c2-e556-4942-ba20-1127bbc91ed5",
  "shareId": "share-codex-lx",
  "epoch": 1,
  "ttlMs": 7200000,
  "grantedAt": 1793790903022,
  "expiresAt": 1793798103,
  "materialExpiresAt": 1794482102
}

## CLI: hive account lease batch --file items.json --idempotency-key cli-batch-1 --json
{
  "counts": {
    "ok": 1,
    "failed": 0
  }
}

## A: audit rows account.lease.granted (secret-free)
[
  {
    "account": "codex-lx",
    "harness": "codex",
    "nodeId": "node-b",
    "authorityNodeId": "42dee9c2-e556-4942-ba20-1127bbc91ed5",
    "shareId": "share-codex-lx",
    "epoch": 1,
    "ttlMs": 129600000,
    "grantedAt": 1793790902520,
    "expiresAt": 1793920502,
    "materialExpiresAt": 1794482102,
    "fileCount": 1,
    "rpcCaller": {
      "transport": "local_unix",
      "ingress": "local_unix",
      "uid": 1001,
      "pid": 1427074,
      "verb": "account.lease.grant"
    }
  },
  {
    "account": "codex-lx",
    "harness": "codex",
    "nodeId": "node-b",
    "authorityNodeId": "42dee9c2-e556-4942-ba20-1127bbc91ed5",
    "shareId": "share-codex-lx",
    "epoch": 1,
    "ttlMs": 172800000,
    "grantedAt": 1793790902572,
    "expiresAt": 1793963702,
    "materialExpiresAt": 1794482102,
    "fileCount": 1,
    "rpcCaller": {
      "transport": "local_unix",
      "ingress": "local_unix",
      "uid": 1001,
      "pid": 1427074,
      "verb": "account.lease.grant"
    }
  },
  {
    "account": "codex-lx",
    "harness": "codex",
    "nodeId": "node-b",
    "authorityNodeId": "42dee9c2-e556-4942-ba20-1127bbc91ed5",
    "shareId": "share-codex-lx",
    "epoch": 1,
    "ttlMs": 3600000,
    "grantedAt": 1793790902612,
    "expiresAt": 1793794502,
    "materialExpiresAt": 1794482102,
    "fileCount": 1,
    "rpcCaller": {
      "transport": "local_unix",
      "ingress": "local_unix",
      "uid": 1001,
      "pid": 1427074,
      "verb": "account.lease.grant"
    }
  },
  {
    "account": "codex-lx",
    "harness": "codex",
    "nodeId": "node-b",
    "authorityNodeId": "42dee9c2-e556-4942-ba20-1127bbc91ed5",
    "shareId": "share-codex-lx",
    "epoch": 1,
    "ttlMs": 259200000,
    "grantedAt": 1793790902766,
    "expiresAt": 1794050102,
    "materialExpiresAt": 1794482102,
    "fileCount": 1,
    "rpcCaller": {
      "transport": "local_unix",
      "ingress": "local_unix",
      "uid": 1001,
      "pid": 1427074,
      "verb": "account.lease.batch"
    }
  },
  {
    "account": "codex-lx",
    "harness": "codex",
    "nodeId": "node-c",
    "authorityNodeId": "42dee9c2-e556-4942-ba20-1127bbc91ed5",
    "shareId": "share-codex-lx",
    "epoch": 1,
    "ttlMs": 259200000,
    "grantedAt": 1793790902766,
    "expiresAt": 1794050102,
    "materialExpiresAt": 1794482102,
    "fileCount": 1,
    "rpcCaller": {
      "transport": "local_unix",
      "ingress": "local_unix",
      "uid": 1001,
      "pid": 1427074,
      "verb": "account.lease.batch"
    }
  },
  {
    "account": "codex-lx",
    "harness": "codex",
    "nodeId": "node-c",
    "authorityNodeId": "42dee9c2-e556-4942-ba20-1127bbc91ed5",
    "shareId": "share-codex-lx",
    "epoch": 1,
    "ttlMs": 345600000,
    "grantedAt": 1793790902902,
    "expiresAt": 1794136502,
    "materialExpiresAt": 1794482102,
    "fileCount": 1,
    "rpcCaller": {
      "transport": "local_unix",
      "ingress": "local_unix",
      "uid": 1001,
      "pid": 1427074,
      "verb": "account.lease.grant"
    }
  },
  {
    "account": "codex-lx",
    "harness": "codex",
    "nodeId": "node-b",
    "authorityNodeId": "42dee9c2-e556-4942-ba20-1127bbc91ed5",
    "shareId": "share-codex-lx",
    "epoch": 1,
    "ttlMs": 7200000,
    "grantedAt": 1793790903022,
    "expiresAt": 1793798103,
    "materialExpiresAt": 1794482102,
    "fileCount": 1,
    "rpcCaller": {
      "transport": "local_unix",
      "ingress": "local_unix",
      "uid": 1001,
      "pid": 1427074,
      "verb": "account.lease.grant"
    }
  },
  {
    "account": "codex-lx",
    "harness": "codex",
    "nodeId": "node-d",
    "authorityNodeId": "42dee9c2-e556-4942-ba20-1127bbc91ed5",
    "shareId": "share-codex-lx",
    "epoch": 1,
    "ttlMs": 129600000,
    "grantedAt": 1793790903041,
    "expiresAt": 1793920503,
    "materialExpiresAt": 1794482102,
    "fileCount": 1,
    "rpcCaller": {
      "transport": "local_unix",
      "ingress": "local_unix",
      "uid": 1001,
      "pid": 1427074,
      "verb": "account.lease.batch"
    }
  }
]

no refresh token, access token or payload bytes in the audit stream, daemon output, or the rpc_idempotency receipts of either node
