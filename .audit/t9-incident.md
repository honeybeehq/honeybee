# T9 metal-2 vault incident

Decision: leave the key and directory untouched. Non-use cannot be established confidently under the authorized read-only limits. No trash operation was attempted.

Observed 2026-10-28 around 07:43 UTC:
- Real systemd unit dev.honeybee.hive.v2.service: active/running, MainPID 3167061; started 2026-10-27 17:15:19 UTC (ps and systemd agree).
- /home/trmd/.hive/vault/.credential-authorities: directory, inode 5395575, owner/group trmd (1001), mode 0700, size 4096. Birth 2026-10-28 06:27:07.030461746 UTC; mtime/ctime 06:27:07.042462056 UTC.
- handoff-signing-key.pem: regular file, inode 5395576, owner/group trmd (1001), mode 0600, size 119. Birth/mtime 2026-10-28 06:27:07.034461849 UTC; ctime 06:27:07.042462056 UTC; atime 06:27:07.042462056 UTC.
- Directory listing contains only that key. /proc/3167061/fd lists no open key or credential-authorities descriptor. stdout/stderr point to /home/trmd/.hive/v2/hived.log.
- Selected config fields only: accounts.vaultDir absent (implicit real default), socketPath absent (implicit default). No other config values printed.
- Daemon own log: zero references matching credential-authorities, handoff-signing-key, account.credentials.handoff, handoffIdentity, handoff-identity. Only counts emitted; no log payload printed.
- Read-only hive daemon status: running true, health pid 3167061, stopping false, tickErrors 0, daemonTarget connected true. hive v2 health unsupported by installed CLI; status used instead.

Source evidence: v2/daemon/src/credentialHandoff.ts constructor does not load a key. key() at lines 126-137 creates one only when absent, then reads any existing PEM on demand; publicKey()/signed() invoke it repeatedly. setIdentity pins node/device identity in the store, not the signing private key. Handoff bindings carry public keys. accountsService.ts constructs the handoff service at <vaultDir>/.credential-authorities; config.ts defaults vaultDir to ~/.hive/vault.

Consequences: an earlier daemon start does not prevent later adoption, and no open FD is expected after synchronous readFileSync. The current file would be selected on the next key-consuming operation if this implementation is active. No live-store rows were queried; schema/PRAGMA alone cannot prove absence of a historical handoff reference. No confidence claim of unused was made.

No key contents were read, printed, copied or hashed. No live-store access, restart, signal, deployment, provisioning, or credential copy occurred. The real daemon remains running with the same PID. Root fix is separate and remains under DEPLOY HOLD.

## Orchestrator decision

Needle, relayed by orchestrator ac05ab9c-2a8e-4e8a-bd7f-690609c67d82 at 2026-10-28 07:44 UTC:

> Needle decided (a), leave the key. It was generated on metal-2 into the real vault at 0600 with no copy kept elsewhere, so it's equivalent to a key hived would make itself, and rotating it would only break handoffs signed since 06:27.

This is the attributed operator decision. The metadata investigation above did not establish whether any handoffs were signed after 06:27. No rotation or removal is planned.

## Follow-up metadata and independent audit

The immutable deployed runtime artifact 8efa49a69218f927beffc074b0684187af7624ab1853055ee6a5a4eab0eb21da/dist/v2/cli.js was inspected as source code only. Its key() implementation matches the lazy existing-file read described above, confirming applicability to PID 3167061.

The vault filesystem reports ext4 with rw,relatime,stripe=256. The key atime equals ctime at creation. This supports no subsequent ordinary file read; noatime is absent. This is supporting timestamp evidence, not a claim that historical handoff/store references were inspected. Needle's explicit leave-in-place decision remains unchanged.

Read-only status repeated at about 07:48 UTC with bounded output: running true, pid 3167061, tickErrors 0, stopping false, connected true.

Independent cross-model audit: claude-opus-5-5 (session 616a2d8d) reviewed this report, the parent transcript, and source. Agreed retention is sound. Open limitations: the creating test process was supplied by the incident brief rather than independently attributed; other long-running custom-data-dir daemons were visible in ps, but their config/stores were outside this incident assessment. No claim is made that they never shared the default vault. Timestamps do not rule out a previous deleted/recreated directory. The audit's missed trail-row concerns were resolved by confirming the Needle decision and branch-base rows in .audit/t9.tsv; original detached head is retained/t9-project-base.

