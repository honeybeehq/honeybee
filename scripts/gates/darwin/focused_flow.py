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


def workload_profile(base, tools):
    literals = [tools['clang'], tools['ld'], '/usr/bin/cc', '/usr/bin/c++', '/usr/bin/gcc', '/usr/bin/g++', '/usr/bin/clang', '/usr/bin/clang++', '/usr/bin/ld', '/usr/bin/as', '/usr/bin/xcrun', '/usr/bin/xcodebuild']
    return base + '(deny process-exec ' + ' '.join('(literal ' + json.dumps(path) + ')' for path in literals) + ' (subpath ' + json.dumps(tools['toolchain']) + ') (subpath "/Library/Developer/CommandLineTools"))'


def control_state(root, workspace, node):
    paths = [root / 'scope', root / 'compiler.sb', root / 'workload.sb', root / 'compiler-version.log', Path(node)]
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


def supervise(api, root, workspace, env, argv, tag, timeout=600):
    helper = root / 'scope'
    read_fd, release_fd = os.pipe()
    tracked = {}
    exited = set()
    samples = []
    signals = []
    reason = None
    log = root / 'logs' / (tag + '.tap')
    with log.open('xb') as output:
        try:
            proc = subprocess.Popen([sys.executable, '-B', str(workspace / 'scripts/gates/darwin/start_wait.py'), str(read_fd), *argv], pass_fds=(read_fd,), cwd=workspace, env=env, stdout=output, stderr=subprocess.STDOUT)
        except OSError:
            os.close(read_fd)
            os.close(release_fd)
            raise
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
                for row in api.scope_call(helper, 'scan', *birth):
                    tracked.setdefault((row[0], row[2], row[3]), row)
                for sample in api.sample_retained_listeners(helper, tracked, exited):
                    samples.append(sample)
                    if sample.get('error') or any(not listener['loopback'] for listener in sample['listeners']):
                        raise ValueError('focused listener observation failed or non-loopback listener')
                if time.monotonic() - started > timeout:
                    raise ValueError('focused hard timeout')
                time.sleep(0.05)
        except (ValueError, OSError, subprocess.SubprocessError, api.Refusal) as error:
            reason = str(error)
        finally:
            if release_fd is not None:
                os.close(release_fd)
            for row in tracked.values():
                status = subprocess.run([str(helper), 'status', *row], capture_output=True, text=True)
                if status.returncode == 3:
                    continue
                reason = reason or 'focused process remained after root exit'
                for sig in (signal.SIGTERM, signal.SIGKILL):
                    result = subprocess.run([str(helper), 'signal', *row, str(int(sig))], capture_output=True, text=True)
                    signals.append({'birth': row, 'signal': int(sig), 'exit': result.returncode})
                    if result.returncode == 3:
                        break
                    if result.returncode != 0:
                        break
                    time.sleep(0.25)
                check = subprocess.run([str(helper), 'status', *row], capture_output=True, text=True)
                if check.returncode != 3:
                    api.LEFTOVER_CHILDREN.append({'pid': row[0], 'birth': row, 'reason': 'focused fenced cleanup unresolved'})
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                reason = reason or 'focused root remains'
                if not tracked:
                    api.LEFTOVER_CHILDREN.append({'pid': proc.pid, 'birth': None, 'reason': 'birth unobserved, not fenced'})
    result = {'argv': argv, 'environmentKeys': sorted(env), 'cwd': str(workspace), 'timeoutSeconds': timeout, 'exit': proc.returncode, 'reason': reason, 'retainedBirths': list(tracked.values()), 'listenerSamples': samples, 'signals': signals, 'log': str(log.relative_to(root))}
    api.write_json(root / (tag + '-process.json'), result, root)
    return result, log


