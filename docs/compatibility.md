# Apiary–Honeybee compatibility

Use this guide to read the generated compatibility reports for Honeybee and
Apiary releases. The recommended pin identifies the exact combination selected
for an Apiary release. Reports cover one release manifest at a time; this page
does not aggregate them into a cross-release catalog.

## Release matrix

No evaluated release combinations or recommended pins are recorded in this
document yet. Preparing source inventories alone does not establish release
compatibility. The pending row below represents that status, not a release pair.

| Apiary caller version / platform | apiaryd provider version / platform | Honeybee version / platform | Compatibility | Release selection | Details |
| --- | --- | --- | --- | --- | --- |
| — | — | — | ⏳ Unverified | No pin recorded | Release evaluation pending |

The caller is either the Apiary desktop application or an independently installed
apiaryd service. Each populated row must name which one it represents. The
provider is the receiving apiaryd service. Platforms apply independently to each
component; a result for one combination does not establish another's compatibility.

| Status | Meaning |
| --- | --- |
| ✅ Compatible | The evaluated combination satisfies all required operations under the recorded evaluation policy. |
| ❌ Incompatible | At least one required operation has a demonstrated incompatibility or a decisive semantic judgment of incompatibility under that policy. Details identify the affected operation. |
| ⏳ Unverified | Evidence is missing, ambiguous, stale, or below the decision threshold, or evaluation has not completed. This does not mean incompatible. |

Release selection is listed separately as **Pinned**, **Supported alternative**,
or **Not selected**. A compatible result alone does not promise release support.
Only compatible combinations may be pinned or listed as supported alternatives.
Optional feature limitations remain visible in Details even when the required
operations are compatible.

Every result applies to the exact listed versions and artifacts. Do not infer
compatibility for intervening versions, another platform, or a different apiaryd
provider. Unlisted combinations are unverified.

## Reading the details

Generated reports include:

- Exact component versions, source revisions, platforms and artifact checksums.
- Evaluator, Jev model, question and policy revisions. Evaluation dates are not
  recorded in the canonical records; feed issue and expiry times describe the
  snapshot, not when evaluation happened.
- Required operation results and evidence, including any incompatible operations
  or unresolved judgments; optional feature limitations are identified separately.
- The release manifest's pinned combination and supported alternatives, with
  original selection identified as historical when current evidence no longer
  supports it.

Selection follows the exact manifest-declared artifacts across evaluator
revisions and requires one current compatible evaluation. Multiple current
evaluations leave selection withheld. An omitted historical combination remains
visible as **Unverified / Not selected**; its old checks are not replayed as
current evidence.

A version bump describes a component's change from its previous public contract.
The matrix answers whether a particular set of component versions works together.
A major Honeybee change can leave an Apiary combination compatible when Apiary
does not depend on the changed contract. A new Apiary feature can require a newer
Honeybee version even when Honeybee's change is backward compatible.

## Maintaining the matrix

Apiary's evaluator generates `<matrix-sha256-hex>.compatibility.md` beside the
matching `.matrix.json`, including failed evaluations. These candidate reports
have no release manifest, so every row is **Not selected**.

Initial release publication and each compatibility-feed update generate
`compatibility.md` and `compatibility-matrix.json` from authenticated canonical
metadata. Release notes link to the report, exact matrix and signed metadata
(`release-bootstrap.json`). Each publication retains its own immutable historical
snapshot; existing immutable releases are not backfilled. Do not maintain
independent handwritten verdicts or derive them from version numbers alone.

Compatibility evaluation can run alongside testing and builds. Its pending
results remain unverified until the report is bound to the exact release
artifacts and the applicable release checks complete. Implemented report
generation does not establish a real release verdict: this guide still records
no evaluated release combinations or pins. The README links to this overview.

## Finding current support

Start with the exact release manifest and its authenticated compatibility feed.
Current support uses the highest authenticated sequence for that manifest and
must still pass admission checks, including expiry, revocation and withdrawal.
A higher unauthenticated sequence is not authoritative. Historical reports do
not override those checks.

Feed updates publish under `apiary-compat-<manifest-hash>-<sequence>` and do not
change GitHub's global latest release. Follow the report links in the release
notes for the authenticated snapshot; `/releases/latest/download/compatibility.md`
is not a reliable current-support link. Incompatible and unverified rows remain
visible in generated reports. Unlisted combinations have no generated judgment
and remain unverified.

The [release contract](../contracts/release/v2/README.md) defines exact identities,
operation evidence, compatibility states and support selection. The
[release producer documentation](./honeybee-releases.md) describes Honeybee
publication. This table presents those decisions; installation and updates use
the authenticated release metadata.
