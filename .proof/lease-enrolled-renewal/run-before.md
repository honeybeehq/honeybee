# lease-enrolled-renewal recorded run (before the fix) 2026-11-08T17:12:31.509Z
capability account.lease.enrolled_renewal.v1 on the satellite: false

## 1. satellite row after the old-scheme enrolment
```json
{
  "id": "claude-polytext",
  "source": "leased",
  "status": "ok",
  "statusReason": null,
  "shareId": "polytext-share-0001",
  "shareEpoch": 1,
  "leasedFrom": {
    "shareId": "polytext-share-0001",
    "authorityNodeId": "apiary-studio",
    "viaNodeId": "apiary-studio",
    "epoch": 1,
    "expiresAt": 1794287552,
    "revokedAt": null,
    "materialPublished": true,
    "enrolment": {
      "id": "989f7fe0-6846-4350-8156-d5ac17f4d6ff",
      "at": 1794157952057,
      "liveRuntimeCoveragePending": 0
    },
    "installedFiles": [
      ".credentials.json"
    ]
  }
}
```

## 2. satellite row as mini06 held it: revoked, publication unknown, local material gone
```json
{
  "id": "claude-polytext",
  "source": "leased",
  "status": "auth_needed",
  "statusReason": "Lease revoked; request renewal from apiary-studio.",
  "shareId": "polytext-share-0001",
  "shareEpoch": 1,
  "leasedFrom": {
    "shareId": "polytext-share-0001",
    "authorityNodeId": "apiary-studio",
    "viaNodeId": "apiary-studio",
    "epoch": 1,
    "expiresAt": 1794287552,
    "revokedAt": 1794157952064,
    "materialPublished": false,
    "enrolment": {
      "id": "989f7fe0-6846-4350-8156-d5ac17f4d6ff",
      "at": 1794157952057,
      "liveRuntimeCoveragePending": 0
    },
    "installedFiles": [
      ".credentials.json"
    ]
  },
  "localMaterial": {
    "home": false,
    "vault": false,
    "profile": true
  }
}
```

foreign authority (apiary-foreign) at the same share and epoch: account_lease_conflict: Lease origin conflicts with the installed lease.

## 3. same-authority renewal into the stuck row
```json
{
  "outcome": "account_lease_enrol_refused (unknown_material): No existing access-only primary credential can be proved; enrolment does not create a native account.",
  "payload": {
    "shareId": "polytext-share-0001",
    "authorityNodeId": "apiary-studio",
    "epoch": 1,
    "nodeId": "apiary-mini",
    "files": "<secret material elided>"
  }
}
```

## 4. the row stays stuck
```json
{
  "id": "claude-polytext",
  "source": "leased",
  "status": "auth_needed",
  "statusReason": "Lease revoked; request renewal from apiary-studio.",
  "shareId": "polytext-share-0001",
  "shareEpoch": 1,
  "leasedFrom": {
    "shareId": "polytext-share-0001",
    "authorityNodeId": "apiary-studio",
    "viaNodeId": "apiary-studio",
    "epoch": 1,
    "expiresAt": 1794287552,
    "revokedAt": 1794157952064,
    "materialPublished": false,
    "enrolment": {
      "id": "989f7fe0-6846-4350-8156-d5ac17f4d6ff",
      "at": 1794157952057,
      "liveRuntimeCoveragePending": 0
    },
    "installedFiles": [
      ".credentials.json"
    ]
  }
}
```

BEFORE THE FIX: the authority's renewal is refused for the enrolled row; Apiary retries it forever.
no access or refresh token appears in any daemon's output
