scg_self_test_exit() {
  scg_self_test_rc=$?
  if [ "$scg_self_test_rc" -ne 0 ]; then printf 'WORKLOAD_NONZERO_REASON=phase:%s exit:%s\n' "$SCG_PHASE" "$scg_self_test_rc"; fi
  if [ -f "$GATE_ROOT/trace-test-summary.txt" ] && [ ! -L "$GATE_ROOT/trace-test-summary.txt" ]; then
    tail -c 8192 "$GATE_ROOT/trace-test-summary.txt"
  fi
  exit "$scg_self_test_rc"
}
trap scg_self_test_exit EXIT
"$SCG_PYTHON_BIN" -B scripts/gates/darwin/guard_test.py || exit $?
"$SCG_PYTHON_BIN" -B scripts/gates/darwin/focused_tap_test.py || exit $?
"$SCG_PYTHON_BIN" -B scripts/gates/darwin/focused_native_test.py || exit $?
"$SCG_PYTHON_BIN" -B scripts/gates/darwin/focused_sentinel_test.py || exit $?
"$SCG_PYTHON_BIN" -B scripts/gates/darwin/focused_audit_test.py || exit $?
"$SCG_PYTHON_BIN" -B scripts/gates/darwin/focused_diagnostics_test.py || exit $?
"$SCG_PYTHON_BIN" -B scripts/gates/darwin/focused_flow_test.py || exit $?
"$SCG_PYTHON_BIN" -B scripts/gates/darwin/focused_trace_test.py || exit $?
"$SCG_PYTHON_BIN" -B scripts/gates/darwin/focused_seal_test.py || exit $?
"$SCG_PYTHON_BIN" -B scripts/gates/darwin/focused_profile_test.py || exit $?
"$SCG_PYTHON_BIN" -B scripts/gates/darwin/focused_argv_test.py || exit $?
"$SCG_PYTHON_BIN" -B scripts/gates/darwin/focused_node_flags_test.py || exit $?
"$SCG_PYTHON_BIN" -B scripts/gates/darwin/focused_pty_test.py || exit $?
"$SCG_PYTHON_BIN" -B scripts/gates/darwin/focused_signal_test.py || exit $?
"$SCG_PYTHON_BIN" -B scripts/gates/darwin/focused_barrier_test.py || exit $?
"$SCG_PYTHON_BIN" -B scripts/gates/darwin/focused_mediation_test.py || exit $?
"$SCG_PYTHON_BIN" -B scripts/gates/darwin/focused_ipc_test.py || exit $?
"$SCG_PYTHON_BIN" -B scripts/gates/darwin/focused_pax_test.py || exit $?
"$SCG_PYTHON_BIN" -B scripts/gates/darwin/focused_seed_test.py || exit $?
"$SCG_PYTHON_BIN" -B scripts/gates/darwin/focused_revision_test.py || exit $?
"$SCG_PYTHON_BIN" -B scripts/gates/darwin/focused_roles_test.py || exit $?
"$SCG_PYTHON_BIN" -B scripts/gates/darwin/focused_controls_test.py || exit $?
"$SCG_PYTHON_BIN" -B scripts/gates/darwin/focused_scope_test.py || exit $?
"$SCG_PYTHON_BIN" -B scripts/gates/darwin/git_boundary.py || exit $?
"$SCG_PYTHON_BIN" -B scripts/gates/darwin/physical_test.py || exit $?
