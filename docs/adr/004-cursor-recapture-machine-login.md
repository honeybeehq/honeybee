---
status: accepted
---

# Re-capture Cursor's own login instead of refreshing it

On 2026-11-18, Tormod approved reversing spec 08's rule that login is the only
time Honeybee reads Cursor's machine-wide credential store. His answer, relayed by
Needle: "Yes, re-read Cursor's own login".

## Decision

Before a Cursor limits probe, a spawn, or a lease is minted, the account's
authority node re-reads Cursor's machine-wide login. That login is the macOS Keychain
items under account `cursor-user`, or the global `auth.json`. Honeybee reads it only
when:

- the cached access token is within 15 minutes of its JWT `exp`;
- or a probe has just returned HTTP 401.

Honeybee takes the login only when two things hold:

- its JWT `sub` is the same Cursor user as the token the account already holds;
- its token is newer than the one the account holds.

It then writes that login to the account home's `auth.json` and to the vault.
A 401 leads to one forced re-capture and one more probe before the account is marked
`auth_needed`.

Honeybee never calls a Cursor refresh endpoint. `cursor-agent` keeps its own login
fresh, and Honeybee follows it. That holds only while Honeybee's own runtimes leave
the login alone, so every runtime that gets a Honeybee token also gets
`AGENT_CLI_CREDENTIAL_STORE=memory` (see "Runtime isolation").

Satellites get access-only leases: the access token, never the refresh token.
A leased account never reads the satellite's own Cursor login and cannot log in or
capture there.

Login and `hive account capture` refuse a credential whose identity differs from
the account's held identity. The refusal reasons are `different_account` and
`identity_unverified`. `--replace-account` overrides the refusal on purpose.

They also refuse, with `credential_stale`, a sign-in whose token is past its
`exp` or is the same token that just got an HTTP 401. Nothing changes, and the
message says to sign in to Cursor again and run `hive account login`.

## Runtime isolation

Added 2026-11-24 after a real run on Tormod's Mac (HON-27). Cursor's CLI writes a
`CURSOR_AUTH_TOKEN` it is started with into its credential store as both the access
and the refresh token, replacing the machine's real `session_rt_` refresh token
(`./src/api-key-auth.ts`, `setAuthentication(token, token)`). If the server rejects
the token at startup, it then deletes every `cursor-*` credential
(`clearAuthentication()`). One Honeybee spawn with an expired token removed the
Mac's Cursor login this way, and earlier spawns with valid tokens had already
replaced its refresh token, which is why that login had stopped refreshing.

- **Memory store.** Every runtime that gets `CURSOR_AUTH_TOKEN` or `CURSOR_API_KEY`
  also gets `AGENT_CLI_CREDENTIAL_STORE=memory`. The CLI then keeps credentials in
  process memory, and neither the overwrite nor the clear reaches the machine's
  login. In a lab file store on Linux with CLI 2026.11.22, the store was rewritten
  and then cleared without the variable, and byte-identical with it, for a valid,
  an expired and an unreadable token.
- **CLI version.** Every installed CLI from 2026.06.02 to 2026.11.22 honours the
  variable; older versions were not available to check. A spawn that passes a token
  is refused, with the reason, unless the configured CLI reports a Cursor agent
  version of 2026.06.02 or newer.
- **Native accounts.** An account that uses the machine's own login passes no
  token, so the CLI uses its normal store, unchanged.
- **Expiry.** A spawn or probe with a token past its `exp`, or whose `exp` cannot be
  read, is refused, the account goes to `auth_needed`, and the message says to log
  in. The CLI treats an unreadable `exp` as expired.

## Threat model

Anyone who can write the user's own Cursor store, or an account home or vault,
already owns that user. These rules do not defend against a hostile local writer.
They defend against two things: races with `cursor-agent` and other Honeybee
operations, and Honeybee's own mistakes, such as capturing the wrong user or
writing an older token over a newer one.

## Rules

- **Access token only.** Honeybee reads and keeps only Cursor's access token: one
  Keychain item, or the `accessToken` field of the global `auth.json`. It never
  refreshes, so it never takes the refresh token. Cursor's machine-wide API key is
  never captured or leased.
- **Identity.** A token's identity is its JWT `iss` and `sub`, compared as separate
  fields. The token must have a signed shape: a header `alg` other than `none` and
  a non-empty signature, plus `iss`, `sub` and `exp`. Honeybee does not check the
  signature; under the threat model that is out of scope.
- **First capture.** A capture counts as the account's first only when the account
  holds no credential at all. An existing credential without an identity needs
  `--replace-account`. A first capture is refused with `different_account` when
  another local Cursor account already holds the same `iss` and `sub`;
  `--replace-account` lets two accounts share that user on purpose.
- **One selection.** The probe, the spawn and the lease use the same credential.
  The account's identity comes from its vault copy, else its home copy. Among
  copies with that identity, the latest `exp` wins. Before each probe, spawn and
  lease, Honeybee rewrites both copies to the selected bytes, which repairs an
  interrupted write. Writes go to the vault first, so a repair never brings back a
  replaced user.
- **Exact bytes.** Capture and login validate one `{accessToken}` document and write
  exactly those bytes to the vault and the home, without reading them back.
- **One writer at a time.** Re-capture, repair, explicit capture and login landing
  hold one lock per account. After taking it, re-capture checks again before
  reading the store: the account row, any active login flow and the token's expiry.
  Just before writing, it checks once more: same identity, and a later `exp`.
- **When the store is read.** Only when the selected token has a known `exp` within
  15 minutes, or after an exact HTTP 401 status. This background read gives the
  Keychain two seconds; if it does not answer (it is locked), Honeybee keeps using
  the cached token while that token has not expired. Explicit login and capture wait up to 60 seconds, because a
  person may be unlocking the Keychain.
- **Errors.** Cursor probe errors carry the HTTP status only, never a response body.
- **Leases.** A lease's `auth.json` is exactly `{accessToken}`. Mint and install
  both enforce this.
- **Probe URL.** The URL is Cursor's production URL. `HIVE_CURSOR_USAGE_URL` is
  honoured only inside the test harness, and only when it is https.

## Reason and alternatives

Honeybee copied Cursor's access token once, at login, and nothing refreshed the
copy. When it expired, the probe got a 401 and marked the account `auth_needed`. A
new login only took a fresh copy that expired the same way.

A Cursor credential authority that refreshes tokens itself, like Grok's, was
considered and rejected. Nothing we have pinned or installed shows Cursor's refresh
endpoint or whether it rotates refresh tokens. Reverse-engineering the client is
brittle, and a wrong guess could invalidate the account's only refresh token.

Re-reading the store works only on the computer where `cursor-agent` keeps the login
fresh, and only while Honeybee's runtimes are kept off that login. That computer is the account's authority node. Other nodes depend on its
leases.
