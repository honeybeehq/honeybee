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
fresh, and Honeybee follows it.

Satellites get access-only leases: the access token, never the refresh token.
A leased account never reads the satellite's own Cursor login and cannot log in or
capture there.

Login and `hive account capture` refuse a credential whose identity differs from
the account's held identity. The refusal reasons are `different_account` and
`identity_unverified`. `--replace-account` overrides the refusal on purpose.

Rules that keep this safe:

- **Identity.** A token's identity is its JWT `iss` and `sub`. The token must have
  a signed shape: a header `alg` other than `none` and a non-empty signature, plus
  `iss`, `sub` and `exp`. Honeybee cannot check Cursor's signature, and anyone who
  can write the user's own credential store already owns the user.
- **Which copy counts.** An account's identity is its vault copy's identity, else
  its home copy's. A copy without an identity never makes a capture a first capture
  while the other copy has one. Copies belonging to another user are ignored.
- **One writer at a time.** Re-capture, explicit capture and login landing hold one
  per-account lock. Just before writing, re-capture checks the account again: same
  identity, and a later `exp` than every copy it holds.
- **What is read.** The Keychain items are read as one snapshot: the access token is
  read again after the refresh token, and a mismatch means another read. Cursor's
  machine-wide API key is never captured, and leases never carry one.
- **When the store is read.** Only when the cached token has a known `exp` within
  15 minutes, or after an exact HTTP 401 status. An opaque token never triggers a
  read.
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
fresh. That computer is the account's authority node. Other nodes depend on its
leases.