def run(api, root, workspace, env, tools, real_home):
    manifest_path = workspace / 'scripts/gates/darwin/focused-manifest.json'
    manifest = json.loads(manifest_path.read_text())
    if manifest['version'] != 1 or tuple(item['path'] for item in manifest['files']) != focused_audit.FILES:
        raise api.Refusal('focused manifest schema or file list changed')
    audit = focused_audit.validate(workspace, 'scripts/gates/darwin/focused-sibling-audit.json')
    focused_diagnostics.validate_ready()
    api.write_json(root / 'focused-audit.json', audit, root)
    compiler_hash = focused_native.digest(root / 'compiler.sb')
    narrowed = workload_profile((root / 'workload.sb').read_text(), tools)
    (root / 'workload.sb').write_text(narrowed)
    env['SCG_SB_PROFILE'] = narrowed
    if focused_native.digest(root / 'compiler.sb') != compiler_hash:
        raise api.Refusal('focused build must reuse unchanged compiler profile')
    controls = control_state(root, workspace, env['SCG_NODE_BIN'])
    prefix = ['/usr/bin/sandbox-exec', '-f', str(root / 'workload.sb')]
    result, _ = supervise(api, root, workspace, env, prefix + ['/bin/bash', str(workspace / 'scripts/gates/darwin/workload.sh'), str(workspace / 'scripts/gates/darwin/focused-manifest-body.sh')], 'focused-prepare')
    if result['exit'] != 0 or result['reason']:
        raise api.Refusal('focused offline dependency/build phase failed')
    if control_state(root, workspace, env['SCG_NODE_BIN']) != controls:
        raise api.Refusal('trusted focused control or runtime changed during preparation')
    packages, package_log = supervise(api, root, workspace, env, prefix + [env['SCG_NODE_BIN'], str(workspace / 'scripts/gates/darwin/focused-packages.mjs')], 'focused-packages')
    if packages['exit'] != 0 or packages['reason'] or sorted(json.loads(package_log.read_text()), key=lambda row: row['specifier']) != sorted(audit['packages'], key=lambda row: row['specifier']):
        raise api.Refusal('resolved bare packages differ from reviewed audit')
    dependencies = dependency_state(workspace)
    api.write_json(root / 'focused-dependencies.json', dependencies, root)
    for kind in ('delivery-file', 'peercred'):
        directory = workspace / 'dist/v2' / kind / 'darwin-arm64'
        for name in (kind + '.node', 'manifest.json'):
            path = directory / name
            if path.exists() or path.is_symlink():
                focused_native.confined(path, root).unlink()
        native = focused_native.build(root, workspace, tools, env['SCG_NODE_BIN'], env, kind)
        api.write_json(root / ('focused-native-build-' + kind + '.json'), native, root)
        probe_path = workspace / ('scripts/probe-' + kind + '.mjs')
        probe, _ = supervise(api, root, workspace, env, prefix + [env['SCG_NODE_BIN'], str(probe_path)], 'focused-native-probe-' + kind)
        if probe['exit'] != 0 or probe['reason']:
            raise api.Refusal('non-optional confined native probe failed: ' + kind)
    before_artifact = artifacts(workspace, root)
    outcomes = []
    for mode in ('outer', 'sibling'):
        for number, item in enumerate(manifest['files']):
            names = item[mode]
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
            sibling = mode == 'sibling'
            child_env = api.environment(root, env['SCG_NODE_BIN']) if sibling else dict(env)
            child_env['SCG_DELIVERY_FILE_PREBUILT_ONLY'] = '1'
            if sibling:
                child_env['PATH'] = str(Path(env['SCG_NODE_BIN']).parent) + ':/usr/bin:/bin'
                api.validate(root, child_env, real_home)
                before = focused_sentinel.snapshot(real_home, ('Library', *api.PROVIDERS))
                before_agents = api.launchagents(real_home)
                api.write_json(root / 'focused-home-before.json', before, root)
                api.write_json(root / 'focused-launchagents-before.json', before_agents, root)
            pattern = '^(?:' + '|'.join(re.escape(name) for name in names) + ')$'
            command = [env['SCG_NODE_BIN'], '--test', '--test-concurrency=1', '--test-reporter=tap', '--test-name-pattern=' + pattern, item['path']]
            verdict = {'ok': False, 'file': item['path'], 'mode': mode, 'harnessOutsideOuterSeatbelt': sibling, 'excludedNotProof': item['excluded']}
            try:
                result, log = supervise(api, root, workspace, child_env, command if sibling else prefix + command, 'focused-' + mode + '-' + str(number))
                verdict.update(focused_tap.adjudicate(log.read_text(), names, result['exit']))
                verdict['processReason'] = result['reason']
                if result['reason']:
                    verdict['ok'] = False
                if sibling:
                    verdict['diagnostics'] = focused_diagnostics.check(verdict['expectedRows'])
                    verdict['ok'] = verdict['ok'] and verdict['diagnostics']['ok']
            except (ValueError, OSError, subprocess.SubprocessError, api.Refusal) as error:
                verdict.update({'ok': False, 'error': str(error)})
            finally:
                try:
                    if sibling:
                        after = focused_sentinel.snapshot(real_home, ('Library', *api.PROVIDERS))
                        after_agents = api.launchagents(real_home)
                        api.write_json(root / 'focused-home-after.json', after, root)
                        api.write_json(root / 'focused-launchagents-after.json', after_agents, root)
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
    passed = sum(row.get('classification') == 'PASS' for outcome in outcomes for row in outcome.get('expectedRows', []))
    ok = bool(outcomes) and all(row['ok'] for row in outcomes) and passed == expected
    api.write_json(root / 'focused-summary.json', {'ok': ok, 'required': expected, 'passed': passed, 'excludedNotProof': sum(len(item['excluded']) for item in manifest['files']), 'siblingRows': sum(len(item['sibling']) for item in manifest['files']), 'harnessOutsideOuterSeatbelt': True}, root)
    return 0 if ok else 95
