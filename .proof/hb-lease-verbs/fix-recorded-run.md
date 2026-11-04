# hb-lease-fix recorded run 2026-11-04T12:30:53.055Z
three scratch daemons with local trust enabled: A (owner), B (target), C (CLI check)

## M3 caller gate
{
  "unregistered local client: grant": "caller_not_trusted (registration_required)",
  "unregistered local client: batch": "caller_not_trusted (registration_required)",
  "node_relay lane: grant": "caller_not_trusted",
  "remote lane: batch": "caller_not_trusted",
  "registered local authority: grant": "ok"
}

## M2 authority binding
{
  "foreign authorityNodeId": "invalid_request (authority_node_id)",
  "authorityNodeId = B's id (another node)": "invalid_request (authority_node_id)",
  "authorityNodeId = own store id": "ok",
  "authorityNodeId = own registered alias": "ok",
  "self grant to the registered alias": "invalid_request (self_grant)",
  "self grant to the store id": "invalid_request (self_grant)"
}

## L1 node-bound payloads
{
  "payload for B installed on B (registered alias)": "ok",
  "payload for B's store id installed on B": "ok",
  "payload for node-x installed on B": "account_lease_conflict (node_mismatch)",
  "payload for B installed on A (the owner)": "account_lease_conflict (node_mismatch)"
}

## M1 key binding
{
  "same key + same items": {
    "deduped": true,
    "okPattern": [
      true,
      true,
      false
    ],
    "sameWindows": [
      true,
      true,
      null
    ],
    "freshMaterial": true
  },
  "audit rows account.lease.granted before/after replay": {
    "before": 8,
    "after": 10,
    "replayRows": [
      "apiary-node-b:replay",
      "node-c:replay"
    ]
  },
  "same key + different items": "idempotency_conflict (items)",
  "same key + items reordered": "idempotency_conflict (items)",
  "same key + another verb": "idempotency_conflict"
}

## L3 receipt shape (secret-free)
{
  "principal": "1001:apiary-node-a",
  "itemsDigest": "37821b00917ce121…",
  "pending": false,
  "entries": 3
}

## L4 CLI stdout (redacted) vs --out file
{
  "stdout": {
    "materialWrittenTo": "/home/trmd/.hive/v2/tmp/2925010c-c1b3-40c7-b404-8ce3904fd83f/hb-v2-daemon-PpYvzs/material.json",
    "grant": {
      "account": "codex-lx",
      "harness": "codex",
      "nodeId": "node-b",
      "authorityNodeId": "4507d2ee-cf39-4034-8c95-14bccd68cd00",
      "shareId": "share-codex-lx",
      "epoch": 1,
      "ttlMs": 129600000,
      "grantedAt": 1793795454082,
      "expiresAt": 1793925054,
      "materialExpiresAt": 1794486653
    },
    "install": {
      "id": "codex-lx",
      "harness": "codex",
      "label": "lx",
      "shareId": "share-codex-lx",
      "authorityNodeId": "4507d2ee-cf39-4034-8c95-14bccd68cd00",
      "epoch": 1,
      "expiresAt": 1793925054,
      "files": "<secret material elided>",
      "nodeId": "node-b"
    },
    "kindNote": "codex: shipped access-token-only auth.json (refresh_token blanked), exp 2026-11-12T12:30:53.000Z",
    "daemonTarget": {
      "dataDir": "/home/trmd/.hive/v2/tmp/2925010c-c1b3-40c7-b404-8ce3904fd83f/hb-v2-daemon-PpYvzs",
      "dataDirSource": "flag",
      "socketPath": "/home/trmd/.hive/v2/tmp/2925010c-c1b3-40c7-b404-8ce3904fd83f/hb-v2-daemon-PpYvzs/hived.sock",
      "socketSource": "record",
      "instanceId": "7d8f3c9d-3832-4721-a75a-6374e813cae8",
      "daemonDataDir": "/home/trmd/.hive/v2/tmp/2925010c-c1b3-40c7-b404-8ce3904fd83f/hb-v2-daemon-PpYvzs",
      "connected": true
    }
  },
  "outMode": "600",
  "outHasMaterial": true
}

no refresh token or access token in any daemon's output; receipts and audit rows are secret-free
