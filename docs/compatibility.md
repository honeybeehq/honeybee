# Apiary–Honeybee compatibility

Use this matrix to choose Honeybee and Apiary versions that work together. The
recommended pin identifies the exact combination selected for an Apiary release.

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

Each populated row should link to its release report, including:

- Exact component versions, source revisions, platforms and artifact checksums.
- Evaluation date and evaluator, Jev model, question and policy revisions.
- Required operation results and evidence, including any incompatible operations
  or unresolved judgments; optional feature limitations are identified separately.
- The release manifest's pinned combination and supported alternatives.

A version bump describes a component's change from its previous public contract.
The matrix answers whether a particular set of component versions works together.
A major Honeybee change can leave an Apiary combination compatible when Apiary
does not depend on the changed contract. A new Apiary feature can require a newer
Honeybee version even when Honeybee's change is backward compatible.

## Maintaining the matrix

The release workflow should generate the populated table from the canonical
compatibility matrix and release manifest used to select pins. This document
establishes the presentation; automatic generation is not implemented by this
documentation change. Do not maintain independent handwritten compatibility
verdicts or derive them from version numbers alone.

Compatibility evaluation can run alongside testing and builds. Its pending
results remain unverified until the report is bound to the exact release
artifacts and the applicable release checks complete. Publication should retain
an immutable report and matrix snapshot for each release and link that snapshot
from the changelog or release notes. The README links to this current overview.

Keep incompatible and unverified combinations visible, including gaps between
compatible versions. A withdrawn support declaration must be reflected in the
current overview, while historical snapshots remain identifiable as historical.

The [release contract](../contracts/release/v2/README.md) defines exact identities,
operation evidence, compatibility states and support selection. The
[release producer documentation](./honeybee-releases.md) describes Honeybee
publication. This table presents those decisions; installation and updates use
the authenticated release metadata.
