# Build identity and extracted contracts (HON-4)

Build facts supplement the HON-3 release contract. They are **not** a verified
`ComponentIdentity`: they do not invent an artifact URL, checksum, or compatibility
verdict. Existing protocol and database schema versions are unchanged.

## Build facts

`BuildIdentity` is exported by `honeybee/release/v1`. Its fields are
`schemaVersion: 1`, `component`, `version`, `packageVersion`, `sourceRevision`,
`dirty`, `release`, and `target`. Unknown source revision or cleanliness is `null`.
A release requires a clean full revision and the component's exact version tag.
Honeybee accepts `v<version>` or `honeybee-v<version>`; desktop Apiary accepts
`v<version>`; apiaryd accepts only `apiaryd-v<version>`.

Untagged and dirty versions carry `-dev.<short revision>[.dirty]`; unavailable
source evidence carries `-dev.unknown`. This is build provenance, not proof of tag
signatures or reproducible binary bytes. Two dirty builds can share these facts;
the artifact checksum, when available, distinguishes their bytes.

Honeybee writes `dist/build-identity.json` at build time. Its daemon hello,
`deployInfo`, and `hive --version --json` consume this installation's file without
Git. `hive deploy-info --json` includes separate `cliIdentity` and
`daemonIdentity`; a legacy daemon's identity is null. The deploy builder passes
revision provenance into its Git-free archive before building. Runtime artifact
manifests retain the packaged identity and reject contradictory source/package
facts; old manifests without identity remain readable.

Apiary's bundlers embed each component's own identity. The standalone apiaryd
manifest and `apiaryd --version --json` agree. Local socket hello carries apiaryd
identity; node hello carries separate `apiaryd.identity` and `hive.identity` with
their own capability sets. Legacy apiaryd capabilities remain empty. Honeybee
identity follows the currently observed mirror connection, is never persisted as
liveness, and clears on disconnect. Source execution without a bundle has null
identity. Desktop builds expose their version through existing diagnostics.

## Contract extraction

From Honeybee, run `npm run release:inventory --silent > inventory.json`.
From Apiary, run:

```
node scripts/extract-release-inventory.mjs /path/to/honeybee/contracts/release/v1/tools/extract-inventory.mjs > inventory.json
```

The same tool ships as `honeybee/release/v1/extractor`; an installed package can
supply it without a Honeybee checkout. Apiary deliberately does not add a mutable
sibling dependency. Use the same tool revision and TypeScript version on both
sides. Each repo owns `contracts/release/inventory.config.json`, which describes
source roots and boundary patterns, not a hand-maintained operation inventory.

The extractor reads actual registries, dispatch cases/conditions, and typed calls.
It emits provider operations, consumer requirements, request/response shapes,
capabilities, optional feature gates with fallbacks, readable source evidence,
and normalized source fingerprints. `operation` is null when a dynamic name cannot
be resolved; finite literal unions are expanded. `path` and `scope` disambiguate
operations sharing a verb. `hive-cli-subcommand` scopes require the containing CLI
handler to establish the full command path.

Consumers are required by default. A function-level `@releaseOptional <capability>`
annotation can record a reviewed optional requirement. Independently extracted
capability branches with explicit fallbacks appear in `optionalFeatures`; e.g.
`spawn.package.skills.v1` includes both the offer and legacy paths. Source handling
evidence covers the `skillsNeeded` delivery/retry response branch. Honeybee's
credential-pilot operations and capability are extracted from the live registry
and dispatcher, even when Apiary does not yet consume them.

`fingerprint`, `providerFingerprint`, and `consumerFingerprint` use SHA-256 over
canonical JSON (sorted object keys, ordered arrays, UTF-8). They include a
conservative hash of **all production TypeScript in the configured roots** so
changes to referenced validators, models, or response handling cannot silently
escape the boundary evidence. This may invalidate evidence after an internal
implementation change. It intentionally favors re-evaluation over stale approval.
Comments, whitespace, timestamps, Git state, and checkout paths do not affect
contract fingerprints. Build identities are recorded separately.

`coverage.complete` is false when extraction encounters dynamic routing, runtime
validation requiring interpretation, or unclassified boundary candidates. Shape
nodes can also carry `coverage: "unknown"` (index signatures, `any`, `unknown`,
recursion/depth limits). Neither an extracted operation nor a matching fingerprint
proves compatibility. Downstream evaluation must account for these gaps and remain
unverified when it lacks evidence. No evaluator, matrix publisher, or updater is
implemented here.
