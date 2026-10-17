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
import focused_sentinel
import focused_tap
import focused_trace


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


def supervise(api, root, workspace, env, argv, tag, timeout=600, trace=None):
    helper = root / 'scope'
    read_fd, release_fd = os.pipe()
    tracked = {}
    exited = set()
    samples = []
    signals = []
    reason = None
    executable_samples = []
    if trace is not None:
        env = trace.environment(env)
        argv = trace.command(argv)
    log = root / 'logs' / (tag + '.tap')
    with log.open('xb') as output:
        try:
            proc = subprocess.Popen([sys.executable, '-B', str(workspace / 'scripts/gates/darwin/start_wait.py'), str(read_fd), *argv], pass_fds=(read_fd,) + ((trace.write_fd,) if trace is not None else ()), cwd=workspace, env=env, stdout=output, stderr=subprocess.STDOUT)
        except OSError:
            os.close(read_fd)
            os.close(release_fd)
            if trace is not None:
                trace.finish()
            raise
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
            tracked[(birth[0], birth[2], birth[3])] = birth
            os.write(release_fd, b'1')
            os.close(release_fd)
            release_fd = None
            while proc.poll() is None:
                if trace is not None:
                    trace.drain()
                for row in api.scope_call(helper, 'scan', *birth):
                    tracked.setdefault((row[0], row[2], row[3]), row)
                for sample in api.sample_retained_listeners(helper, tracked, exited):
                    samples.append(sample)
                    if sample.get('error') or any(not listener['loopback'] for listener in sample['listeners']):
                        raise ValueError('focused listener observation failed or non-loopback listener')
                if trace is not None:
                    for key, row in tracked.items():
                        if key in exited:
                            continue
                        observed = subprocess.run([str(helper), 'executable', *row], capture_output=True, text=True, timeout=2)
                        executable = observed.stdout.strip()
                        executable_samples.append({'birth': row, 'timestamp': time.time(), 'exit': observed.returncode, 'executable': executable})
                        if observed.returncode == 3:
                            continue
                        if observed.returncode != 0:
                            raise ValueError('unresolved own executable observation')
                        if executable == env.get('SCG_NODE_BIN', trace.policy['node']):
                            trace.node_pids.add(int(row[0]))
                        elif executable != '/usr/bin/sandbox-exec' and not (int(row[0]) == proc.pid and executable == str(Path(sys.executable).resolve())):
                            raise ValueError('own executable outside sibling allowlist')
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
                    api.LEFTOVER_CHILDREN.append({'pid': row[0], 'birth': row, 'reason': 'cleanup deadline; no unfenced signal'})
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
                    api.LEFTOVER_CHILDREN.append({'pid': row[0], 'birth': row, 'reason': 'focused fenced cleanup unresolved'})
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                reason = reason or 'focused root remains'
                if not tracked:
                    api.LEFTOVER_CHILDREN.append({'pid': proc.pid, 'birth': None, 'reason': 'birth unobserved, not fenced'})
    result = {'argv': argv, 'environmentKeys': sorted(env), 'cwd': str(workspace), 'timeoutSeconds': timeout, 'exit': proc.returncode, 'reason': reason, 'retainedBirths': list(tracked.values()), 'listenerSamples': samples, 'signals': signals, 'log': str(log.relative_to(root))}
    if trace is not None:
        try:
            result['executionTrace'] = trace.finish()
        except (ValueError, OSError) as error:
            result['executionTrace'] = {'ok': False, 'error': str(error)}
        result['executableSamples'] = executable_samples
        if not result['executionTrace']['ok']:
            result['reason'] = result['reason'] or 'execution trace or Node hello coverage failed'
    api.write_json(root / (tag + '-process.json'), result, root)
    return result, log


