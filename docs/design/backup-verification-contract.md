# Independent backup verification and recovery (B3)

B2 creates an encrypted snapshot and an unverified draft. B3 reads every selected
object back through restic decryption, checks the manifest, Git objects/refs/index,
SQLite checkpoints and declared transcript objects, then signs a receipt and stores
an encrypted recovery catalogue in the same repository. B4 alone authorizes eviction.
No service, schedule or production transfer is installed by this change.

## Authorities and commands

The uploading daemon never imports the verifier service or resolves its signing
key. It accepts only public-key-verified receipts through `cell.backup.receipt`
(`cell.backup.receipts.v1`, mutate) and thin CLI:

```sh
hive cell backup-accept receipt.json --json
```

`<dataDir>/backup-trust.json` contains `{"publicKeys":{"<key fingerprint>":"<SPKI DER base64>"}}`.
Missing/corrupt trust fails closed. Receipt acceptance is transactional, binds the
completed backup operation and exact machine/Cell/generation/repository/snapshot/
manifest path/hash, and quietly replays an already accepted receipt. The record
becomes `honeybee.backup-record.v2`, `verification: verified`, with its signed
receipt attached through existing cell_op audit and recovery paths.

A separately provisioned host runs the standalone `dist/v2/backup-verifier.js`:

```sh
node dist/v2/backup-verifier.js verify --config verifier.json --record draft.json --transcripts objects.json --output receipt.json
node dist/v2/backup-verifier.js restore --config recovery.json --generation operation-uuid
```

`--transcripts` is optional. Config shape (all values below are references/public):

```json
{
  "role": "independent-verifier",
  "access": {
    "machine": "source-node-id",
    "repository": "rest:https://backup.example.ts.net/source/",
    "passwordRef": "global/fleet-backup-source-repo-key",
    "credentialRef": "global/fleet-backup-source-reader"
  },
  "catalogueAccess": {
    "machine": "source-node-id",
    "repository": "rest:https://backup.example.ts.net/source/",
    "passwordRef": "global/fleet-backup-source-repo-key",
    "credentialRef": "global/fleet-backup-source-catalogue-writer"
  },
  "owner": {
    "stageRoot": "/private/recovery-stage",
    "maxRestoreBytes": 1073741824,
    "trustedPublicKey": "SPKI-DER-base64"
  },
  "authority": {
    "id": "independent-verifier-node-id",
    "signingKeyRef": "global/fleet-backup-verifier-primary"
  }
}
```

Recovery config uses `role: recovery`, access and owner only. Recovery requires
repository/password, read credential, generation and independently pinned public
key; it needs no Studio database, source filesystem, local draft or signing key.
The public key and generation are recovery bootstrap information, not secrets.

Hem grants are the real authority boundary: uploader gets only its writer and
repository key; verifier gets reader, catalogue-writer, repository key and
`signing_key_pkcs8_base64` from the verifier reference; recovery gets only reader
and repository key. Reader/writer credential objects have username/password;
repository key has password. The code refuses uploader `-writer` references in
verifier/readback paths, but cannot prove that operators provisioned separate Hem
principals, distinct HTTP grants or separate hosts. An authority id comparison is
only defense in depth. SX65/rest-server receives ciphertext and authentication,
never repository decryption or signing keys. Passwords travel in constrained child
environments through the B2 guard IPC, never argv, URLs or diagnostics. Deploy the
verifier separately; do not grant its Hem token to uploading machines.

## Readback and safe restoration

The manifest is itself fetched from the snapshot and checked against its SHA-256.
One bounded `restic dump --archive tar` reads the common captured subtree. The
parser writes regular bytes to opaque private filenames, never extracts paths,
and checks kinds, lengths, SHA-256, literal symlink targets and confined hardlinks.
Unknown/special entry kinds fail closed. Intermediate ancestor directories are
precomputed; there is no per-directory full-manifest scan. Restic 0.18.1 emits
short tar headers relative to the dumped root's parent and PAX names containing
the original absolute path without its initial slash. Both canonical forms are
mapped back to declared manifest paths. Traversal, absolute tar names, duplicate
paths and undeclared non-ancestor objects are refused.

Manifest paths must be canonical absolute source names inside the Cell checkout,
its derived keep root/ledger or capture scratch root. Checkout/keep roots must be
directories. No `.git` entry except the captured regular index is allowed. Parent
symlinks are refused. Fresh restore paths live below a verifier-created private
stage; the worktree is lstat/realpath checked before Git runs. Git starts with no
system/global config and controlled hooks/protocol settings, reconstructs refs
and objects, runs full fsck, validates index names, then installs the index last.
No restored config, hooks or alternates can steer verifier Git. SQLite validation
runs in a read-only child with trusted_schema off and cell_size_check on; it
compares integrity, schema version, DDL digest and full snapshot bytes.

Manifests support up to 1M entries but are bounded to 64 MiB; Git listings and
catalogue commands also have explicit output bounds. Restore budgets include tar
metadata, compressed/decoded transcript data and the Git checkout size. An oversized
capture fails closed; this is bounded support, not a fleet-scale throughput claim.
Restore returns a fresh stage for human/owner use and never replaces a live Cell.

