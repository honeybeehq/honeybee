import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

import focused_audit
import focused_diagnostics
import focused_native
import focused_mediation
import focused_sentinel
import pty_controls
import focused_seal
import focused_roles
import focused_tap
import focused_trace


LIMITATIONS = ['post-exit profile proof is exact only on hook-mediated SIGKILL; natural exit races test cleanup and fails closed.', 'kill hooks refuse signals to exited descendants; such calls fail the row rather than returning ESRCH/false.']
CONTROLLER_BOOTSTRAPS = {}


def observe_controller(api, root, helper):
    births = api.scope_call(helper, 'identity', os.getpid())
    if len(births) != 1 or str(births[0][0]) != str(os.getpid()):
        raise ValueError('controller birth unavailable')
    birth = list(map(str, births[0]))
    result = subprocess.run([str(helper), 'executable', *birth], capture_output=True, text=True, timeout=2)
    path = result.stdout.rstrip('\n')
    if result.returncode != 0 or not path.startswith('/') or '\n' in path or '\r' in path or not path:
        raise ValueError('controller kernel executable unavailable')
    if [list(map(str, row)) for row in api.scope_call(helper, 'identity', os.getpid())] != [birth]:
        raise ValueError('controller birth changed during executable observation')
    record = {'birth': birth, 'executable': path, 'source': 'birth-fenced scope proc_pidpath of controller'}
    CONTROLLER_BOOTSTRAPS[str(root.resolve())] = record
    api.write_json(root / 'controller-bootstrap.json', record, root)
    return record


def bootstrap_matches(executable, birth, launch_birth, controller, current_controller):
    return bool(controller and executable == controller['executable'] and
                tuple(map(str, birth)) == tuple(map(str, launch_birth)) and
                str(birth[1]) == str(controller['birth'][0]) and
                tuple(map(str, current_controller)) == tuple(map(str, controller['birth'])))


def require_bootstrap(api, root, helper, executable, birth, launch_birth):
    controller = CONTROLLER_BOOTSTRAPS.get(str(root.resolve()))
    if controller is None:
        raise ValueError('controller bootstrap identity was not observed')
    current = api.scope_call(helper, 'identity', controller['birth'][0])
    if len(current) != 1 or not bootstrap_matches(executable, birth, launch_birth, controller, current[0]):
        raise ValueError('own executable outside sibling allowlist')

def workload_profile(base, tools):
    literals = [tools['clang'], tools['ld'], '/usr/bin/cc', '/usr/bin/c++', '/usr/bin/gcc', '/usr/bin/g++', '/usr/bin/clang', '/usr/bin/clang++', '/usr/bin/ld', '/usr/bin/as', '/usr/bin/xcrun', '/usr/bin/xcodebuild']
    return base + '(deny process-exec ' + ' '.join('(literal ' + json.dumps(path) + ')' for path in literals) + ' (subpath ' + json.dumps(tools['toolchain']) + ') (subpath "/Library/Developer/CommandLineTools"))'


def control_state(root, workspace, node):
    paths = [root / 'scope', root / 'compiler.sb', root / 'workload.sb', root / 'compiler-version.log', root / 'source-manifest.json', Path(node)]
    paths += [path for path in (workspace / 'scripts/gates/darwin').rglob('*') if path.is_file()]
    result = {}
    for path in paths:
        path = focused_native.confined(path, root)
        info = path.stat()
        result[str(path)] = (info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns, focused_native.digest(path))
    return result


def sealed_control_state(sealed, workspace):
    result = {}
    for directory in (sealed / 'control', workspace / 'scripts/gates/darwin'):
        if directory.resolve(strict=True) != directory.absolute():
            raise ValueError('sealed control directory redirected')
        for path in sorted(directory.rglob('*')):
            if path.is_symlink():
                raise ValueError('sealed control symlink')
            if path.is_file():
                info = path.stat()
                result[str(path)] = (info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns, focused_native.digest(path))
    return result


def require_sealed_controls(sealed, workspace, expected):
    if sealed_control_state(sealed, workspace) != expected:
        raise ValueError('sealed control changed between focused rows')


def dependency_state(workspace):
    modules = workspace / 'node_modules'
    if modules.is_symlink() or not modules.is_dir():
        raise ValueError('focused dependencies absent or redirected')
    rows = {}
    for base, directories, files in os.walk(modules, followlinks=False):
        for name in directories + files:
            path = Path(base) / name
            if path.is_symlink():
                if modules.resolve() not in path.resolve(strict=True).parents:
                    raise ValueError('dependency symlink escapes node_modules')
                rows[str(path.relative_to(modules))] = {'link': os.readlink(path)}
            elif path.is_file():
                rows[str(path.relative_to(modules))] = {'sha256': focused_native.digest(path)}
    return rows


