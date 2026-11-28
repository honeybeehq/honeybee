# Accounts

This is the current guide to accounts in Honeybee v2: what an account is, how to
add one and sign in, what differs per harness, how accounts are leased to other
nodes, and what the refusals mean. `hive account` with no arguments prints the
full usage line for every subcommand.

## What an account is

An account is one provider identity for one harness, for example a Claude
subscription, an OpenAI API key for Codex, or a Google sign-in for agy. It is
held by the node's daemon:

- **Home.** Each account has its own home directory. Honeybee runs the harness
  with that home, so two accounts of the same harness never share a sign-in.
- **Vault.** The daemon keeps a copy of the account's credential in the vault
  (`~/.hive/vault`). Activation installs it into the home before a runtime
  starts. The vault is local only and is never synced.
- **Status.** `hive account list` shows each account's status (`ok`,
  `auth_needed` or `paused`) and its credential health,
  `creds=absent|unverified|verified`. An account is never `ok` without a
  credential.

A bee spawned with `--account <selector>`, `--account auto` or `--account rr`
(or the `claude-auto` / `codex-rr` shorthand) runs on one account. An account
selector is the account id or its label.

## Adding an account and signing in

```sh
hive account add <harness> <label> [--import-existing]
hive account add <harness> --native [label]
hive account import <harness> [--label l]
hive account login <selector> [--method <id>] [--remote] [--no-wait] [--replace-account]
hive account login-status <selector>
hive account login-cancel <selector>
hive account capture <selector> [--replace-account]
hive account verify <selector>
```

`hive login <account>` is an alias of `hive account login`.

### Add

`add` creates a logged-out account: status `auth_needed`, `creds=absent`. Sign in
next with `login`.

