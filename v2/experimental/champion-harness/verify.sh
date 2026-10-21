#!/usr/bin/env bash
set -euo pipefail
champion_cell_root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$champion_cell_root"
mkdir -p .audit/champion-adapter/home .audit/champion-adapter/tmp
exec env -i PATH="$PATH" HOME="$champion_cell_root/.audit/champion-adapter/home" TMPDIR="$champion_cell_root/.audit/champion-adapter/tmp" node --experimental-strip-types v2/experimental/champion-harness/fixture.ts
