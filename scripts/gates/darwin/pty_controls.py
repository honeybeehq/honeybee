import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time

import focused_seal
import scope_controls


REPORTS = {}
ENUMS = {'NONE', 'EPERM', 'EACCES', 'EAGAIN', 'ENOENT', 'ENOTTY', 'EINVAL', 'EBADF', 'EIO', 'ENOMEM', 'OTHER', 'NOT_RUN'}
FIELDS = {'foreignBefore', 'foreignAfter', 'nonTty', 'posixOpenpt', 'grantpt', 'unlockpt', 'slaveOpen', 'ttyIoctl', 'forkExec', 'trueExit'}
CHAIN = ('posixOpenpt', 'grantpt', 'unlockpt', 'slaveOpen', 'ttyIoctl')

PINNED_BUILD = '25G83'
PTY_RULES = '(allow pseudo-tty)(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))(allow file-read* file-write* (require-all (regex #"^/dev/ttys[0-9]+$") (extension "com.apple.sandbox.pty")))'
DISCLOSURE = "Darwin outer profile admits PTY allocation (pseudo-tty, /dev/ptmx read/write/ioctl) and slave ttys only under the kernel-issued com.apple.sandbox.pty extension; foreign same-uid terminals are denied by OS policy (self-test proves before and after own allocation); a same-uid process holding a pty extension could pass a token over IPC, which is not excluded; PTY allocation adds host PTY-exhaustion capacity."


def os_build(env):
    result = {}
    for name, flag in (('ProductVersion', '-productVersion'), ('BuildVersion', '-buildVersion')):
        observed = subprocess.run(['/usr/bin/sw_vers', flag], env=env, capture_output=True, text=True, timeout=2)
        value = observed.stdout.strip()
        if observed.returncode or not re.fullmatch(r'[0-9A-Za-z.]{1,32}', value):
            raise ValueError('os_build_unobserved')
        result[name] = value
    return result


def require_precondition(root, build):
    row = REPORTS.get(str(root.resolve()))
    if build.get('BuildVersion') != PINNED_BUILD:
        raise ValueError('os_build_changed: fresh self-test required')
    if not isinstance(row, dict) or row.get('ok') is not True or row.get('runRoot') != str(root.resolve()) or row.get('osBuild') != build or row.get('productionProfileUnchanged') is not True:
        raise ValueError('pty_precondition_missing_or_failed')
    rows = row.get('rows', [])
    if len(rows) != 2 or [item.get('candidate') for item in rows] != [False, True] or any(not adjudicate(item.get('observations'), item['candidate'])['ok'] for item in rows):
        raise ValueError('pty_precondition_controls_failed')
    if rows[0]['observations']['posixOpenpt'] != 'EPERM' or row.get('tmux', {}).get('ok') is not True:
        raise ValueError('pty_precondition_differential_failed')
    return row


def production_profile(base):
    if base.count('(deny file-write*)') != 1 or PTY_RULES in base:
        raise ValueError('PTY base profile shape')
    return base.replace('(deny file-write*)', '(deny file-write*)' + PTY_RULES, 1)


def candidate_profile(base, *, self_test=False):
    if self_test is not True:
        raise ValueError('PTY candidate is self-test only')
    return production_profile(base)


def adjudicate(value, candidate):
    if not isinstance(value, dict) or set(value) != FIELDS or type(value['trueExit']) is not int or any(not isinstance(value[key], str) or value[key] not in ENUMS for key in FIELDS - {'trueExit', 'foreignBefore', 'foreignAfter'}):
        raise ValueError('PTY control schema')
    for key in ('foreignBefore', 'foreignAfter'):
        row = value[key]
        if not isinstance(row, dict) or set(row) != {'open', 'write'} or not isinstance(row['open'], str) or not isinstance(row['write'], str) or row['open'] not in {'OPENED'} | {'DENIED_' + name for name in ENUMS - {'NONE', 'NOT_RUN'}} or row['write'] not in (ENUMS - {'NONE'}) | {'WROTE'} or (row['open'] != 'OPENED' and row['write'] != 'NOT_RUN'):
            raise ValueError('PTY foreign outcome schema')
    denied = {'EPERM', 'EACCES'}
    foreign_denied = all(value[key]['open'] in {'DENIED_EPERM', 'DENIED_EACCES'} for key in ('foreignBefore', 'foreignAfter'))
    foreign_opened = any(value[key]['open'] == 'OPENED' for key in ('foreignBefore', 'foreignAfter'))
    negatives = foreign_denied and value['nonTty'] in denied
    fork = value['forkExec'] == 'NONE' and value['trueExit'] == 0
    own = all(value[key] == 'NONE' for key in CHAIN) if candidate else any(value[key] in denied for key in CHAIN)
    return {'ok': negatives and fork and own, 'observations': value, 'foreignBothDenied': foreign_denied, 'foreignOpenedForbidden': foreign_opened, 'nonTtyDenied': value['nonTty'] in denied, 'ownChainPassed': all(value[key] == 'NONE' for key in CHAIN)}


