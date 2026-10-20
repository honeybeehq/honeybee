# C3 probe backoff proof

Base: C2191550f8514d0c5a81e21430189279ebad575e3. Clean measured head8329752a (production source identical to9a8f3b23).

Real Honeybee daemon, two fake Claude sessions, two synthetic accounts and a loopback usage/profile stub. No real provider or credentials. The long-wait clock is explicitly accelerated: wallAt is actual HTTP request time; logicalAt is injected daemon scheduling time. This is a logical 66-minute scenario, not66minutes of wall time.

The lab passes 30,60,120,240,480,900,900,900-second delay tiers. Blocked usage rises98->98.08 and another bee repeatedly clears/re-stamps exhaustion; neither collapses cadence. A killed/restarted daemon retains the900-second deadline and makes no early probe. Actual calls resume within the bounded30-second reconciliation poll after that deadline. A fresh target reset schedule change resets its cadence to30seconds. Source reset then bypasses the900-second cap, including an overlapping target probe, and the interrupted source turn resumes automatically with one continuation.

Read probe-cadence.log and requests.json, then summary.json events and final-rpc.json audit account.quota_probe. Daemon log includes quota.probe account/at/next_at/delay_ms/reason. Cadence is stored in the same SQLite meta authority before IO; no local file competes with it.

Gates: check,v2:check,build pass; existing accounts-rpc/loops/runner-host128/128; allocation/checkpoint9/9. The repository verification skill remains a known setup gap. No new unit tests or production comments.

Try: with a fake invoking HOME, login:false, run bash .proof/C3/run.sh and bash .proof/C/verify.sh. Wrappers create0700 /var/tmp roots, sanitized environment/cache paths, fake harnesses and loopback endpoints; trash semantics handle disposal.

Queen review and DEPLOY HOLD remain. Selection priorities, claims, lease/fence checks, shared admissionRefreshes lane and recovery shutdown drain are unchanged.
