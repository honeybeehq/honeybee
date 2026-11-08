# lease-enrolled-renewal recorded run (after the fix) 2026-11-08T17:12:15.077Z
capability account.lease.enrolled_renewal.v1 on the satellite: true

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
    "expiresAt": 1794287535,
    "revokedAt": null,
    "materialPublished": true,
    "enrolment": {
      "id": "633b7a22-f3aa-4dce-9599-5e91fe5cdf90",
      "at": 1794157935597,
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
    "expiresAt": 1794287535,
    "revokedAt": 1794157935606,
    "materialPublished": false,
    "enrolment": {
      "id": "633b7a22-f3aa-4dce-9599-5e91fe5cdf90",
      "at": 1794157935597,
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
  "outcome": "ok",
  "payload": {
    "shareId": "polytext-share-0001",
    "authorityNodeId": "apiary-studio",
    "epoch": 1,
    "nodeId": "apiary-mini",
    "files": "<secret material elided>"
  }
}
```

## 4. the row after the renewal
```json
{
  "id": "claude-polytext",
  "source": "leased",
  "status": "ok",
  "statusReason": "credentials restored",
  "shareId": "polytext-share-0001",
  "shareEpoch": 1,
  "leasedFrom": {
    "shareId": "polytext-share-0001",
    "authorityNodeId": "apiary-studio",
    "viaNodeId": "apiary-studio",
    "epoch": 1,
    "expiresAt": 1794287536,
    "revokedAt": null,
    "materialPublished": true,
    "enrolment": {
      "id": "633b7a22-f3aa-4dce-9599-5e91fe5cdf90",
      "at": 1794157935597,
      "liveRuntimeCoveragePending": 0
    },
    "installedFiles": [
      ".credentials.json"
    ]
  },
  "localMaterial": {
    "home": true,
    "vault": true,
    "profile": "{\"localProfile\":\"preserved\"}"
  }
}
```

hived.log on the satellite: account.lease.enrolment_republished account=claude-polytext enrolment=633b7a22-f3aa-4dce-9599-5e91fe5cdf90 authority=apiary-studio epoch=1 local_primary=absent

## 5. the next renewal and another foreign attempt
```json
{
  "sameAuthorityRenewal": "ok",
  "foreignAuthority": "account_lease_conflict: Lease origin conflicts with the installed lease.",
  "row": {
    "id": "claude-polytext",
    "source": "leased",
    "status": "ok",
    "statusReason": "credentials restored",
    "shareId": "polytext-share-0001",
    "shareEpoch": 1,
    "leasedFrom": {
      "shareId": "polytext-share-0001",
      "authorityNodeId": "apiary-studio",
      "viaNodeId": "apiary-studio",
      "epoch": 1,
      "expiresAt": 1794330736,
      "revokedAt": null,
      "materialPublished": true,
      "enrolment": {
        "id": "633b7a22-f3aa-4dce-9599-5e91fe5cdf90",
        "at": 1794157935597,
        "liveRuntimeCoveragePending": 0
      },
      "installedFiles": [
        ".credentials.json"
      ]
    }
  }
}
```

## 6. refusals kept on the republish path
```json
{
  "localRefreshChainPresent": "account_lease_enrol_refused (refresh_chain): Credential copy home/.credentials.json holds a refresh grant; enrolment leaves the account untouched.",
  "afterItIsGone": "ok",
  "row": {
    "id": "claude-polytext",
    "source": "leased",
    "status": "ok",
    "statusReason": "credentials restored",
    "shareId": "polytext-share-0001",
    "shareEpoch": 1,
    "leasedFrom": {
      "shareId": "polytext-share-0001",
      "authorityNodeId": "apiary-studio",
      "viaNodeId": "apiary-studio",
      "epoch": 1,
      "expiresAt": 1794503536,
      "revokedAt": null,
      "materialPublished": true,
      "enrolment": {
        "id": "633b7a22-f3aa-4dce-9599-5e91fe5cdf90",
        "at": 1794157935597,
        "liveRuntimeCoveragePending": 0
      },
      "installedFiles": [
        ".credentials.json"
      ]
    }
  }
}
```

## 7. install after lease.remove
```json
{
  "outcome": "ok",
  "row": {
    "id": "claude-polytext",
    "source": "leased",
    "status": "ok",
    "statusReason": "credentials restored",
    "shareId": "polytext-share-0001",
    "shareEpoch": 1,
    "leasedFrom": {
      "shareId": "polytext-share-0001",
      "authorityNodeId": "apiary-studio",
      "viaNodeId": "apiary-studio",
      "epoch": 1,
      "expiresAt": 1794589936,
      "revokedAt": null,
      "materialPublished": true,
      "enrolment": {
        "id": "633b7a22-f3aa-4dce-9599-5e91fe5cdf90",
        "at": 1794157935597,
        "liveRuntimeCoveragePending": 0
      },
      "installedFiles": [
        ".credentials.json"
      ]
    }
  }
}
```

node c5409791-0259-42b8-aec1-27474c889421 (the satellite) renewed its enrolled row from its authority; no foreign payload installed.
AFTER THE FIX: ALL CHECKS PASSED
no access or refresh token appears in any daemon's output