## Receipt and independent catalogue

`v2/core/src/backupReceipt.ts` defines canonical sorted JSON and Ed25519 receipts.
The signed payload `honeybee.verified-backup.v1` binds machine, Cell, generation,
repository locator and authenticated config id, snapshot id, manifest path/hash,
file/byte totals, Git head/base, DB checkpoints, transcript descriptors, verifier
id/key fingerprint and verifiedAt. Signatures use canonical base64. The verifier
fetches the signing key only after full readback succeeds. A private WeakMap proof
binds a genuine immutable readback stage; a caller-created stage cannot request
signing authority. The daemon holds only pinned public keys.

An encrypted restic stdin snapshot stores `/honeybee-recovery-catalogue-v1.json`,
format `honeybee.recovery-catalogue.v1`, with the normalized B2 draft and signed
receipt. Tags are `honeybee-recovery-catalogue-v1` and that tag plus `:<generation>`.
Discovery checks the pinned key, repository id, machine and all record fields that
steer readback. Junk/invalid tagged snapshots are ignored. Valid receipts for the
same capture differing only in verifiedAt/signature converge deterministically on
the earliest time, with a canonical tie-break. Valid differing capture payloads
fail catalogue_conflict. Concurrent verification may append equivalent catalogues;
readers converge without permitting an uploader's junk tag to block publication.
The returned receipt is rediscovered from the published catalogue. During a race the reported catalogueSnapshot may identify an equivalent entry with another verification timestamp; both entries bind the same capture.

Catalogue retention and repository capacity/pruning remain B6 policy. The append-only
client never forgets/prunes/unlocks remote history. No eviction authority follows
from a B3 receipt without B4's gate and trust policy.

Accepted isolation limit: hostile zstd/JSON parsing and later signing-key resolution
share the verifier orchestration process. Git and SQLite run in constrained children;
a fresh isolated signing process is not implemented. Use a dedicated verifier host
and tightly scoped Hem principal. Independent public-key provisioning is mandatory.

## Apiary verified-stage handoff (B3a contract)

`VerifiedTranscriptObject` is `{sourcePath,ref,bytes,identity,summary}`. `ref` is
SHA-256 of compressed zstd bytes. Identity is `{nodeId,beeId,epoch,compat}`. Summary
is `{feedRows,segmentRows,expandedBytes,digest,lastLine,segmentSeq,segmentDigest}`.
The object must be a captured regular file with matching hash/length. Decoder
checks zstd expansion/window bounds, JSONL header version 1, node/bee/epoch,
feed-before-segment order, increasing feed line numbers, empty raw/events array,
row bee ids and trailer counts/digests. Expanded digest/bytes cover header and rows
including newline bytes, excluding trailer; segmentDigest covers segment lines.
Apiary's historical compat equality exception and optional trailer segmentDigest
are preserved; the independently recorded summary still pins segmentDigest. Header compat equality is not verified; the signed compat value is the catalogue descriptor supplied by the owner, preserving Apiary v1 behavior. Transcript descriptors are frozen at first verification; adding or changing them requires a new capture generation.

`handoffTranscriptStage(stage,receipt,objectRef,owner,accept?)` rechecks compressed
bytes and decodes again, then calls an Apiary-owned callback with:

```ts
{
  format: "honeybee.apiary-transcript-stage.v1",
  receipt: VerifiedBackupReceipt,
  object: VerifiedTranscriptObject,
  compressedPath: string,
  decodedPath: string
}
```

The callback must return `{accepted:true,ownerNodeId,objectRef,receiptId}` matching
the object's owner node and hash. Missing/refusing/mismatched owner fails
`owner_unavailable`; staging alone is never import success. The owner must copy or
consume the stage before acknowledging, revalidate its trust/identity and perform
its own transactional import. Honeybee does not write Apiary databases/blob stores.
Existing Apiary transcript.thaw cannot import arbitrary stage paths. B3a supplies
that authenticated owner command and adapter; no Apiary code changed in B3.

## Disposable verification

```sh
node scripts/verify-backup-verification.mjs
```

Requires Node with SQLite/zstd, local restic/rest-server (or HIVE_TEST_RESTIC and
HIVE_TEST_REST_SERVER executable paths). Three tests produce
`.audit/backup-b3/end-to-end.json` and a real loopback-only encrypted recovery drill.
The source is removed before verification, then uploader state/draft is removed
before catalogue recovery. Concurrent independent verifier processes sign through
fixture-only Hem grants. Wrong password, missing snapshot, corrupted ciphertext,
forged catalogue, writer grant, hostile Git/path manifests and missing transcript
owner fail closed. Both retained and stash-only recovery are exercised with their original Git origin removed. Recovered dirty/index bytes, modes, links, Git fsck, SQLite and
transcript digest agree. Diagnostics/records are checked for fixture repository,
HTTP and private signing credentials; uploaded application contents are not claimed
secret-free. Disposable fixtures are cleaned unless explicitly retained for review.
