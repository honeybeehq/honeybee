#!/bin/bash
set -eu
mkdir -p .proof/B1/daemon-home .proof/B1/daemon-tmp
exec env -i PATH="$PATH" HOME="$PWD/.proof/B1/daemon-home" TMPDIR="/proc/$$/cwd/.proof/B1/daemon-tmp" node .proof/B1/daemon-bench.ts
