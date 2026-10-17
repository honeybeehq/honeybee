npm ci --offline --ignore-scripts --no-audit --no-fund || exit $?
deps_check
"$SCG_PYTHON_BIN" -B scripts/gates/darwin/focused_readiness.py || exit $?
npm run build || exit $?