def fenced_cleanup(api, helper, process, birth):
    result = {'gone': False, 'signals': []}
    if process.poll() is None:
        for sig in (signal.SIGTERM, signal.SIGKILL):
            observed = subprocess.run([str(helper), 'signal', *birth, str(int(sig))], capture_output=True, timeout=2)
            result['signals'].append({'signal': int(sig), 'exit': observed.returncode})
            if observed.returncode not in (0, 3):
                break
            try:
                process.wait(timeout=1)
                break
            except subprocess.TimeoutExpired:
                pass
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        pass
    status = subprocess.run([str(helper), 'status', *birth], capture_output=True, timeout=2)
    result['gone'] = status.returncode == 3
    if not result['gone']:
        focused_seal.record_leftover(api.LEFTOVER_CHILDREN, {'pid': birth[0], 'birth': birth, 'reason': 'PTY control fenced cleanup unresolved'})
    return result


def start(api, root, workspace, helper, env, argv):
    read_fd, release_fd = os.pipe()
    process = None
    birth = None
    try:
        process = subprocess.Popen([sys.executable, '-B', str(workspace / 'scripts/gates/darwin/start_wait.py'), str(read_fd), *argv], cwd=root / 't', env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, pass_fds=(read_fd,), start_new_session=True)
        focused_seal.remember_launch(process.pid)
        birth = scope_controls.identity(helper, process.pid)
        os.write(release_fd, b'1')
        return process, birth
    except BaseException:
        if process is not None:
            os.close(release_fd)
            release_fd = None
            if birth is not None:
                fenced_cleanup(api, helper, process, birth)
            else:
                try:
                    birth = scope_controls.identity(helper, process.pid)
                    fenced_cleanup(api, helper, process, birth)
                except (ValueError, OSError, subprocess.SubprocessError):
                    focused_seal.record_leftover(api.LEFTOVER_CHILDREN, {'birth': None}, unverified_label='scope-control')
                    try:
                        process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        pass
        raise
    finally:
        os.close(read_fd)
        if release_fd is not None:
            os.close(release_fd)


def execute(api, root, workspace, helper, env, argv, data=None):
    process, birth = start(api, root, workspace, helper, env, argv)
    result = {'exit': None, 'cleanup': None}
    try:
        stdout, stderr = process.communicate(input=data, timeout=10)
        if len(stdout) > 65536 or len(stderr) > 65536:
            raise ValueError('PTY control output bound')
        result.update(exit=process.returncode, stdoutBytes=len(stdout), stderrBytes=len(stderr), stderrSha256=hashlib.sha256(stderr).hexdigest())
        return result, stdout
    finally:
        result['cleanup'] = fenced_cleanup(api, helper, process, birth)
        if not result['cleanup']['gone']:
            raise ValueError('PTY control remains after fenced cleanup')
        for stream in (process.stdin, process.stdout, process.stderr):
            stream.close()


def select_tmux():
    for candidate in ('/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'):
        path = Path(candidate)
        if path.is_file() and os.access(path, os.X_OK):
            path = path.resolve(strict=True)
            info = path.stat()
            return {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'dev': info.st_dev, 'ino': info.st_ino}
    raise ValueError('pinned tmux control binary unavailable')


def check_tmux(pin):
    path = Path(pin['path'])
    info = path.stat()
    if path.resolve(strict=True) != path or (info.st_dev, info.st_ino) != (pin['dev'], pin['ino']) or hashlib.sha256(path.read_bytes()).hexdigest() != pin['sha256']:
        raise ValueError('tmux control pin changed')


def capture_verdict(captured, pane_alive):
    return {'ok': pane_alive is True and b'SCG_PTY_TMUX_READY' in captured, 'paneAlive': pane_alive is True, 'fixtureMarkerPresent': b'SCG_PTY_TMUX_READY' in captured, 'captureBytes': len(captured), 'captureSha256': hashlib.sha256(captured).hexdigest()}


def marker_gone(helper, birth):
    deadline = time.monotonic() + 2
    while True:
        result = subprocess.run([str(helper), 'status', *birth], capture_output=True, timeout=2)
        if result.returncode == 3: return True
        if result.returncode != 0 or time.monotonic() >= deadline: return False
        time.sleep(0.02)


