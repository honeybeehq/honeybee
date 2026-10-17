"$SCG_PYTHON_BIN" -B scripts/gates/darwin/guard_test.py || exit $?
"$SCG_PYTHON_BIN" -B scripts/gates/darwin/git_boundary.py || exit $?
"$SCG_PYTHON_BIN" -B scripts/gates/darwin/physical_test.py || exit $?
