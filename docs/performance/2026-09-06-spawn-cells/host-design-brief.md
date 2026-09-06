# Dedicated runner-host entry design

Measured at base `17ce2072`: 15 alternating launches of the current built CLI
versus the same runRunnerHost bundled from runner-host-main.ts. Median host RSS
60,932,096 versus 49,692,672 bytes; host CPU to readiness 290 versus 220 ms;
stub readiness 1004.98 versus 917.48 ms. The production v2 CLI bundle is 1,046,082
bytes; the prototype standalone host is 4,106 bytes. These are warm compile-cache
launches on a shared Mac, with 5 ms polling and OS-quantized CPU.

The daemon currently supplies HsrDriver.hostCommand whenever argv[1] looks like
hive/cli.js, re-invoking that CLI with v2 runner-host. The driver default uses
runner-host-main.ts relative to its source module. Both HSR and Cells share this
hsrConfig. The production build currently produces cli.js and provision-worker.js
in dist/v2; the deploy pipeline copies dist recursively. No production source
has changed yet.

We need a small design package: caller usage, signatures/module map, invariants,
alternatives and tests. Compare two structurally distinct choices. A keeps entry
selection in the daemon's existing hostCommand callback. B moves production/source
entry selection behind HsrDriver's existing hostCommandFor boundary and removes
the daemon's CLI inference. Preserve explicit hostCommand overrides, source tests,
immutable deployed paths, runtime re-adoption, exact process identity and existing
hidden runner-host CLI compatibility. No new authority or protocol.

Rubric: executable correctness in real deployed layout; source/embedded/explicit
override behavior; no provider/CLI imports in host artifact; lifecycle and recovery
parity; minimal caller knowledge and code; measurable RSS/CPU/startup benefit.

## Architect and arena progress

- [x] Ground
- [x] Sketch: two candidates, Fable5 and Codex5.6-sol, max effort
- [x] Agree: automatic synthesis, no human checkpoint requested
- [ ] Implement
- [ ] Scrap: only if implementation invalidates the sketch

- [x] Frame
- [x] Fan out
- [x] Cross-judge
- [x] Pick
- [x] Graft
- [ ] Verify

Two candidates are sufficient for this bounded entry-selection decision. Fable
also grounds the Cell lane; the parent owns measurements and final judgment.

## Decision

Select B: the driver owns entry resolution; the daemon loses argv inference.
Claude Fable 5 independently confirmed this choice after comparing both sketches.
Keep the existing override and source entry. Add a required, small bundled sibling.
Graft early realpath pinning of the loaded module directory to cover Node symlink
flags, and an artifact import-graph/size gate. Missing packaging must fail clearly.
Do not add a daemon configuration seam or silent CLI fallback.

The independent review found that A referenced a nonexistent daemon configuration
property. B uses the existing HsrDriverConfig override. Default Node ESM resolves
symlinks already; explicit pinning covers preserve-symlinks flags.
