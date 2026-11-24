#!/usr/bin/env bash
. "$(dirname "$0")/lib.sh"
docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -E '^(debian|ubuntu)' | head -3
img=$(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -E '^debian:' | head -1); img=${img:-debian:13}
echo "image: $img"
timeout 280 docker run --rm --privileged --name "hb-lab-ss-quota-$$" -v "$(cd "$(dirname "$0")" && pwd)/12-quota-inner.sh:/inner.sh:ro" "$img" bash /inner.sh 2>&1
echo "container gone: $(docker ps -a --format '{{.Names}}' | grep -c "hb-lab-ss-quota-$$")"
