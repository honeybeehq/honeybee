npm ci --offline --no-audit --no-fund || exit $?
deps_check
npm run build || exit $?