def artifacts(workspace, root):
    return {kind: focused_native.artifact_state(workspace, root, kind) for kind in ('delivery-file', 'peercred')}


def validate_native_edges(edges):
    expected = {'src/dist/v2/delivery-file/darwin-arm64/delivery-file.node', 'src/dist/v2/peercred/darwin-arm64/peercred.node'}
    if not isinstance(edges, list) or len(edges) != 2 or not all(isinstance(row, dict) and isinstance(row.get('artifact'), str) for row in edges) or {row['artifact'] for row in edges} != expected:
        raise ValueError('flow nativeEdges must name exactly the two distinct approved artifacts')


def connection_observation(helper, birth):
    observed = subprocess.run([str(helper), 'connections', *birth], capture_output=True, text=True, timeout=2)
    row = {'birth': birth, 'timestamp': time.time(), 'exit': observed.returncode, 'connections': []}
    if observed.returncode == 3:
        return row
    if observed.returncode != 0:
        raise ValueError('unobserved own connected sockets')
    for line in observed.stdout.splitlines():
        parts = line.split()
        if len(parts) != 4 or parts[1] not in ('TCP', 'UDP') or not parts[0].isdigit() or not parts[3].isdigit() or not 0 < int(parts[3]) <= 65535:
            raise ValueError('malformed own connected socket observation')
        address = ipaddress.ip_address(parts[2])
        row['connections'].append({'fd': int(parts[0]), 'protocol': parts[1], 'remoteAddress': str(address), 'remotePort': int(parts[3]), 'loopback': address.is_loopback})
    return row


