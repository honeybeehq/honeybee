import hashlib
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import time

import focused_profile
import focused_seal


READY = b'SCOPE_CONTROL_READY\n'
ENV_CANARY = 'scope-control-env-must-never-surface'


def observation(output, node, reader, cwd, sandboxed, policy, canary=ENV_CANARY):
    if canary in output or canary in policy:
        raise ValueError('scope observation surfaced environment bytes')
    result = focused_profile.parse_node_observation(output, node)
    if result['entry'] != str(reader) or result['cwd'] != str(cwd) or result['sandboxed'] != sandboxed:
        raise ValueError('real Node argv/cwd/sandbox state differs from control')
    expected = ['CELL 0', 'CONTENT 1' if sandboxed else 'CONTENT 0', 'SEALED 1' if sandboxed else 'SEALED 0']
    if policy.splitlines() != expected:
        raise ValueError('real sandbox write-policy control failed')
    return {'node': result, 'writePolicy': expected, 'environmentNeverSurfaced': True, 'exactReaderArgvVerifiedByScope': True}


def ready(process, timeout=5):
    deadline = time.monotonic() + timeout
    data = b''
    while data != READY:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([process.stdout], [], [], remaining)[0]:
            raise ValueError('scope control child readiness timeout')
        block = os.read(process.stdout.fileno(), len(READY) - len(data))
        if not block:
            raise ValueError('scope control child exited before readiness')
        data += block


def call(helper, verb, birth, *args):
    result = subprocess.run([str(helper), verb, *birth, *map(str, args)], capture_output=True, text=True, timeout=2)
    if result.returncode:
        raise ValueError('scope control ' + verb + ' failed: exit ' + str(result.returncode))
    if ENV_CANARY in result.stdout or ENV_CANARY in result.stderr:
        raise ValueError('scope control surfaced environment bytes')
    return result.stdout


def identity(helper, pid):
    result = subprocess.run([str(helper), 'identity', str(pid)], capture_output=True, text=True, timeout=2)
    lines = result.stdout.splitlines()
    values = lines[0].split() if len(lines) == 1 else []
    if result.returncode or len(values) != 4 or not all(value.isdigit() for value in values) or int(values[0]) != pid:
        raise ValueError('scope control child birth unavailable')
    focused_seal.remember_birth(values)
    return values


def child(api, root, helper, node, reader, cwd, env, sandboxed, profile, content, sealed):
    command = (['/usr/bin/sandbox-exec', '-f', str(profile)] if sandboxed else []) + [node, str(reader)]
    process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    focused_seal.remember_launch(process.pid)
    birth = None
    row = {'command': command, 'cwd': str(cwd), 'expectedSandboxed': sandboxed, 'cleanup': []}
    try:
        birth = identity(helper, process.pid)
        row['birth'] = birth
        ready(process)
        actual = call(helper, 'node-observation', birth, node, reader, '-')
        policy = call(helper, 'write-policy', birth, cwd, content, sealed)
        row.update(observation(actual, node, reader, cwd, sandboxed, policy))
        if not sandboxed:
            command, inventory = focused_seal.quiescence_input(root, helper)
            result = subprocess.run(command, input=inventory, capture_output=True, text=True, timeout=2)
            row['quiescence'] = focused_seal.quiescence_evidence(result)
            if result.returncode:
                raise ValueError('real quiescence control unresolved')
            uses = focused_seal.root_users(root, result.stdout, os.getpid())
            if not any(item['pid'] == process.pid for item in uses):
                raise ValueError('real quiescence failed to detect own cwd holder')
            row['liveQuiescence'] = {'detected': True, 'rows': [item for item in uses if item['birth'] == birth]}
        process.stdin.write(b'1')
        process.stdin.flush()
        process.wait(timeout=5)
        if process.returncode != 0:
            raise ValueError('scope control child nonzero exit')
        row['exit'] = process.returncode
        row['ok'] = True
    finally:
        try:
            if process.poll() is None:
                if birth is None:
                    birth = identity(helper, process.pid)
                for sig in (signal.SIGTERM, signal.SIGKILL):
                    result = subprocess.run([str(helper), 'signal', *birth, str(int(sig))], capture_output=True, text=True, timeout=2)
                    row['cleanup'].append({'birth': birth, 'signal': int(sig), 'exit': result.returncode})
                    if result.returncode not in (0, 3):
                        break
                    try:
                        process.wait(timeout=1)
                        break
                    except subprocess.TimeoutExpired:
                        pass
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            row['cleanupError'] = str(error)
            row['ok'] = False
        finally:
            if process.poll() is None:
                focused_seal.record_leftover(api.LEFTOVER_CHILDREN, {'pid': process.pid, 'birth': birth, 'reason': 'scope control cleanup unresolved; no unfenced signal', 'selfExpiresSeconds': 30})
                row['ok'] = False
            for stream in (process.stdin, process.stdout, process.stderr):
                try:
                    stream.close()
                except OSError as error:
                    row['cleanupError'] = str(error)
                    row['ok'] = False
            api.write_json(root / ('scope-control-' + ('positive' if sandboxed else 'negative') + '.json'), row, root)
    return row