def run(api, root, workspace, env, tools, real_home):
    manifest_path = workspace / 'scripts/gates/darwin/focused-manifest.json'
    manifest = json.loads(manifest_path.read_text())
    if manifest['version'] != 1 or tuple(item['path'] for item in manifest['files']) != focused_audit.FILES:
        raise api.Refusal('focused manifest schema or file list changed')
    audit = focused_audit.validate(workspace, 'scripts/gates/darwin/focused-sibling-audit.json')
    validate_native_edges(audit['nativeEdges'])
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
        probe_path = workspace / ('scripts/probe-' + kind + '.mjs')
        probe, _ = supervise(api, root, workspace, env, prefix + [env['SCG_NODE_BIN'], str(probe_path)], 'focused-native-probe-' + kind)
        if probe['exit'] != 0 or probe['reason']:
            raise api.Refusal('non-optional confined native probe failed: ' + kind)
    before_artifact = artifacts(workspace, root)
    resolved_edges = []
    for edge in audit['nativeEdges']:
        kind = 'peercred' if '/peercred/' in edge['artifact'] else 'delivery-file'
        state = before_artifact[kind]['files'][edge['artifact']]
        resolved_edges.append(dict(edge, sha256=state['sha256'], inode=state['ino'], mtimeNs=state['mtimeNs']))
    api.write_json(root / 'focused-native-edges.json', resolved_edges, root)
    outcomes = []
    for mode in ('outer', 'sibling-instrumented', 'sibling-production'):
        for number, item in enumerate(manifest['files']):
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
            child_env = api.environment(root, env['SCG_NODE_BIN']) if sibling else dict(env)
            child_env['SCG_DELIVERY_FILE_PREBUILT_ONLY'] = '1'
            if sibling:
                child_env['PATH'] = str(Path(env['SCG_NODE_BIN']).parent) + ':/usr/bin:/bin'
                api.validate(root, child_env, real_home)
                before = focused_sentinel.snapshot(real_home, ('Library', *api.PROVIDERS))
                before_agents = api.launchagents(real_home)
                api.write_json(root / ('focused-home-before-' + mode + '.json'), before, root)
                api.write_json(root / ('focused-launchagents-before-' + mode + '.json'), before_agents, root)
            pattern = '^(?:' + '|'.join(re.escape(name) for name in names) + ')$'
            command = [env['SCG_NODE_BIN'], '--test', '--test-concurrency=1', '--test-reporter=tap', '--test-name-pattern=' + pattern, item['path']]
            if mode == 'sibling-instrumented':
                command.insert(2, '--test-isolation=none')
            verdict = {'ok': False, 'file': item['path'], 'mode': mode, 'harnessOutsideOuterSeatbelt': sibling, 'excludedNotProof': item['excluded']}
            try:
                trace = focused_trace.Trace(root, workspace, env['SCG_NODE_BIN'], audit, before_artifact) if mode == 'sibling-instrumented' else None
                result, log = supervise(api, root, workspace, child_env, command if sibling else prefix + command, 'focused-' + mode + '-' + str(number), trace=trace)
                verdict['harnessArgv'] = result['argv']
                verdict['isolationNoneInstrumentedOnly'] = mode == 'sibling-instrumented'
                if mode == 'sibling-instrumented':
                    verdict['isolationReason'] = 'default test runner child is born before preloader hooks and loses inherited trace fd; instrumented only uses isolation=none; plain run uses default isolation'
                verdict.update(focused_tap.adjudicate(log.read_text(), names, result['exit']))
                verdict['processReason'] = result['reason']
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
                        after = focused_sentinel.snapshot(real_home, ('Library', *api.PROVIDERS))
                        after_agents = api.launchagents(real_home)
                        api.write_json(root / ('focused-home-after-' + mode + '.json'), after, root)
                        api.write_json(root / ('focused-launchagents-after-' + mode + '.json'), after_agents, root)
                        verdict['homeMetadataUnchanged'] = before == after
                        verdict['launchAgentsUnchanged'] = before_agents == after_agents
                        if before != after or before_agents != after_agents:
                            verdict['ok'] = False
                    verdict['artifactUnchanged'] = artifacts(workspace, root) == before_artifact
                    verdict['ok'] = verdict['ok'] and verdict['artifactUnchanged']
                except (ValueError, OSError) as error:
                    verdict.update({'ok': False, 'closingError': str(error)})
                outcomes.append(verdict)
                api.write_json(root / 'focused-rows.json', outcomes, root)
    expected = sum(len(item['outer']) + len(item['sibling']) for item in manifest['files'])
    passed = sum(row.get('classification') == 'PASS' for outcome in outcomes if outcome['mode'] != 'sibling-instrumented' for row in outcome.get('expectedRows', []))
    instrumented = next((row for row in outcomes if row['mode'] == 'sibling-instrumented'), None)
    production = next((row for row in outcomes if row['mode'] == 'sibling-production'), None)
    pair = focused_diagnostics.compare_pair(instrumented, production) if instrumented and production and 'diagnostics' in instrumented and 'diagnostics' in production else {'ok': False, 'reason': 'missing instrumented or production pair evidence'}
    api.write_json(root / 'focused-pair.json', pair, root)
    ok = bool(outcomes) and all(row['ok'] for row in outcomes) and passed == expected and pair['ok']
    api.write_json(root / 'focused-summary.json', {'ok': ok, 'required': expected, 'passed': passed, 'excludedNotProof': sum(len(item['excluded']) for item in manifest['files']), 'siblingRows': sum(len(item['sibling']) for item in manifest['files']), 'harnessOutsideOuterSeatbelt': True}, root)
    return 0 if ok else 95