def tmux_control(api, root, workspace, helper, env, profile, fixture):
    env = dict(env, LC_CTYPE='en_US.UTF-8')
    pin = select_tmux()
    socket = fixture / 'tmux.sock'
    marker_binary = root / 'pty-control'
    marker_pin = hashlib.sha256(marker_binary.read_bytes()).hexdigest()
    marker_birth = None
    config = fixture / 'empty.conf'
    config.touch(mode=0o600, exist_ok=False)
    prefix = ['/usr/bin/sandbox-exec', '-f', str(profile), pin['path']]
    common = ['-f', str(config), '-S', str(socket)]
    server, birth = start(api, root, workspace, helper, env, prefix + ['-D', *common])
    report = {'ok': False, 'testOnly': True, 'foregroundD': True, 'privateSocket': True, 'emptyConfigControlOnly': True, 'pin': pin, 'commands': [], 'cleanup': None}
    try:
        deadline = time.monotonic() + 5
        while not socket.exists():
            if server.poll() is not None or time.monotonic() >= deadline:
                raise ValueError('PTY tmux foreground server readiness')
            time.sleep(0.02)
        if not stat.S_ISSOCK(socket.lstat().st_mode) or socket.resolve(strict=True) != socket:
            raise ValueError('PTY control socket redirected')
        operations = [
            ['set-option', '-g', 'remain-on-exit', 'on'],
            ['new-session', '-d', '-s', 'scg-pty-control', str(marker_binary), '--tmux-marker'],
        ]
        captured = b''
        for args in operations:
            check_tmux(pin)
            result, output = execute(api, root, workspace, helper, env, prefix + ['-N', *common, *args])
            report['commands'].append(dict(result, operation=args[0]))
            if result['exit'] != 0:
                raise ValueError('PTY tmux control command failed')
        def observe_pane():
            result, data = execute(api, root, workspace, helper, env, prefix + ['-N', *common, 'display-message', '-p', '-t', 'scg-pty-control:0.0', '#{pane_dead} #{pane_pid}'])
            report['commands'].append(dict(result, operation='display-message'))
            parts = data.split()
            if result['exit'] != 0 or len(parts) != 2 or parts[0] not in (b'0', b'1') or not parts[1].isdigit():
                raise ValueError('PTY pane observation unresolved')
            report['paneAlive'] = parts[0] == b'0'
            if not report['paneAlive']:
                raise ValueError('PTY marker pane is dead')
            return parts[1].decode('ascii')
        marker_pid = observe_pane()
        rows = api.scope_call(helper, 'scan', *birth)
        matches = [row for row in rows if row[0] == marker_pid and row[1] == birth[0]]
        if len(matches) != 1:
            raise ValueError('PTY marker birth not verified as server child')
        marker_birth = matches[0]
        focused_seal.remember_birth(marker_birth)
        image = scope_controls.call(helper, 'executable', marker_birth).strip()
        if image != str(marker_binary) or hashlib.sha256(marker_binary.read_bytes()).hexdigest() != marker_pin:
            raise ValueError('PTY marker executable pin mismatch')
        deadline = time.monotonic() + 3
        while b'SCG_PTY_TMUX_READY' not in captured and time.monotonic() < deadline:
            check_tmux(pin)
            result, captured = execute(api, root, workspace, helper, env, prefix + ['-N', *common, 'capture-pane', '-p', '-t', 'scg-pty-control:0.0'])
            report['commands'].append(dict(result, operation='capture-pane'))
            if result['exit'] != 0:
                raise ValueError('PTY tmux control capture failed')
            if b'SCG_PTY_TMUX_READY' not in captured:
                time.sleep(0.03)
        alive = observe_pane() == marker_pid and subprocess.run([str(helper), 'status', *marker_birth], capture_output=True, timeout=2).returncode == 0
        report.update(capture_verdict(captured, alive))
        if not report['ok']:
            raise ValueError('PTY tmux capture marker absent')
    finally:
        report['cleanup'] = fenced_cleanup(api, helper, server, birth)
        for stream in (server.stdin, server.stdout, server.stderr):
            stream.close()
        report['markerGone'] = marker_birth is not None and marker_gone(helper, marker_birth)
        if marker_birth is not None and not report['markerGone']:
            focused_seal.record_leftover(api.LEFTOVER_CHILDREN, {'pid': marker_birth[0], 'birth': marker_birth, 'reason': 'PTY marker remained after fenced server teardown'})
        report['ok'] = report['ok'] and report['cleanup']['gone'] and report['markerGone']
        api.write_json(root / 'pty-tmux-control.json', report, root)
        check_tmux(pin)
    return report