def supervise(api, root, workspace, env, argv, tag, timeout=600, trace=None, sibling=False, mediation=None):
    helper = mediation.helper if mediation is not None else root / 'scope'
    read_fd, release_fd = os.pipe()
    tracked = {}
    exited = set()
    samples = []
    signals = []
    reason = None
    executable_samples = []
    connection_samples = []
    if trace is not None:
        env = trace.environment(env)
        argv = trace.command(argv)
    log = root / 'logs' / (tag + '.tap')
    with log.open('xb') as output:
        try:
            proc = subprocess.Popen([sys.executable, '-B', str(workspace / 'scripts/gates/darwin/start_wait.py'), str(read_fd), *argv], pass_fds=(read_fd,) + ((trace.write_fd,) if trace is not None else ()) + ((mediation.request_fd, mediation.response_fd, mediation.lock_read_fd, mediation.lock_write_fd) if mediation is not None and trace is not None else ()), cwd=workspace, env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=sibling)
            focused_seal.remember_launch(proc.pid)
        except OSError:
            os.close(read_fd)
            os.close(release_fd)
            if trace is not None:
                trace.finish()
            if mediation is not None:
                mediation.close()
            raise
        if mediation is not None:
            mediation.roles = focused_roles.Roles(proc.pid, mediation.entries, trace is not None)
            mediation.parent_close()
        if trace is not None:
            trace.root_pid = proc.pid
            trace.parent_close()
        os.close(read_fd)
        started = time.monotonic()
        try:
            births = api.scope_call(helper, 'identity', proc.pid)
            if len(births) != 1:
                raise ValueError('focused process birth unavailable')
            birth = births[0]
            focused_seal.remember_birth(birth)
            tracked[(birth[0], birth[2], birth[3])] = birth
            os.write(release_fd, b'1')
            os.close(release_fd)
            release_fd = None
            while proc.poll() is None:
                if trace is not None:
                    trace.drain()
                for row in api.scope_call(helper, 'scan', *birth):
                    focused_seal.remember_birth(row)
                    tracked.setdefault((row[0], row[2], row[3]), row)
                for sample in api.sample_retained_listeners(helper, tracked, exited):
                    samples.append(sample)
                    if sample.get('error') or any(not listener['loopback'] for listener in sample['listeners']):
                        raise ValueError('focused listener observation failed or non-loopback listener')
                if sibling:
                    for key, row in tracked.items():
                        if key in exited:
                            continue
                        connected = connection_observation(helper, row)
                        connection_samples.append(connected)
                        if any(not item['loopback'] for item in connected['connections']):
                            raise ValueError('non-loopback own connection')
                        observed = subprocess.run([str(helper), 'executable', *row], capture_output=True, text=True, timeout=2)
                        executable = observed.stdout.strip()
                        executable_samples.append({'birth': row, 'timestamp': time.time(), 'exit': observed.returncode, 'executable': executable})
                        if observed.returncode == 3:
                            continue
                        if observed.returncode != 0:
                            raise ValueError('unresolved own executable observation')
                        if executable == env['SCG_NODE_BIN']:
                            if mediation is not None:
                                detail = subprocess.run([str(helper), 'node-observation', *row, env['SCG_NODE_BIN'], mediation.reader, str(trace.policy['preloader']) if trace is not None else '-', str(workspace / 'v2/daemon/tests/delivery-file-read.test.ts'), str(workspace / 'v2/driver-hsr/src/runner-host-main.ts')], capture_output=True, text=True, timeout=2)
                                executable_samples[-1]['nodeObservation'] = {'exit': detail.returncode, 'stdout': detail.stdout, 'diagnostic': detail.stderr}
                                if detail.returncode != 0:
                                    raise ValueError('own Node argv/cwd/sandbox observation unresolved: ' + detail.stderr.strip())
                                observation = focused_mediation.focused_profile.parse_node_observation(detail.stdout, env['SCG_NODE_BIN'])
                                cwd = Path(observation['cwd'])
                                if not (cwd == workspace.parent or workspace.parent in cwd.parents) or cwd.resolve(strict=True) != cwd:
                                    raise ValueError('own Node cwd outside sealed workspace boundary')
                                role = mediation.roles.observe(row, observation['entry'])
                                executable_samples[-1]['roleObservation'] = observation
                                if role == 'reader':
                                    mediation.observe_reader(helper, row, observation, instrumented=trace is not None)
                            if trace is not None:
                                trace.node_pids.add(int(row[0]))
                                trace.node_observations.append(executable_samples[-1])
                        elif executable != '/usr/bin/sandbox-exec':
                            require_bootstrap(api, root, helper, executable, row, birth)
                if mediation is not None and trace is not None:
                    for event in trace.records:
                        if event.get('kind') == 'hello' and event.get('role') == 'reader' and event.get('entry') == mediation.reader:
                            for candidate in tracked.values():
                                if int(candidate[0]) == event['pid']:
                                    mediation.recipient_births[tuple(candidate)] = candidate
                    approved = mediation.approved_launches(trace.records, tracked)
                    mediation.drain(tracked, lambda request, caller: mediation.signal(request, caller, tracked, approved))
                if mediation is not None:
                    mediation.check_deaths(trace is not None)
                if time.monotonic() - started > timeout:
                    raise ValueError('focused hard timeout')
                time.sleep(0.05)
        except (ValueError, OSError, subprocess.SubprocessError, api.Refusal) as error:
            reason = str(error)
        finally:
            if release_fd is not None:
                os.close(release_fd)
            cleanup_deadline = time.monotonic() + 10

            def bounded_helper(argv):
                try:
                    return subprocess.run(argv, capture_output=True, text=True, timeout=max(0.01, min(2, cleanup_deadline - time.monotonic())))
                except (OSError, subprocess.SubprocessError):
                    return subprocess.CompletedProcess(argv, 4, 'helper-unresolved-refused', '')

            for row in tracked.values():
                if time.monotonic() >= cleanup_deadline:
                    reason = reason or 'focused fenced cleanup deadline'
                    focused_seal.record_leftover(api.LEFTOVER_CHILDREN, {'pid': row[0], 'birth': row, 'reason': 'cleanup deadline; no unfenced signal'})
                    continue
                status = bounded_helper([str(helper), 'status', *row])
                if status.returncode == 3:
                    continue
                reason = reason or 'focused process remained after root exit'
                for sig in (signal.SIGTERM, signal.SIGKILL):
                    result = bounded_helper([str(helper), 'signal', *row, str(int(sig))])
                    signals.append({'birth': row, 'signal': int(sig), 'exit': result.returncode})
                    if result.returncode == 3:
                        break
                    if result.returncode != 0:
                        break
                    time.sleep(0.25)
                check = bounded_helper([str(helper), 'status', *row])
                if check.returncode != 3:
                    focused_seal.record_leftover(api.LEFTOVER_CHILDREN, {'pid': row[0], 'birth': row, 'reason': 'focused fenced cleanup unresolved'})
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                reason = reason or 'focused root remains'
                if not tracked:
                    focused_seal.record_leftover(api.LEFTOVER_CHILDREN, {'birth': None}, unverified_label='focused-step')
    if sibling:
        try:
            focused_seal.require_quiescent(root, helper)
        except focused_seal.BusyRoot as error:
            reason = reason or 'same-uid run-root process remains after fenced cleanup'
            for row in error.rows:
                birth = row['birth']
                if not any(tuple(map(str, child['birth'])) == tuple(birth) for child in api.LEFTOVER_CHILDREN):
                    focused_seal.record_leftover(api.LEFTOVER_CHILDREN, {'pid': row['pid'], 'birth': birth, 'reason': 'retained own birth still holds run-root after fenced cleanup'})
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            reason = reason or 'post-workload root-use observation unresolved: ' + str(error)
    result = {'argv': argv, 'environmentKeys': sorted(env), 'cwd': str(workspace), 'timeoutSeconds': timeout, 'newSession': sibling, 'executableSamples': executable_samples, 'connectionSamples': connection_samples, 'exit': proc.returncode, 'reason': reason, 'retainedBirths': list(tracked.values()), 'listenerSamples': samples, 'signals': signals, 'log': str(log.relative_to(root))}
    if trace is not None:
        try:
            result['executionTrace'] = trace.finish()
        except (ValueError, OSError) as error:
            result['executionTrace'] = {'ok': False, 'error': str(error)}
        result['executableSamples'] = executable_samples
        if not result['executionTrace']['ok']:
            result['reason'] = result['reason'] or 'execution trace or Node hello coverage failed'
    if mediation is not None:
        try:
            result['nodeEntryRoles'] = mediation.roles.finish()
            result['recipientMediation'] = mediation.finish(trace is not None)
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            result['recipientMediation'] = {'ok': False, 'cleanupRaceCounts': mediation.race_counts(), 'error': str(error), 'requests': mediation.requests, 'profileApprovals': [record['state'] for record in mediation.records.values()]}
            mediation.close()
            result['reason'] = result['reason'] or 'recipient profile or signal mediation failed'
    api.write_json(root / (tag + '-process.json'), result, root)
    return result, log