`--import-existing` imports the machine's existing sign-in instead. It looks in
the account home or a leftover vault entry first. Then it looks in the harness's
own home: `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and so on when set, else `~/.codex`,
`~/.claude` and so on. For Claude on macOS it reads the Keychain item. When
nothing can be imported, `add` is refused with `no_credentials_to_import`, which
names every path it checked, and no account is created.

An imported credential is `unverified` until something proves it. The daemon
runs the harness's real probe right away. `verify` runs it on demand: it exits 0
only when the provider answered an authenticated read. If the probe reports
`auth_needed`, log in again.

`add <harness> --native` and `account import <harness>` adopt this computer's
own harness login as the node's native account. Honeybee does not copy or change
that login, and it stays signed in.

### Log in

`login` runs a sign-in flow that the daemon owns. The daemon either talks to the
provider directly or runs the vendor's CLI in its own worker. There is no tmux
seat to attach to. The command prints the method, the sign-in URL, any device
code and the fields it needs. On a TTY it then drives the flow: you open the URL
in your browser and type secrets without echo. It exits 0 once the credential is
validated and captured.

- `--method <id>` picks one of the harness's methods (see
  [Per-harness notes](#per-harness-notes)). `login-status` and
  `hive account get <selector>` list the flow's other methods.
- `--remote` picks a method that does not need a browser on this node, such as
  a device code or an API key.
- `--no-wait` starts the flow and returns. Use `login-status` to follow it and
  `login-cancel` to stop it.

### Capture

`capture` is the recovery path when the sign-in already completed outside a flow.
It validates the credential that is current right now, saves it to the vault and
marks the account `ok`. For Claude and Cursor it reads the provider's own store
when that store exists. For the other harnesses it reads the account home.

### `--replace-account`

Login and capture refuse a credential that belongs to a different user than the
one the account holds. The refusal reason is `different_account`. When Honeybee
cannot tell which user the credential belongs to, the reason is
`identity_unverified`. Nothing changes in either case. Pass `--replace-account`
to take the new credential anyway. This check applies to Cursor accounts and to
accounts under central credential ownership (see
[Credential status](#credential-status-and-central-ownership)).

## Per-harness notes

### Claude

- One method: `claude-oauth`. Approve access in your browser, then paste the
  code it shows. This works from a browser on another computer.
- On macOS the credential lives in the Keychain item for the account home. The
  vault keeps it as `.credentials.json`.
- `hive account credentials …` can make Honeybee the sole owner of the
  account's refresh token (see
  [Credential status](#credential-status-and-central-ownership)). A centrally
  managed Claude account logs in again in place, without stopping its bees.
- `hive swap-account <bee> <account>` moves a Claude bee to another Claude
  account. The bee resumes under a new session id
  (`--resume <seed> --fork-session`) in the destination home. The swap first
  copies the conversation (`projects/<cwd-key>/<seed>.jsonl` and its sibling
  `<seed>/` directory) into the destination home, and never overwrites a copy
  that is already there. When no transcript exists for the seed, the swap is
  refused with `transcript_unavailable` and the bee stays on its current
  account.

### Codex

- `codex-browser` (the default): sign in with ChatGPT. `codex login` waits for
  the callback on localhost, so the browser must run on this node.
- `codex-device` (the default with `--remote`): open the sign-in page anywhere
  and enter the code shown.
- `codex-api-key`: paste an OpenAI API key. It is checked against the API before
  it is saved.
- Central ownership is supported. To recover a centrally managed Codex account,
  run `credentials disable`, log in natively, then run `credentials enable`.
- `swap-account` carries the Codex conversation too. It is refused with
  `transcript_unavailable` when the conversation cannot be carried.

```sh
hive login codex-work --method codex-api-key
hive login codex-work --remote        # device code instead of the localhost callback
```

### Cursor

- One method: `cursor-browser`. Approve access in your browser; Cursor finishes
  the sign-in by itself, so a remote browser works. The flow runs Cursor's own
  `agent login` (or `cursor-agent`).
- Cursor keeps one machine-wide login: the macOS Keychain, or a global
  `auth.json`. A login or capture therefore takes whatever Cursor is signed in
  as on this computer. It refuses a different Cursor user than the account
  holds, or a user already held by another local Cursor account. Use
  `--replace-account` to take it anyway.
- Login and capture also refuse, with `credential_stale`, a sign-in that is
  past its expiry or that Cursor just rejected with HTTP 401. Sign in to Cursor
  again, then run `hive account login`.
- Honeybee never refreshes a Cursor token itself. Shortly before a token
  expires, or after a 401, the node that owns the account re-reads Cursor's own
  login on this computer and takes it if it is the same user and a newer token
  ([ADR 004](adr/004-cursor-recapture-machine-login.md)).
- Every runtime that gets a Honeybee Cursor token runs with
  `AGENT_CLI_CREDENTIAL_STORE=memory`, so it cannot overwrite or clear the
  machine's login. A spawn that passes a token needs Cursor agent CLI 2026.06.02
  or newer.
- Leases to other nodes carry the access token only. A leased Cursor account
  never reads the satellite's own Cursor login and cannot log in or capture
  there.

### agy (Google Antigravity CLI)

Each agy account keeps its sign-in in its own home. Honeybee runs agy with
`HOME=<account home>` and `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1`, so agy writes
its login to `.gemini/antigravity-cli/` in that home. Without this, agy would use
one macOS Keychain item for every sign-in. The four methods are agy's own ACP
auth methods:

- `oauth-personal` (the default, "Sign in with Google") and `oauth-business`
  ("Sign in with Gemini Enterprise") run `agy acp --login`. Paste the code
  Google shows. Both work from a remote browser.
- `gemini-api-key` takes a Gemini Developer API key. It is checked against the
  Gemini API before it is saved.
- `agent-platform` takes a Google Cloud project, a location and a service
  account key (Vertex AI / Application Default Credentials).

`.gemini/antigravity-cli/honeybee-auth.json` names the account's method. An API
key or Agent Platform account reaches agy only as runtime environment
(`HIVE_AGY_AUTH_METHOD`, `GEMINI_API_KEY`, `GOOGLE_CLOUD_PROJECT`,
`GOOGLE_CLOUD_LOCATION`, `GOOGLE_APPLICATION_CREDENTIALS`), never through
`bee.env`. The daemon's own Google keys are blanked for agy bees. The credential
probe runs `agy models` in the account home, which also lets agy refresh its
Google token.

Leases of agy accounts are covered under [Leasing](#leasing-accounts-to-other-nodes).

## Leasing accounts to other nodes

The node that owns an account (its authority) can lend it to another node, a
satellite. Normally the Apiary lease grid drives this. The verbs are:

```sh
hive account lease grant <id> --node <nodeId> [--ttl-ms <ms>] --json   # on the authority
hive account lease batch --file items.json --json                      # grant / install / release in bulk
hive account lease install --file payload.json                         # on the satellite
hive account lease remove <id>                                         # on the satellite
hive account lease export <id> --json
```

- `lease grant` mints the account's material for one named node and returns
  the complete `lease install` payload for it. The lease window is 36 hours by
  default and at most 30 days. Granting again with the same share and epoch and
  a later expiry renews the lease.
- A lease never carries the refresh token. For Claude and Cursor it carries an
  access token. For agy it carries the Google sign-in with its refresh token
  blanked, or the API key, or the service account key. A Google sign-in that is
  less than 10 minutes from expiry is first refreshed by agy itself, in a
  scratch home. Agent Platform accounts that use user ADC (a refresh grant) are
  not leased.
- A leased account cannot log in, capture or be granted on the satellite.
  Those are refused with `account_leased`; ask the authority for a renewal
  instead.
- `account credentials status` reports a credential generation. Each new
  credential raises it, which is how satellites know to renew.
- `hive account restored <selector>` is for a credential that was written into
  the account home outside the daemon, such as a leased credential on a
  satellite. It checks that the credential is present and unexpired, then
  resumes the account's interrupted bees (see below).

## Credential status and central ownership

```sh
hive account credentials status <account> [--json]
hive account credentials enable <account>
hive account credentials refresh <account>
hive account credentials disable <account>
```

These opt-in commands make Honeybee the sole owner of an account's rotating
refresh token. Honeybee keeps the refresh chain in a private authority and
publishes access-only copies to local runtimes and leases. They support Claude,
Codex, first-party Grok OIDC and Muse accounts. Every other account keeps its
harness's own refresh behaviour.

- `status` reports the phase, the credential generation and the expiry, without
  secrets.
- Stop the account's local bees, including idle ones, before `enable` or
  `disable`.
- Grok needs exactly one `https://auth.x.ai::<client-id>` entry. API keys and
  mixed scopes are refused.