def run(api, root, workspace, helper, node, env):
    if sys.platform != 'darwin':
        raise ValueError('real scope controls require Darwin')
    fixture = root / 't/scope-controls'
    fixture.mkdir(mode=0o700)
    work, data, sealed = (fixture / name for name in ('work', 'data', 'sealed'))
    for path in (work, data, sealed):
        path.mkdir(mode=0o700)
    content = data / 'content.txt'
    content.write_text('scope-control fixture')
    reader = workspace / 'scripts/gates/darwin/scope-control-child.mjs'
    profile = work / 'sandbox.sb'
    local = dict(env, NODE_DISABLE_COMPILE_CACHE='1', SCG_SCOPE_CONTROL_ENV_CANARY=ENV_CANARY)
    renderer = workspace / 'scripts/gates/darwin/focused-render-profile.mjs'
    command = ['/usr/bin/sandbox-exec', '-f', str(root / 'workload.sb'), node, str(renderer), str(workspace), str(fixture), str(profile), node, str(reader)]
    report = {'ok': False, 'realDarwinControls': True, 'rows': [], 'nativeArtifactsBuilt': False}
    try:
        rendered = subprocess.run(command, cwd=workspace, env=local, capture_output=True, text=True, timeout=10)
        if rendered.returncode:
            raise ValueError('scope control production renderer failed under unchanged outer profile')
        document = json.loads(rendered.stdout)
        if document['policy'] != {'cellDir': str(work), 'writablePaths': [], 'scratchPaths': []}:
            raise ValueError('scope control production policy changed')
        with profile.open('x') as output:
            output.write(document['profile'])
        profile.chmod(0o600)
        before = focused_profile.profile_state(profile, document['profile'].encode())
        for sandboxed in (False, True):
            row = child(api, root, helper, node, reader, work, local, sandboxed, profile, content, sealed)
            report['rows'].append(row)
            if not row.get('ok'):
                raise ValueError('scope control fenced cleanup failed')
            focused_seal.require_quiescent(root, helper)
            row['afterExitQuiescenceEmpty'] = True
            if not sandboxed:
                row['goneChildNotReported'] = True
                row['goneMethod'] = 'own child exited and reaped before real snapshot; transient enumeration races additionally covered by Linux C mocks'
        after = focused_profile.profile_state(profile, document['profile'].encode())
        if before != after:
            raise ValueError('scope control production profile changed')
        report.update(ok=True, productionProfile=before, noNewGrants=True, rendererUnderOuterProfile=True)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        report['error'] = str(error)
        raise
    finally:
        report['quiescenceObservations'] = list(focused_seal.QUIESCENCE_OBSERVATIONS)
        api.write_json(root / 'scope-control-self-tests.json', report, root)
    return report