def run(api, root, workspace, helper, env, compile_command, *, self_test=False, focused_precondition=False, baseline_policy=None):
    if (self_test is not True and focused_precondition is not True) or sys.platform != 'darwin' or (env.get('SCG_SELF_TEST') != '1' and focused_precondition is not True):
        raise ValueError('PTY controls require approved Darwin control entry')
    report = {'ok': False, 'selfTestOnly': True, 'productionProfileUnchanged': False, 'rows': [], 'extensionTokenLimit': DISCLOSURE}
    REPORTS[str(root.resolve())] = report
    original = (root / 'workload.sb').read_bytes()
    build = os_build(env)
    report.update(osBuild=build, runRoot=str(root.resolve()), disclosure=DISCLOSURE, selfTestOnly=False, sameInvocation=True)
    if build['BuildVersion'] != PINNED_BUILD:
        raise ValueError('os_build_changed: fresh self-test required')
    if not isinstance(baseline_policy, str) or original.decode() != candidate_profile(baseline_policy, self_test=True):
        raise ValueError('PTY production profile differs from approved delta')
    fixture = root / 't/pty-controls'
    fixture.mkdir(mode=0o700)
    source = workspace / 'scripts/gates/darwin/pty_control.c'
    pin = hashlib.sha256(source.read_bytes()).hexdigest()
    manifest = json.loads((root / 'source-manifest.json').read_text())
    if manifest['scripts/gates/darwin/pty_control.c']['sha256'] != pin:
        raise ValueError('PTY control source pin mismatch')
    binary = root / 'pty-control'
    command = [str(source) if arg == str(workspace / 'scripts/gates/darwin/scope.c') else str(binary) if arg == str(helper) else arg for arg in compile_command]
    master = slave = None
    try:
        compiled = subprocess.run(command, cwd=workspace, env=env, capture_output=True, timeout=30)
        report['compiler'] = {'exit': compiled.returncode, 'stderrBytes': len(compiled.stderr), 'stderrSha256': hashlib.sha256(compiled.stderr).hexdigest(), 'unchangedCompilerProfile': True}
        (root / 'logs/pty-control-build.log').write_bytes(compiled.stdout + compiled.stderr)
        if compiled.returncode or hashlib.sha256(source.read_bytes()).hexdigest() != pin:
            raise ValueError('PTY control compile failed')
        binary_pin = hashlib.sha256(binary.read_bytes()).hexdigest()
        report['sourceSha256'], report['binarySha256'] = pin, binary_pin
        master, slave = os.openpty()
        if os.get_inheritable(master) or os.get_inheritable(slave):
            raise ValueError('controller dummy PTY descriptors inheritable')
        report['dummyPtyNotInherited'] = True
        foreign = Path(os.ttyname(slave))
        if not re.fullmatch(r'/dev/ttys[0-9]+', str(foreign)) or foreign.resolve(strict=True) != foreign or not stat.S_ISCHR(os.fstat(slave).st_mode) or (foreign.stat().st_dev, foreign.stat().st_ino) != (os.fstat(slave).st_dev, os.fstat(slave).st_ino):
            raise ValueError('controller dummy PTY identity unresolved')
        zero = os.open('/dev/zero', os.O_WRONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        os.close(zero)
        report['controllerNonTtyOpenAllowed'] = True
        for candidate in (False, True):
            profile = fixture / ('candidate.sb' if candidate else 'current.sb')
            profile.write_text(original.decode() if candidate else baseline_policy)
            profile.chmod(0o600)
            if hashlib.sha256(binary.read_bytes()).hexdigest() != binary_pin:
                raise ValueError('PTY control binary changed')
            result, output = execute(api, root, workspace, helper, env, ['/usr/bin/sandbox-exec', '-f', str(profile), str(binary), str(foreign)], b'1')
            row = {'candidate': candidate, 'process': result}
            report['rows'].append(row)
            if result['exit'] != 0:
                raise ValueError('PTY control process failed')
            row.update(adjudicate(json.loads(output), candidate))
            if not row['foreignBothDenied']:
                report['candidateDeadForeignSlaveAllowed'] = True
                raise ValueError('PTY foreign-slave negative failed; candidate dead')
            if not row['ok']:
                raise ValueError('PTY control expectations failed')
            if candidate:
                report['tmux'] = tmux_control(api, root, workspace, helper, env, profile, fixture)
                if not report['tmux']['ok']:
                    raise ValueError('PTY tmux candidate control failed')
            focused_seal.require_quiescent(root, helper)
        if hashlib.sha256(binary.read_bytes()).hexdigest() != binary_pin:
            raise ValueError('PTY control binary changed after controls')
        report['ok'] = True
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        report['failure'] = type(error).__name__
        raise
    finally:
        for fd in (slave, master):
            if fd is not None:
                os.close(fd)
        report['dummyPtyClosed'] = slave is not None and master is not None
        report['productionProfileUnchanged'] = (root / 'workload.sb').read_bytes() == original
        api.write_json(root / 'pty-control-self-tests.json', report, root)
        if not report['productionProfileUnchanged']:
            raise ValueError('production profile changed during PTY self-test')
    return report
