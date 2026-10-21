#!/bin/bash
set -eu
if [ "${TASK_ENV_CLEAN:-}" != 1 ]; then exec env -i PATH="$PATH" TASK_ENV_CLEAN=1 bash "$0"; fi
mkdir -p .h .t
export HOME="$PWD/.h"
export TMPDIR="$PWD/.t"
export GIT_CEILING_DIRECTORIES="$PWD/.t"
exec bwrap --unshare-user --uid "$(id -u)" --gid "$(id -g)" --die-with-parent --tmpfs / --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 --ro-bind /bin /bin --ro-bind /sbin /sbin --ro-bind /etc /etc --ro-bind /opt /opt --proc /proc --dev /dev --bind "$PWD" /c --chdir /c --setenv HOME /c/.h --setenv TMPDIR /c/.t --setenv GIT_CEILING_DIRECTORIES /c/.t node --test v2/daemon/tests/socket-path.test.ts
