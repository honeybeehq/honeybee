# Final verification

| Final expanded-source run | Outcome | Wall time / scope |
| --- | --- | --- |
| Native mini05 macOS full driver A | 282 pass, 4 platform skips, zero fail/cancel | 195.297s;20 launched owned burners |
| Native mini05 macOS full driver B | 282 pass, 4 platform skips, zero fail/cancel | 158.958s;20 launched owned burners |
| Native mini05 combined teardown/quiet RPC | 13 pass, zero fail/skip/cancel | 176.209s;no own burners, concurrent with driver A |
| Native mini05 selected driver cases + controlled status regression | 5 pass, zero fail/skip/cancel | 13.444s wall /10.490s TAP;20 launched burners |
| Native Linux metal-2 full driver | 286 pass, zero fail/skip/cancel | 9.513s TAP;no CPU stress |
| Native Linux metal-2 teardown/quiet/confined-peer | 19 pass, zero fail/skip/cancel | 44.146s TAP;native unshare ran |
| Native macOS and Linux typecheck/build | exit0 | Exact expanded source;Linux worker logs attach through proof_check |

Mac logs/results/workload receipts are committed alongside this file. Linux facts are authenticated worker8155c7cd reports (messages617/620), independently executed in its isolated Cell on the exact supplied source blobs. The checker attaches its own original logs directly to proof; the author does not claim to have copied their bytes into this commit. All ten final code-file hashes are recorded in source-manifest.json. verify.py checks current ten hashes, the eight TS hashes captured at each final launch, stored child statuses, summary counts and named regression presence. The capture harness does not hash the two v2 fixture MJS files at launch, and the verifier makes no all-file freeze, independent execution, full daemon census or continuous CPU claim.

Both controlled old-disposal variants fail with LIVE detached adopted hosts on native macOS and Linux. The controlled old-status variant fails with expected synthetic boot count1/actual0 on both platforms. Permanent identity refusal remains a failed stop and daemon exit1. The clean75 native-Mac baseline's four selected driver cases passed three times under20 launched burners; those baseline runs do not establish natural reproduction of the Studio failures.

The initial six-file disposal-only stress runs each passed13 cases but precede the driver expansion. The intermediate broader driver run failed at the original explicit three-second startup budget (280pass/1fail/4skip). Initial nested-context wrapper attempts and the baseline reviewer's initial missing-dependency setup attempt are excluded. Historical Studio signal/identity scheduling causes remain unknown. No complete daemon/CLI gate or deployment was performed for this revision; original release-only driver2 red evidence is not cleared.