def run(api, root, workspace, env, tools, real_home):
    pty_controls.require_precondition(root, pty_controls.os_build(env))
    manifest_path = workspace / 'scripts/gates/darwin/focused-manifest.json'
    manifest = json.loads(manifest_path.read_text())
    if manifest['version'] != 1 or tuple(item['path'] for item in manifest['files']) != focused_audit.FILES:
        raise api.Refusal('focused manifest schema or file list changed')
    audit = focused_audit.validate(workspace, 'scripts/gates/darwin/focused-sibling-audit.json')
    validate_native_edges(audit['nativeEdges'])
    if manifest.get('recipientPolicy') != focused_mediation.focused_profile.TEMPLATE:
        raise api.Refusal('focused recipient policy template mismatch')
    focused_diagnostics.validate_ready()
    api.write_json(root / 'focused-audit.json', audit, root)
    compiler_hash = focused_native.digest(root / 'compiler.sb')
    narrowed = workload_profile((root / 'workload.sb').read_text(), tools)
    (root / 'workload.sb').write_text(narrowed)
    env['SCG_SB_PROFILE'] = narrowed
    if focused_native.digest(root / 'compiler.sb') != compiler_hash:
        raise api.Refusal('focused build must reuse unchanged compiler profile')
    controls = control_state(root, workspace, env['SCG_NODE_BIN'])
    source_manifest = json.loads((root / 'source-manifest.json').read_text())
    native_source_pins = {kind: source_manifest['v2/daemon/native/' + kind + '.c']['sha256'] for kind in ('delivery-file', 'peercred')}
    prefix = ['/usr/bin/sandbox-exec', '-f', str(root / 'workload.sb')]
    focused_seal.quiescence_input(root, root / 'scope')
    result, _ = supervise(api, root, workspace, env, prefix + ['/bin/bash', str(workspace / 'scripts/gates/darwin/workload.sh'), str(workspace / 'scripts/gates/darwin/focused-manifest-body.sh')], 'focused-prepare')
    if result['exit'] != 0 or result['reason']:
        raise api.Refusal('focused offline dependency/build phase failed')
    if control_state(root, workspace, env['SCG_NODE_BIN']) != controls:
        raise api.Refusal('trusted focused control or runtime changed during preparation')
    packages, package_log = supervise(api, root, workspace, env, prefix + [env['SCG_NODE_BIN'], str(workspace / 'scripts/gates/darwin/focused-packages.mjs')], 'focused-packages')
    if packages['exit'] != 0 or packages['reason'] or sorted(json.loads(package_log.read_text()), key=lambda row: row['specifier']) != sorted(audit['packages'], key=lambda row: row['specifier']):
        raise api.Refusal('resolved bare packages differ from reviewed audit')
    focused_audit.validate(workspace, 'scripts/gates/darwin/focused-sibling-audit.json')
    census_process, census_log = supervise(api, root, workspace, env, prefix + [env['SCG_NODE_BIN'], str(workspace / 'scripts/gates/darwin/focused-census.mjs')], 'focused-census')
    census = json.loads(census_log.read_text())
    api.write_json(root / 'focused-census.json', census, root)
    if census_process['exit'] != 0 or census_process['reason'] or not census['ok']:
        raise api.Refusal('TypeScript AST module/capability census failed')
    dependencies = dependency_state(workspace)
    api.write_json(root / 'focused-dependencies.json', dependencies, root)
    for kind in ('delivery-file', 'peercred'):
        directory = workspace / 'dist/v2' / kind / 'darwin-arm64'
        for name in (kind + '.node', 'manifest.json'):
            path = directory / name
            if path.exists() or path.is_symlink():
                focused_native.confined(path, root).unlink()
        native = focused_native.build(root, workspace, tools, env['SCG_NODE_BIN'], env, kind, source_sha256=native_source_pins[kind])
        api.write_json(root / ('focused-native-build-' + kind + '.json'), native, root)
        focused_seal.quiescence_input(root, root / 'scope')
        probe_path = workspace / ('scripts/probe-' + kind + '.mjs')
        probe, _ = supervise(api, root, workspace, env, prefix + [env['SCG_NODE_BIN'], str(probe_path)], 'focused-native-probe-' + kind)
        if probe['exit'] != 0 or probe['reason']:
            raise api.Refusal('non-optional confined native probe failed: ' + kind)
    focused_seal.quiescence_input(root, root / 'scope')
    before_artifact = artifacts(workspace, root)
    resolved_edges = []
    for edge in audit['nativeEdges']:
        kind = 'peercred' if '/peercred/' in edge['artifact'] else 'delivery-file'
        state = before_artifact[kind]['files'][edge['artifact']]
        resolved_edges.append(dict(edge, sha256=state['sha256'], inode=state['ino'], mtimeNs=state['mtimeNs']))
    api.write_json(root / 'focused-native-edges.json', resolved_edges, root)
    outcomes = []
    sealed_context = None
    for mode in ('outer', 'sibling-instrumented', 'sibling-production'):
        if mode != 'outer' and sealed_context is None:
            focused_seal.require_quiescent(root, root / 'scope')
            sealed_context = focused_seal.prepare(root, workspace, env['SCG_NODE_BIN'], audit, controls, before_artifact, dependencies)
            sealed_controls = sealed_control_state(sealed_context[0], sealed_context[1])
            sealed_artifacts = artifacts(sealed_context[1], root)
            sealed_dependencies = dependency_state(sealed_context[1])
            sealed_node_digest = focused_native.digest(Path(sealed_context[2]))
        selected = manifest['files'] if mode == 'outer' else [dict(item, sibling=[name]) for item in manifest['files'] for name in item['sibling']]
        for number, item in enumerate(selected):
            names = item['outer' if mode == 'outer' else 'sibling']
            if not names:
                continue
            if control_state(root, workspace, env['SCG_NODE_BIN']) != controls:
                raise api.Refusal('trusted focused control or runtime changed before launch')
            if dependency_state(workspace) != dependencies:
                raise api.Refusal('focused dependencies changed before launch')
            for record in audit['files']:
                path = focused_audit.pinned_path(workspace, record['path'])
                if focused_native.digest(path) != record['sha256']:
                    raise api.Refusal('audited source drift before focused launch')
            if artifacts(workspace, root) != before_artifact:
                raise api.Refusal('native artifact changed before focused launch')
            sibling = mode != 'outer'
            active_workspace = sealed_context[1] if sibling else workspace
            active_node = sealed_context[2] if sibling else env['SCG_NODE_BIN']
            active_artifacts = sealed_artifacts if sibling else before_artifact
            if sibling:
                require_sealed_controls(sealed_context[0], active_workspace, sealed_controls)
                focused_seal.require_quiescent(root, sealed_context[0] / 'control/scope')
                fresh = sealed_context[0] / (('i' if mode == 'sibling-instrumented' else 'p') + str(number))
                fresh.mkdir(mode=0o700)
                child_env = api.environment(fresh, active_node)
                for key in api.DIRS:
                    Path(child_env[key]).mkdir(mode=0o700, parents=True, exist_ok=True)
                child_env['SCG_NODE_BIN'] = active_node
                if focused_native.digest(focused_native.confined(Path(active_node), root)) != sealed_node_digest or dependency_state(active_workspace) != sealed_dependencies or artifacts(active_workspace, root) != sealed_artifacts:
                    raise api.Refusal('sealed sibling inputs changed')
                for record in audit['files']:
                    if record['siblingClosure'] and focused_native.digest(focused_audit.pinned_path(active_workspace, record['path'])) != record['sha256']:
                        raise api.Refusal('sealed closure source drift')
            else:
                child_env = dict(env)
            focused_audit.validate_gate_pins(active_workspace, audit['gatePins'])
            child_env['SCG_DELIVERY_FILE_PREBUILT_ONLY'] = '1'
            if sibling:
                child_env['PATH'] = str(Path(active_node).parent) + ':/usr/bin:/bin'
                api.validate(root, child_env, real_home)
                before = focused_sentinel.snapshot(real_home)
                before_agents = before['Library/LaunchAgents'] if before['Library/LaunchAgents'].get('unobservable') else api.launchagents(real_home)
                api.write_json(root / ('focused-home-before-' + mode + '.json'), before, root)
                api.write_json(root / ('focused-launchagents-before-' + mode + '.json'), before_agents, root)
            pattern = '^(?:' + '|'.join(re.escape(name) for name in names) + ')$'
            command = [active_node, '--test', '--test-concurrency=1', '--test-reporter=tap', '--test-name-pattern=' + pattern, item['path']]
            tmux_diagnostics = None
            if mode == 'outer' and item['path'] == 'v2/daemon/tests/multiline-fallback-tmux.test.ts':
                child_env['XDG_CONFIG_HOME'] = str(Path(child_env['HOME']) / '.config')
                tmux_config = require_tmux_config_absent(root, child_env)
                tmux_diagnostics = root / 'logs/focused-tmux-diagnostics.jsonl'
                descriptor = os.open(tmux_diagnostics, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                os.close(descriptor)
                child_env['SCG_TMUX_DIAGNOSTIC_FILE'] = str(tmux_diagnostics)
                command[1:1] = ['--import', str(active_workspace / 'scripts/gates/darwin/focused-tmux-diagnostics.mjs')]
            if mode == 'sibling-instrumented':
                command.insert(2, '--test-isolation=none')
            verdict = {'ok': False, 'file': item['path'], 'mode': mode, 'harnessOutsideOuterSeatbelt': sibling, 'excludedNotProof': item['excluded'], 'excludedDisclosures': item.get('excludedDisclosures', {})}
            try:
                mediation = focused_mediation.Mediation(root, active_workspace, active_node, child_env['TMPDIR'], names[0], manifest['recipientPolicy'], active_workspace / 'scripts/gates/darwin/focused-render-profile.mjs', dict(child_env, NODE_DISABLE_COMPILE_CACHE='1'), ['/usr/bin/sandbox-exec', '-f', str(sealed_context[0] / 'control/workload.sb')], helper=sealed_context[0] / 'control/scope', entries={str(active_workspace / row['path']): row['role'] for row in audit['nodeEntries']}) if sibling else None
                trace = focused_trace.Trace(root, active_workspace, active_node, audit, active_artifacts, mediation=mediation) if mode == 'sibling-instrumented' else None
                result, log = supervise(api, root, active_workspace, child_env, command if sibling else prefix + command, 'focused-' + mode + '-' + str(number), trace=trace, sibling=sibling, mediation=mediation)
                verdict['harnessArgv'] = result['argv']
                verdict['isolationNoneInstrumentedOnly'] = mode == 'sibling-instrumented'
                if mode == 'sibling-instrumented':
                    verdict['isolationReason'] = 'default test runner child is born before preloader hooks and loses inherited trace fd; instrumented only uses isolation=none; plain run uses default isolation'
                verdict.update(focused_tap.adjudicate(log.read_text(), names, result['exit']))
                verdict['processReason'] = result['reason']
                if tmux_diagnostics is not None:
                    verdict['tmuxConfigAbsent'] = tmux_config
                    verdict['tmuxDiagnostics'] = load_tmux_diagnostics(tmux_diagnostics, names)
                    verdict['tmuxDiagnostics']['failureEnums'] = sorted(set(re.findall(r'^# SCG_TMUX_DIAGNOSTIC_FAILURE=(append_eacces|append_enospc|append_emfile|append_other|realpath_failed|capture_failed|emit_failed|metadata_failed|hook_failed|diagnostic_failed)$', log.read_text(), re.M)))
                if result['reason']:
                    verdict['ok'] = False
                matrix_rows = [row for row in verdict['expectedRows'] if row['fullName'].startswith('Darwin OS-level file read outside cwd: ')]
                if matrix_rows:
                    verdict['diagnostics'] = focused_diagnostics.check(matrix_rows, ('cell-sandbox', 'satellite-default') if sibling else ('hsr',))
                    verdict['ok'] = verdict['ok'] and verdict['diagnostics']['ok']
            except (ValueError, OSError, subprocess.SubprocessError, api.Refusal) as error:
                verdict.update({'ok': False, 'error': str(error)})
            finally:
                try:
                    if sibling:
                        after = focused_sentinel.snapshot(real_home)
                        after_agents = after['Library/LaunchAgents'] if after['Library/LaunchAgents'].get('unobservable') else api.launchagents(real_home)
                        api.write_json(root / ('focused-home-after-' + mode + '.json'), after, root)
                        api.write_json(root / ('focused-launchagents-after-' + mode + '.json'), after_agents, root)
                        verdict['homeMetadataUnchanged'] = before == after
                        verdict['launchAgentsUnchanged'] = before_agents == after_agents
                        if before != after or before_agents != after_agents:
                            verdict['ok'] = False
                    focused_audit.validate_gate_pins(active_workspace, audit['gatePins'])
                    verdict['artifactUnchanged'] = artifacts(active_workspace, root) == active_artifacts
                    if sibling:
                        require_sealed_controls(sealed_context[0], active_workspace, sealed_controls)
                        verdict['sealedDependenciesUnchanged'] = dependency_state(active_workspace) == sealed_dependencies
                        if focused_native.digest(focused_native.confined(Path(active_node), root)) != sealed_node_digest:
                            raise api.Refusal('sealed Node bytes changed')
                        for record in audit['files']:
                            if record['siblingClosure'] and focused_native.digest(focused_audit.pinned_path(active_workspace, record['path'])) != record['sha256']:
                                raise api.Refusal('sealed closure changed during sibling run')
                        verdict['ok'] = verdict['ok'] and verdict['sealedDependenciesUnchanged']
                    verdict['ok'] = verdict['ok'] and verdict['artifactUnchanged']
                except (ValueError, OSError) as error:
                    verdict.update({'ok': False, 'closingError': str(error)})
                outcomes.append(verdict)
                api.write_json(root / 'focused-rows.json', outcomes, root)
    if sealed_context is not None:
        require_sealed_controls(sealed_context[0], sealed_context[1], sealed_controls)
    expected = sum(len(item['outer']) + len(item['sibling']) for item in manifest['files'])
    passed = sum(row.get('classification') == 'PASS' for outcome in outcomes if outcome['mode'] != 'sibling-instrumented' for row in outcome.get('expectedRows', []))
    pairs = {}
    for mode in ('sibling-instrumented', 'sibling-production'):
        rows = [row for row in outcomes if row['mode'] == mode]
        diagnostics = [item for row in rows for item in row.get('diagnostics', {}).get('rows', [])]
        names = [row['fullName'] for row in diagnostics]
        pairs[mode] = {'ok': len(rows) == 2 and len(names) == len(set(names)) == 2 and all(row['ok'] for row in rows), 'diagnostics': {'rows': diagnostics}, 'harnessArgv': [row.get('harnessArgv') for row in rows]}
    pair = focused_diagnostics.compare_pair(pairs['sibling-instrumented'], pairs['sibling-production'])
    api.write_json(root / 'focused-pair.json', pair, root)
    ok = bool(outcomes) and all(row['ok'] for row in outcomes) and passed == expected and pair['ok']
    api.write_json(root / 'focused-summary.json', {'ok': ok, 'limitations': LIMITATIONS, 'excludedDisclosures': {name: text for item in manifest['files'] for name, text in item.get('excludedDisclosures', {}).items()}, 'required': expected, 'passed': passed, 'excludedNotProof': sum(len(item['excluded']) for item in manifest['files']), 'siblingRows': sum(len(item['sibling']) for item in manifest['files']), 'harnessOutsideOuterSeatbelt': True}, root)
    return 0 if ok else 95


def load_tmux_diagnostics(path, names):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        import stat
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 8388608:
            raise ValueError('tmux diagnostic evidence unsafe or oversized')
        with os.fdopen(fd, 'rb') as stream:
            fd = None
            data = stream.read(8388609)
        if len(data) > 8388608:
            raise ValueError('tmux diagnostic evidence grew beyond bound')
        rows = [json.loads(line) for line in data.splitlines()]
        if any(not valid_tmux_row(row, names) for row in rows):
            raise ValueError('tmux diagnostic row outside selected manifest')
        return {'path': str(path), 'rows': {name: [row for row in rows if row['row'] == name] for name in names}, 'serverStderrScope': 'fixed classifications, byte counts and hashes only; daemon-only stderr is not separately redirected', 'terminalCaptureBound': 'at most four panes, last 80 lines and 32768 captured bytes per command; counts, hashes and fixed fixture-marker booleans only; at most 128 records per row'}
    finally:
        if fd is not None:
            os.close(fd)


def valid_tmux_row(row, names):
    failures = {None, 'append_eacces', 'append_enospc', 'append_emfile', 'append_other', 'realpath_failed', 'capture_failed', 'emit_failed', 'metadata_failed', 'hook_failed', 'diagnostic_failed'}
    errors = {None, 'ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EMFILE', 'ENFILE', 'EINVAL', 'EIO', 'ENOMEM', 'ETIMEDOUT', 'ENOBUFS', 'EPIPE', 'OTHER'}
    classes = {'forkpty_failed', 'posix_openpt_failed', 'operation_not_permitted', 'permission_denied', 'not_a_terminal', 'no_server_running', 'server_exited_unexpectedly', 'error_connecting', 'socket_path', 'create_window_failed', 'other_nonempty', 'empty'}
    kinds = {'tmux-command': {'operation'}, 'pane-list': set(), 'terminal-capture': {'pane'}}
    base = {'row', 'kind', 'exit', 'signal', 'error', 'stderr', 'diagnosticFailure'}
    if not isinstance(row, dict) or not isinstance(row.get('kind'), str) or row['kind'] not in kinds or set(row) != base | kinds[row['kind']] or row.get('row') not in names:
        return False
    if any(value is not None and not isinstance(value, str) for value in (row['diagnosticFailure'], row['error'])):
        return False
    if row['diagnosticFailure'] not in failures or row['error'] not in errors or any(value is not None and type(value) is not int for value in (row['exit'], row['signal'])):
        return False
    def hashed(value, keys):
        return isinstance(value, dict) and set(value) == keys and type(value['byteCount']) is int and value['byteCount'] >= 0 and isinstance(value['sha256'], str) and re.fullmatch(r'[0-9a-f]{64}', value['sha256']) is not None
    if not hashed(row['stderr'], {'byteCount', 'sha256', 'classes'}) or not isinstance(row['stderr']['classes'], list) or not row['stderr']['classes'] or any(not isinstance(value, str) or value not in classes for value in row['stderr']['classes']):
        return False
    if row['kind'] == 'terminal-capture':
        pane = row['pane']
        if not hashed(pane, {'byteCount', 'sha256', 'lineCount', 'markers'}) or type(pane['lineCount']) is not int or pane['lineCount'] < 0 or not isinstance(pane['markers'], dict) or set(pane['markers']) != {'phoneTerminalReady', 'received', 'pointer'} or any(type(value) is not bool for value in pane['markers'].values()):
            return False
    if row['kind'] == 'tmux-command' and (not isinstance(row['operation'], str) or row['operation'] not in {'new-session', 'new-window', 'kill-server', 'kill-session', 'kill-pane', 'list-panes', 'list-sessions', 'capture-pane', 'display-message', 'show-options', 'set-option', 'set-options', 'send-keys', 'load-buffer', 'paste-buffer', 'delete-buffer', 'resize-pane', 'select-pane', 'has-session', 'other'}):
        return False
    return True


def require_tmux_config_absent(root, env):
    home = Path(env['HOME'])
    if not home.is_absolute() or home.resolve(strict=True) != home or root.resolve() not in home.parents:
        raise ValueError('tmux fake HOME redirected or outside root')
    config = Path(env['XDG_CONFIG_HOME'])
    paths = (home / '.tmux.conf', config / 'tmux/tmux.conf', home / '.config/tmux/tmux.conf')
    for path in paths:
        if not path.is_absolute() or home not in path.parents or path.resolve(strict=False) != path or path.exists() or path.is_symlink():
            raise ValueError('tmux configuration present, redirected or outside fake HOME')
    return {'ok': True, 'paths': sorted(set(str(path.relative_to(home)) for path in paths)), 'userConfigAbsent': True}