- To recover a Codex or Grok account, run `disable`, log in natively, then run
  `enable`. A Claude account can log in again in place.

See [central credentials](claude-central-credentials-pilot.md) for ownership,
recovery and acceptance checks.

## Troubleshooting refusals

### A spawn is refused with `account_auth_needed`

An account that cannot authenticate on this node is never picked. These
accounts are skipped:

- status `auth_needed`, or no primary credential;
- an empty or malformed credential document;
- a Claude token past expiry whose refresh token is blanked (a stale satellite
  lease);
- a local Cursor sign-in whose `exp` cannot be read;
- a local Cursor sign-in past its `exp`, once a re-capture from Cursor's login on
  this computer has failed (`account_credential_expired`). A Cursor token that
  expired with no re-capture since is admitted: activation re-captures it, then
  starts or holds the bee.

The check looks at the copy a runtime would read: the home when it is populated,
else the vault copy that activation installs. With no usable account, the spawn
is refused with `account_auth_needed` instead of placing a bee that would crash
at `/login`.

The same check applies to an explicit `--account`, allocator claims,
`bee swap-account` and every runtime start (revive, a send to a stopped bee,
reconfigure). A start whose account has become unusable is held, with its mail
still queued, until a login or a lease restores the account.
`--only-account <id>` (repeatable) limits `auto` / `rr` to a list of accounts.

### A bee stopped with "Not logged in · Please run /login"

A turn cut off by an authentication failure continues on its own once the
account's credential works again on the node. Any of these clears `auth_needed`
on the account's bees and sends each interrupted bee exactly one continuation:
a completed login, a capture, the daemon's own token refresh, or a readable
limits probe.

- If none of the turn ran, the original message is delivered again. Otherwise
  the bee gets one short continue message from `hive:auth-resume`.
- A bee you stopped or archived is left alone. A bee whose continuation already
  failed on a credential is not resumed a second time on that credential.
- A readable limits probe clears `auth_needed` on every bee of the account,
  including bees with no interrupted turn. A bee that still cannot authenticate
  sets it again on its next turn.
- After `hive account credentials disable`, a login or capture does not resume
  the account's bees. `credentials enable`, or the next readable limits probe,
  does. This keeps the bees from waking on the native refresh chain while it is
  being handed back.

`hive account interruptions [<selector>]` lists the interrupted turns and what
became of them.

### A paused account

```sh
hive account pause <selector> [--by operator|quota|lease] [--owner <id>]
hive account unpause <selector> [--force]
```

A pause has an owner. `--by` records who holds it: `operator` by default, while
`lease` and `quota` need `--owner`, for example the Apiary lease id.
`account list` shows it as `paused(lease:<id>)`, and the account row carries
`pausedBy`, `pausedOwner` and `pausedAt`. `unpause` lifts only the caller's own
pause. A pause held by someone else is refused with `account_pause_owned`, which
names the holder. `--force` takes over a pause or lifts it regardless.

### Login or capture refusals

| Reason | Meaning |
|---|---|
| `different_account` | The credential belongs to another user than the account holds. Sign in as the right user, or pass `--replace-account`. |
| `identity_unverified` | Honeybee cannot tell which user the credential belongs to. Pass `--replace-account` if it is the right one. |
| `credential_stale` | Cursor: the sign-in on this computer is expired or was just rejected. Sign in to Cursor again. |
| `no_credentials_to_import` | `add --import-existing` found nothing; the message lists every path checked. |
| `account_leased` | The account is leased from another node; ask its authority for a renewal. |
