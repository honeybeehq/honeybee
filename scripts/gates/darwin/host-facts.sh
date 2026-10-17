#!/bin/sh
set -eu
for candidate in /opt/homebrew/bin/node /usr/local/bin/node /opt/homebrew/opt/node*/bin/node /usr/local/opt/node*/bin/node /opt/local/bin/node /usr/bin/python3 /opt/homebrew/bin/python3; do
  /bin/ls -ld "$candidate" || :
  if [ -x "$candidate" ]; then "$candidate" --version; fi
done
/usr/bin/env -i PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin HOME=/private/var/tmp/hbfacts /bin/sh scripts/gates/darwin/node-path.sh
/usr/bin/sw_vers
/usr/bin/uname -m
