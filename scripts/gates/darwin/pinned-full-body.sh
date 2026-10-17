#!/bin/sh
echo '{"ok":false,"code":"darwin_gate_body_unsupported_until_audited","message":"Legacy service-sentinel body requires root-only conversion and Queen audit"}' >&2
exit 88
