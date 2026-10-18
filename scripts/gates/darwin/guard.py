import argparse
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import pwd
import re
import shlex
import signal
import socket
import stat
import subprocess
import sys
import tarfile
import time
import node_bootstrap
import listener_static
import git_boundary
import focused_flow
import node_argv
import pty_controls
import focused_seal
import scope_controls

LISTENER_LIMIT = 'Seatbelt does not mediate IP bind/inbound on macOS 26 (probe 52e76fd3: remote tailnet connect accepted); mitigated by own-pid listener sampling (FAIL + fenced kill); exposure window up to one sample interval.'
STATIC_BIND_LIMIT = 'static bind scan covers modules importing dgram/socket; a socket passed across modules is covered only by the runtime own-pid sampler'

PROVIDERS = ('.claude', '.codex', '.grok', '.kimi', '.gemini', '.cursor', '.muse', '.config/opencode', '.config/muse', '.local/share/opencode')
PROTECTED = ('.hive', '.config', '.ssh', '.gnupg', 'Library', '.apiary', '.local/share/apiary', '.local/share/apiary-satellite', '.local/share/apiary/satellite-updater', *PROVIDERS)
SCOPE_OBSERVATIONS = []
CREATED_ROOTS = set()
CONTROL_SOCKETS = []
LOCK_METADATA = {}
DIRS = {'HOME': 'h', 'TMPDIR': 't', 'TMP': 't', 'TEMP': 't', 'HIVE_REAL_HOME': 'h', 'XDG_CONFIG_HOME': 'config', 'XDG_DATA_HOME': 'data', 'XDG_CACHE_HOME': 'cache', 'XDG_STATE_HOME': 'state', 'XDG_RUNTIME_DIR': 'runtime', 'CLAUDE_CONFIG_DIR': 'claude', 'CODEX_HOME': 'codex', 'GROK_HOME': 'grok', 'GEMINI_CLI_HOME': 'gemini', 'OPENCODE_CONFIG_DIR': 'opencode', 'KIMI_CODE_HOME': 'kimi', 'CURSOR_CONFIG_DIR': 'cursor', 'MUSE_HOME': 'muse', 'npm_config_cache': 'cache/npm', 'npm_config_store_dir': 'cache/pnpm', 'npm_config_logs_dir': 'logs/npm', 'PNPM_HOME': 'pnpm', 'PNPM_STORE_DIR': 'cache/pnpm', 'NODE_COMPILE_CACHE': 'cache/node', 'CLANG_MODULE_CACHE_PATH': 'cache/clang'}


class Refusal(Exception):
    pass


def inside(path, root):
    return path == root or root in path.parents


def environment(root, node):
    result = {'PATH': str(Path(node).parent) + ':/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', 'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1', 'GIT_ALLOW_PROTOCOL': 'file', 'npm_config_offline': 'true', 'npm_config_update_notifier': 'false', 'npm_config_audit': 'false', 'npm_config_fund': 'false'}
    result.update({key: str(root / value) for key, value in DIRS.items()})
    return result


def validate(root, env, real_home, parent=Path('/private/var/tmp')):
    root, real_home, parent = Path(root).resolve(), Path(real_home), Path(parent).resolve()
    if not real_home.is_absolute():
        raise Refusal('passwd HOME must already be canonical and absolute')
    if root.parent != parent or not root.name.startswith('g.') or root == real_home or inside(root, real_home):
        raise Refusal('unsafe run root')
    protected = [real_home / p for p in PROTECTED]
    for key in sorted(set(DIRS) | {k for k in env if k.startswith('XDG_')}):
        value = env.get(key)
        if not value or not Path(value).is_absolute():
            raise Refusal('unsafe ' + key)
        path = Path(value).resolve()
        if not inside(path, root) or path == real_home or any(inside(path, p) for p in protected):
            raise Refusal('unsafe ' + key)
    if any(k.startswith(('HIVE_', 'APIARY_')) and k != 'HIVE_REAL_HOME' for k in env):
        raise Refusal('stamped environment')
    return {'allowed': True, 'beforeFirstWrite': True, 'checkedVariables': sorted(DIRS), 'root': str(root), 'protectedRoots': [str(p) for p in protected]}


ENTRY_NOTES = []
LEFTOVER_CHILDREN = []
GIT_CONTROLS = {}
GIT_AUDITS = {}


def write_json(path, value, root):
    path = Path(path)
    if not inside(path.resolve(), root.resolve()):
        raise Refusal('write outside run root')
    if path == Path(root) / 'receipt.json' and isinstance(value, dict):
        value = dict(value, ptyDisclosure=pty_controls.DISCLOSURE, ptyControls=pty_controls.REPORTS.get(str(root.resolve())), nodeDefaultArgv=node_argv.receipt_report(root) if value.get('selfTest') else None, controllerBootstrap=focused_flow.CONTROLLER_BOOTSTRAPS.get(str(root.resolve())), rootCreation=focused_seal.ROOT_CREATION.get(str(root.resolve())), exeUnlinkedLimit=focused_seal.UNLINKED_LIMIT, fdUnobservableLimit=focused_seal.FD_UNOBSERVABLE_LIMIT, fdUnobservableDisclosure=focused_seal.fd_disclosure((focused_seal.QUIESCENCE_OBSERVATIONS[-1].get('reason') or {}).get('counts', {}).get('fdUnobservableSandboxDenied', 0) if focused_seal.QUIESCENCE_OBSERVATIONS else 0), fdUnobservableWriteDeniedDisclosure=focused_seal.fd_write_disclosure((focused_seal.QUIESCENCE_OBSERVATIONS[-1].get('reason') or {}).get('counts', {}).get('fdUnobservableWriteDenied', 0) if focused_seal.QUIESCENCE_OBSERVATIONS else 0), fdUnobservablePlatformBinaryDisclosure=focused_seal.fd_platform_disclosure((focused_seal.QUIESCENCE_OBSERVATIONS[-1].get('reason') or {}).get('counts', {}).get('fdUnobservablePlatformBinary', 0) if focused_seal.QUIESCENCE_OBSERVATIONS else 0), fdDisclosureCountScope='most recent quiescence scan; each retained observation also carries its own disclosure', foreignRootUseCounts=dict(focused_seal.FOREIGN_ROOT_USE_COUNTS), unobservedOwnChildren=list(focused_seal.UNOBSERVED_OWN_CHILDREN), gateLaunchBirths=sorted(focused_seal.GATE_LAUNCH_BIRTHS), gateLaunchPids=sorted(focused_seal.GATE_LAUNCH_PIDS), quiescenceObservations=list(focused_seal.QUIESCENCE_OBSERVATIONS), gitBoundary=GIT_AUDITS.get(str(root.resolve())), entryNotes=list(ENTRY_NOTES), leftoverChild=value.get('leftoverChild') or list(LEFTOVER_CHILDREN) or None, listenerLimit=LISTENER_LIMIT, staticBindLimit=STATIC_BIND_LIMIT, hostLock=LOCK_METADATA.get(str(Path(root).resolve())))
    path.write_text(json.dumps(value, indent=2) + '\n')


def launchagents(home):
    opened = []
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    try:
        try:
            current = os.open(home, flags)
            opened.append(current)
            for component in ('Library', 'LaunchAgents'):
                current = os.open(component, flags, dir_fd=current)
                opened.append(current)
        except FileNotFoundError:
            return {'exists': False, 'entries': {}}
        entries = {}
        for name in sorted(os.listdir(current)):
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=current)
            with os.fdopen(fd, 'rb') as stream:
                before = os.fstat(stream.fileno())
                if not stat.S_ISREG(before.st_mode):
                    raise Refusal('LaunchAgents contains a non-regular entry')
                digest = hashlib.sha256()
                for block in iter(lambda: stream.read(65536), b''):
                    digest.update(block)
                after = os.fstat(stream.fileno())
                if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                    raise Refusal('LaunchAgents changed during snapshot')
                entries[name] = digest.hexdigest()
        return {'exists': True, 'entries': entries}
    except OSError as error:
        raise Refusal('LaunchAgents snapshot refused: ' + str(error.errno)) from error
    finally:
        for fd in reversed(opened):
            os.close(fd)


def validate_seed_headers(source):
    pending = None
    expected = []
    with source.open('rb') as stream:
        while True:
            offset = stream.tell()
            block = stream.read(512)
            if not block or block == bytes(512):
                if pending:
                    raise Refusal('unfinished seed PAX header')
                return expected
            try:
                member = tarfile.TarInfo.frombuf(block, 'utf-8', 'strict')
            except (tarfile.HeaderError, UnicodeError) as error:
                raise Refusal('invalid seed tar header') from error
            if member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE, tarfile.XHDTYPE):
                raise Refusal('unsupported seed tar extension or member')
            if member.size < 0:
                raise Refusal('negative seed tar member size')
            if member.type == tarfile.DIRTYPE and member.size != 0:
                raise Refusal('seed directory payload refused')
            if member.type == tarfile.XHDTYPE:
                if pending or not 0 < member.size <= 16384:
                    raise Refusal('invalid seed PAX path header')
                payload = stream.read(member.size)
                if len(payload) != member.size:
                    raise Refusal('truncated seed PAX header')
                position = 0
                fields = set()
                while position < len(payload):
                    space = payload.find(b' ', position)
                    if space < 0 or not payload[position:space].isdigit():
                        raise Refusal('invalid seed PAX record')
                    length = int(payload[position:space])
                    end = position + length
                    record = payload[space + 1:end]
                    if end > len(payload) or length <= space - position + 1 or not record.endswith(b'\n'):
                        raise Refusal('invalid seed PAX record length')
                    key, separator, value = record[:-1].partition(b'=')
                    if key != b'path' or not separator or key in fields:
                        raise Refusal('seed PAX supports path only')
                    try:
                        effective_name = value.decode('utf-8').rstrip('/')
                        path = Path(effective_name)
                    except UnicodeError as error:
                        raise Refusal('invalid seed PAX path encoding') from error
                    if b'\0' in value or path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] not in ('npm', 'pnpm', 'node'):
                        raise Refusal('unsafe seed PAX path')
                    fields.add(key)
                    position = end
                if fields != {b'path'}:
                    raise Refusal('seed PAX path required')
                stream.seek((-member.size) % 512, 1)
                pending = (offset, effective_name)
            else:
                expected.append((pending[0] if pending else offset, member.type, pending[1] if pending else member.name, member.size))
                stream.seek(((member.size + 511) // 512) * 512, 1)
                pending = None


def seed_cache(source, expected, root, lane):
    source = Path(source).resolve()
    if not inside(source, root) and not inside(source, lane):
        raise Refusal('cache seed outside run root or pinned lane')
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    if digest != expected:
        raise Refusal('cache seed hash mismatch')
    expected = validate_seed_headers(source)
    with tarfile.open(source, 'r:') as archive:
        members = archive.getmembers()
        if expected != [(member.offset, member.type, member.name, member.size) for member in members]:
            raise Refusal('seed raw headers and tar parser disagree')
        names = set()
        for member in members:
            path = Path(member.name)
            if set(member.pax_headers) - {'path'} or path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] not in ('npm', 'pnpm', 'node') or path.as_posix() in names or not (member.isfile() or member.isdir()):
                raise Refusal('unsafe cache seed member')
            names.add(path.as_posix())
        for member in members:
            path = root / 'cache' / member.name
            if member.isdir():
                path.mkdir(parents=True, exist_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as src, path.open('xb') as dst:
                    dst.write(src.read())
    return {'sha256': digest, 'members': len(members)}


def profile(root, home, lane, *, pty=True):
    quote = lambda p: json.dumps(str(p))
    base = ''.join((
        '(version 1)(allow default)',
        '(deny file-write*)(allow file-write* (subpath ' + quote(root) + '))',
        '(deny file-write* (subpath ' + quote(root / 'sealed-target') + '))',
        '(allow file-write-data (literal "/dev/null"))',
        '(deny file-read* (subpath ' + quote(home) + '))',
        '(deny file-read* (subpath "/Library/Keychains") (subpath "/private/var/db/Keychains"))',
        '(deny process-exec (literal "/usr/bin/security"))(deny mach-lookup)',
        '(deny signal)(allow signal (target same-sandbox))',
        '(deny process-info*)(allow process-info* (target same-sandbox))',
        '(deny network*)',
        '(allow network-bind (local ip "localhost:*"))',
        '(allow network-inbound (local ip "localhost:*"))',
        '(allow network-outbound (remote ip "localhost:*"))',
        '(allow network-bind (local unix-socket (subpath ' + quote(root / 't') + ')))',
        '(allow network-inbound (local unix-socket (subpath ' + quote(root / 't') + ')))',
        '(allow network-outbound (remote unix-socket (subpath ' + quote(root / 't') + ')))',
    ))

    return pty_controls.production_profile(base) if pty else base


def socket_identity(path):
    value = path.lstat()
    if not stat.S_ISSOCK(value.st_mode):
        raise Refusal('control socket type changed')
    return (value.st_dev, value.st_ino, value.st_mode, value.st_uid)


def make_socket_controls(root):
    paths = {'SCG_ALLOWED_SOCKET': root / 't/controller-in.sock', 'SCG_DENIED_SOCKET': root / 'controller-out.sock'}
    rows = []
    for key, path in paths.items():
        handle = socket.socket(socket.AF_UNIX)
        try:
            handle.bind(str(path))
            handle.listen(4)
            identity = socket_identity(path)
        except Exception:
            handle.close()
            raise
        CONTROL_SOCKETS.append((root, path, handle, identity))
        rows.append({'key': key, 'path': str(path), 'identity': identity, 'boundBeforeWorkload': True})
    write_json(root / 'controller-sockets.json', rows, root)
    return {key: str(path) for key, path in paths.items()}


def close_socket_controls(root):
    rows = []
    failure = None
    for item in list(CONTROL_SOCKETS):
        owner, path, handle, expected = item
        if owner != root:
            continue
        handle.close()
        CONTROL_SOCKETS.remove(item)
        try:
            actual = socket_identity(path)
            if actual != expected:
                raise Refusal('control socket inode changed; not removed')
            path.unlink()
            rows.append({'path': str(path), 'identity': actual, 'removed': True})
        except (OSError, Refusal) as error:
            rows.append({'path': str(path), 'removed': False, 'error': str(error)})
            failure = str(error)
    if rows:
        write_json(root / 'controller-sockets-cleanup.json', rows, root)
    if failure:
        raise Refusal(failure)


def source_copy(lane, source, root, env):
    archive_path = root / 'source.tar'
    with archive_path.open('xb') as stream:
        subprocess.run(['git', 'archive', source], cwd=lane, env=env, stdout=stream, check=True)
    workspace = root / 'src'
    workspace.mkdir()
    manifest = {}
    with tarfile.open(archive_path) as archive:
        members = archive.getmembers()
        for member in members:
            path = Path(member.name)
            if path.is_absolute() or '..' in path.parts or not path.parts or not (member.isdir() or member.isfile() or member.issym()):
                raise Refusal('unsafe source archive member')
            destination = workspace / path
            if any(parent.is_symlink() for parent in destination.parents if parent != workspace and inside(parent, workspace)):
                raise Refusal('redirected source archive parent')
            if member.isdir():
                destination.mkdir(parents=True, exist_ok=True)
            elif member.issym():
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.symlink_to(member.linkname)
                manifest[member.name] = {'symlink': member.linkname}
            else:
                destination.parent.mkdir(parents=True, exist_ok=True)
                data = archive.extractfile(member).read()
                with destination.open('xb') as target:
                    target.write(data)
                destination.chmod(member.mode & 0o777)
                manifest[member.name] = {'sha256': hashlib.sha256(data).hexdigest()}
    write_json(root / 'source-manifest.json', manifest, root)
    return workspace


def select_node(configured, real_home):
    candidates = [configured] if configured else ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/opt/homebrew/opt/node@24/bin/node']
    for candidate in candidates:
        p = Path(candidate)
        if not p.is_absolute() or inside(p.resolve(), real_home):
            raise Refusal('Node path must be explicit and outside real HOME')
        if p.is_file() and os.access(p, os.X_OK):
            return str(p.resolve())
    rows = []
    for candidate in candidates + ['/usr/bin/python3', '/opt/homebrew/bin/python3']:
        result = subprocess.run(['/bin/ls', '-ld', candidate], capture_output=True, text=True)
        rows.append({'path': candidate, 'exit': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr})
    receipt = json.dumps({'state': 'refused', 'reason': 'no configured Node executable', 'candidateMetadata': rows}, sort_keys=True)
    print(receipt, file=sys.stderr)
    print('REFUSAL_SHA256=' + hashlib.sha256(receipt.encode()).hexdigest(), file=sys.stderr)
    raise Refusal('no configured Node executable')


def receipt_hashes(root):
    rows = {}
    if (root / 'logs').is_symlink():
        raise Refusal('redirected receipt logs')
    paths = [p for p in root.iterdir() if p.is_file() and p.name != 'SHA256SUMS.json']
    for base, dirs, files in os.walk(root / 'logs', followlinks=False):
        for name in dirs:
            if (Path(base) / name).is_symlink():
                raise Refusal('symlink in receipt tree')
        for name in files:
            path = Path(base) / name
            if path.is_symlink():
                raise Refusal('symlink in receipt tree')
            paths.append(path)
    for path in paths:
        if path.is_symlink():
            raise Refusal('symlink in receipt tree')
        rows[str(path.relative_to(root))] = hashlib.sha256(path.read_bytes()).hexdigest()
    write_json(root / 'SHA256SUMS.json', rows, root)
    return hashlib.sha256((root / 'SHA256SUMS.json').read_bytes()).hexdigest()


def compiler_tools(root, env):
    candidates = (
        ('/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang', '/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk'),
        ('/Library/Developer/CommandLineTools/usr/bin/clang', '/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk'),
    )
    rows = []
    selected = None
    for clang, sdk in candidates:
        ld = str(Path(clang).with_name('ld'))
        for path in (clang, ld, sdk):
            result = subprocess.run(['/bin/ls', '-ld', path], env=env, capture_output=True, text=True)
            rows.append({'path': path, 'exit': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr})
        if selected is None and all(Path(p).is_file() and os.access(p, os.X_OK) for p in (clang, ld)) and Path(sdk).is_dir():
            selected = {'clang': str(Path(clang).resolve()), 'ld': str(Path(ld).resolve()), 'sdk': str(Path(sdk).resolve()), 'toolchain': str(Path(clang).parent.parent.parent.resolve())}
    write_json(root / 'compiler-tools.json', {'candidates': rows, 'selected': selected}, root)
    if selected is None:
        raise Refusal('no configured clang/linker/SDK; metadata retained at ' + str(root))
    return selected


def compiler_profile(base, tools):
    q = json.dumps
    metadata = '(allow file-read-metadata ' + ' '.join('(literal ' + q(path) + ')' for path in compiler_metadata_literals(tools['clang'])) + ')'
    return base + '(deny process-exec)(allow process-exec (literal ' + q(tools['clang']) + ') (literal ' + q(tools['ld']) + '))(deny file-read* (subpath "/Applications") (subpath "/Library/Developer"))(allow file-read* (subpath ' + q(tools['toolchain']) + ') (subpath ' + q(tools['sdk']) + '))' + metadata


def compiler_metadata_literals(clang):
    path = Path(clang)
    if not path.is_absolute() or not (inside(path, Path('/Applications')) or inside(path, Path('/Library/Developer'))):
        raise Refusal('compiler metadata scope outside fixed toolchain roots')
    paths = [path, *path.parents]
    if any(inside(p, Path('/Users')) for p in paths):
        raise Refusal('compiler metadata scope includes Users')
    return [str(p) for p in paths]


def absolute_compiler_jobs(text):
    installed = [line.split(':', 1)[1].strip() for line in text.splitlines() if line.startswith('InstalledDir:')]
    jobs = []
    for line in text.splitlines():
        if '"-cc1"' in line or '"-lto_library"' in line:
            try:
                jobs.append(shlex.split(line))
            except ValueError:
                return False
    if len(installed) != 1 or not Path(installed[0]).is_absolute():
        return False
    if not any('-cc1' in job for job in jobs):
        return False
    for job in jobs:
        if not job or not Path(job[0]).is_absolute():
            return False
        for flag in ('-resource-dir', '-lto_library'):
            if flag in job:
                index = job.index(flag) + 1
                if index >= len(job) or not Path(job[index]).is_absolute():
                    return False
    return True


def scope_call(helper, command, *args, timeout=2):
    argv = [str(helper), command, *map(str, args)]
    value = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    SCOPE_OBSERVATIONS.append({'time': time.time(), 'argv': argv, 'exit': value.returncode, 'stdout': value.stdout, 'stderr': value.stderr})
    value.check_returncode()
    rows = [line.split() for line in value.stdout.splitlines()]
    if command in ('identity', 'scan'):
        for row in rows:
            focused_seal.remember_birth(row)
    return rows


def sample_listeners(helper, birth):
    timestamp = time.time()
    command = [str(helper), 'listeners', *birth]
    value = subprocess.run(command, capture_output=True, text=True, timeout=2)
    observation = {'timestamp': timestamp, 'birth': birth, 'pid': int(birth[0]), 'argv': command, 'exit': value.returncode, 'stderr': value.stderr, 'listeners': []}
    if value.returncode:
        status = subprocess.run([str(helper), 'status', *birth], capture_output=True, text=True, timeout=2)
        observation['exitEvidence'] = {'exit': status.returncode, 'result': status.stdout.strip()}
        if status.returncode != 3 or status.stdout.strip() not in ('gone', 'same-birth-zombie'):
            observation['error'] = 'listener observation unresolved'
        return observation
    if value.stderr:
        closed = re.fullmatch(r'closed socket fds skipped=([1-9][0-9]*)\n', value.stderr)
        if closed is None or int(closed.group(1)) > 1048576:
            observation['error'] = 'listener observation diagnostic unresolved'
            return observation
        observation['closedFdRaceCount'] = int(closed.group(1))
    for line in value.stdout.splitlines():
        parts = line.split()
        if len(parts) != 4 or parts[1] not in ('TCP', 'UDP'):
            raise Refusal('malformed native listener record')
        fd, proto, address, port = parts
        ip = ipaddress.ip_address(address)
        loopback = (ip.version == 4 and ip in ipaddress.ip_network('127.0.0.0/8')) or (ip.version == 6 and ip == ipaddress.ip_address('::1'))
        observation['listeners'].append({'pid': int(birth[0]), 'birth': birth, 'proto': proto, 'localAddress': address, 'port': int(port), 'fd': int(fd), 'timestamp': timestamp, 'loopback': loopback})
    return observation


def sample_retained_listeners(helper, tracked, exited):
    samples = []
    for key, birth in tracked.items():
        if key in exited:
            continue
        sample = sample_listeners(helper, birth)
        samples.append(sample)
        if sample.get('exitEvidence', {}).get('exit') == 3 and not sample.get('error'):
            exited.add(key)
    return samples


def listener_self_tests(root, workspace, prefix, helper, env):
    results = []
    for proto in ('TCP', 'UDP'):
        read_fd, release_fd = os.pipe()
        with (root / ('listener-fixture-' + proto + '.log')).open('wb') as output:
            child = subprocess.Popen([sys.executable, '-B', str(workspace / 'scripts/gates/darwin/start_wait.py'), str(read_fd), *prefix, env['SCG_PYTHON_BIN'], '-B', str(workspace / 'scripts/gates/darwin/listener_fixture.py'), proto], pass_fds=(read_fd,), cwd=workspace, env=env, stdout=output, stderr=subprocess.STDOUT)
            focused_seal.remember_launch(child.pid)
            os.close(read_fd)
            birth = None
            samples = []
            signals = []
            detected = False
            try:
                birth = scope_call(helper, 'identity', child.pid)[0]
                if int(birth[1]) != os.getpid():
                    raise Refusal('listener fixture is not the controller own child')
                os.write(release_fd, b'1')
                deadline = time.monotonic() + 3
                while child.poll() is None and time.monotonic() < deadline:
                    sample = sample_listeners(helper, birth)
                    samples.append(sample)
                    if sample.get('error'):
                        break
                    if any(not row['loopback'] and row['proto'] == proto for row in sample['listeners']):
                        detected = True
                        break
                    time.sleep(0.05)
            finally:
                os.close(release_fd)
                if birth is not None:
                    for sig in (signal.SIGTERM, signal.SIGKILL):
                        attempt = subprocess.run([str(helper), 'signal', *birth, str(int(sig))], capture_output=True, text=True)
                        signals.append({'signal': int(sig), 'exit': attempt.returncode, 'result': attempt.stdout.strip()})
                        if attempt.returncode not in (0, 3):
                            break
                        try:
                            child.wait(timeout=1)
                            break
                        except subprocess.TimeoutExpired:
                            if attempt.returncode == 3:
                                break
            row = {'proto': proto, 'expectedClassification': 'FAIL', 'detected': detected, 'birth': birth, 'samples': samples, 'signals': signals, 'childExit': child.poll(), 'noRemoteConnect': True}
            results.append(row)
            write_json(root / 'listener-self-tests.json', results, root)
            if not detected or child.poll() is None or not signals or signals[0]['exit'] != 0:
                raise Refusal('expected wildcard listener detection or fenced kill failed: ' + proto)
    results.append(reparent_listener_self_test(root, workspace, prefix, helper, env))
    write_json(root / 'listener-self-tests.json', results, root)
    return results


def tree_scan_self_test(root, workspace, prefix, helper, env):
    rows = []
    births = {}
    failure = None
    observations_start = len(SCOPE_OBSERVATIONS)
    with (root / 'tree-scan-fixture.log').open('wb') as output:
        child = subprocess.Popen([*prefix, env['SCG_PYTHON_BIN'], '-B', str(workspace / 'scripts/gates/darwin/listener_fixture.py'), 'tree-parent'], cwd=workspace, env=env, stdout=output, stderr=subprocess.STDOUT)
        focused_seal.remember_launch(child.pid)
        try:
            birth = scope_call(helper, 'identity', child.pid)[0]
            if birth[1] != str(os.getpid()):
                raise Refusal('tree fixture root not a controller child')
            births[birth[0]] = birth
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                rows = scope_call(helper, 'scan', *birth)
                for row in rows:
                    if row[0] in births and births[row[0]][2:] != row[2:]:
                        raise Refusal('tree preflight observed pid reuse')
                    births.setdefault(row[0], row)
                paths = [root / (name + '-pid') for name in ('tree-child', 'tree-grandchild')]
                if all(path.exists() for path in paths):
                    direct, grandchild = [path.read_text().strip() for path in paths]
                    if direct in births and grandchild in births and births[direct][1] == birth[0] and births[grandchild][1] == direct:
                        break
                time.sleep(0.05)
            else:
                raise Refusal('scan preflight did not enumerate known live child and grandchild')
        except BaseException as error:
            failure = str(error)
            raise
        finally:
            (root / 'tree-abort').write_text('abort\n')
            try:
                if child.wait(timeout=4) != 0:
                    failure = failure or 'scan preflight root exited nonzero'
            except subprocess.TimeoutExpired:
                pass
            for row in reversed(list(births.values())):
                status = subprocess.run([str(helper), 'status', *row], capture_output=True, text=True)
                if status.returncode == 0:
                    for sig in (signal.SIGTERM, signal.SIGKILL):
                        subprocess.run([str(helper), 'signal', *row, str(int(sig))], capture_output=True, text=True)
                        status = subprocess.run([str(helper), 'status', *row], capture_output=True, text=True)
                        if status.returncode == 3:
                            break
                if status.returncode != 3:
                    focused_seal.record_leftover(LEFTOVER_CHILDREN, {'pid': row[0], 'birth': row, 'reason': 'fenced cleanup unresolved'})
                    failure = failure or 'scan preflight retained child cleanup unresolved'
            for name in ('tree-parent', 'tree-child', 'tree-grandchild'):
                path = root / (name + '-pid')
                if path.exists() and path.read_text().strip() not in births:
                    focused_seal.record_leftover(LEFTOVER_CHILDREN, {'birth': None}, unverified_label=name)
                    failure = failure or 'scan preflight unobserved child'
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                failure = failure or 'scan preflight root cleanup unresolved'
            write_json(root / 'tree-scan-self-test.json', {'failure': failure, 'rows': rows, 'births': list(births.values()), 'scopeObservations': SCOPE_OBSERVATIONS[observations_start:], 'leftoverChild': list(LEFTOVER_CHILDREN), 'required': 'live direct child and grandchild with verified parentage and births'}, root)
    if failure:
        raise Refusal(failure)


def reparent_listener_self_test(root, workspace, prefix, helper, env):
    read_fd, release_fd = os.pipe()
    samples = []
    signals = []
    parent_birth = None
    retained = None
    detected = False
    failure = None
    check = None
    all_births = {}
    observations_start = len(SCOPE_OBSERVATIONS)
    with (root / 'listener-fixture-reparent.log').open('wb') as output:
        parent = subprocess.Popen([sys.executable, '-B', str(workspace / 'scripts/gates/darwin/start_wait.py'), str(read_fd), *prefix, env['SCG_PYTHON_BIN'], '-B', str(workspace / 'scripts/gates/darwin/listener_fixture.py'), 'reparent-parent'], pass_fds=(read_fd,), cwd=workspace, env=env, stdout=output, stderr=subprocess.STDOUT)
        focused_seal.remember_launch(parent.pid)
        os.close(read_fd)
        tree = []
        try:
            parent_birth = scope_call(helper, 'identity', parent.pid)[0]
            all_births.setdefault(tuple(parent_birth), parent_birth)
            if int(parent_birth[1]) != os.getpid():
                raise Refusal('reparent fixture parent outside controller scope')
            os.write(release_fd, b'1')
            deadline = time.monotonic() + 15
            while parent.poll() is None and time.monotonic() < deadline:
                tree = scope_call(helper, 'scan', *parent_birth)
                for row in tree:
                    all_births.setdefault(tuple(row), row)
                children = [row for row in tree if row[1] == str(parent.pid)]
                ready = root / 'reparent-child-ready'
                if ready.exists() and any(row[0] == ready.read_text().strip() for row in children):
                    retained = next(row for row in children if row[0] == ready.read_text().strip())
                    write_json(root / 'reparent-first-sight.json', {'birth': retained, 'parentBirth': parent_birth, 'tree': tree, 'beforeParentRelease': True}, root)
                    break
                time.sleep(0.05)
            if retained is None:
                raise Refusal('grandchild birth unobserved')
            (root / 'reparent-parent-release').write_text('release\n')
            parent.wait(timeout=2)
            deadline = time.monotonic() + 3
            now = retained
            while time.monotonic() < deadline:
                now = scope_call(helper, 'identity', retained[0])[0]
                if now[1] != retained[1] or now[2:] != retained[2:]:
                    break
                time.sleep(0.05)
            if now[1] == retained[1] or now[2:] != retained[2:]:
                raise Refusal('grandchild did not reparent with preserved birth')
            (root / 'reparent-listen-release').write_text('release\n')
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                sample = sample_listeners(helper, retained)
                samples.append(sample)
                if sample.get('error'):
                    break
                if any(not row['loopback'] for row in sample['listeners']):
                    detected = True
                    break
                time.sleep(0.05)
        except BaseException as error:
            failure = str(error)
            raise
        finally:
            os.close(release_fd)
            cleanup_births = dict(all_births)
            if parent_birth is not None:
                try:
                    for row in scope_call(helper, 'scan', *parent_birth):
                        cleanup_births.setdefault(tuple(row), row)
                except (Refusal, OSError, subprocess.SubprocessError) as error:
                    signals.append({'cleanupScanError': str(error)})
            candidate_path = root / 'reparent-child-pid'
            candidate_pid = candidate_path.read_text().strip() if candidate_path.exists() else None
            if candidate_pid and not any(row[0] == candidate_pid for row in cleanup_births.values()):
                focused_seal.record_leftover(LEFTOVER_CHILDREN, {'birth': None}, unverified_label='reparent-child')
            (root / 'reparent-abort').write_text('abort\n')
            for birth in sorted(cleanup_births.values(), key=lambda row: row[0] == str(parent.pid)):
                for sig in (signal.SIGTERM, signal.SIGKILL):
                    attempt = subprocess.run([str(helper), 'signal', *birth, str(int(sig))], capture_output=True, text=True)
                    signals.append({'birth': birth, 'signal': int(sig), 'exit': attempt.returncode, 'result': attempt.stdout.strip()})
                    if attempt.returncode not in (0, 3):
                        break
                    time.sleep(0.1)
                    check = subprocess.run([str(helper), 'status', *birth], capture_output=True, text=True)
                    if check.returncode == 3:
                        break
                status = subprocess.run([str(helper), 'status', *birth], capture_output=True, text=True)
                if status.returncode != 3:
                    focused_seal.record_leftover(LEFTOVER_CHILDREN, {'pid': birth[0], 'birth': birth, 'reason': 'fenced cleanup unresolved', 'statusExit': status.returncode})
            try:
                parent.wait(timeout=2)
            except subprocess.TimeoutExpired:
                if parent_birth is None:
                    focused_seal.record_leftover(LEFTOVER_CHILDREN, {'birth': None}, unverified_label='reparent-parent')
            check = subprocess.run([str(helper), 'status', *retained], capture_output=True, text=True) if retained else None
            result = {'proto': 'TCP', 'case': 'retained reparented grandchild', 'expectedClassification': 'FAIL', 'detected': detected, 'failure': failure, 'birth': retained, 'parentBirth': parent_birth, 'retainedBirths': list(cleanup_births.values()), 'firstSightTree': tree, 'samples': samples, 'signals': signals, 'leftoverChild': list(LEFTOVER_CHILDREN), 'scopeObservations': SCOPE_OBSERVATIONS[observations_start:], 'childExit': 'gone or zombie' if check and check.returncode == 3 else None, 'noRemoteConnect': True}
            write_json(root / 'listener-reparent-self-test.json', result, root)
    if not detected or not check or check.returncode != 3:
        raise Refusal('reparented wildcard listener detection or cleanup failed')
    return result


def run(args):
    present = 'HIVE_REAL_HOME' in os.environ
    os.environ.pop('HIVE_REAL_HOME', None)
    ENTRY_NOTES[:] = ['HIVE_REAL_HOME present at entry (tool-injected, ignored, unset)'] if present or getattr(args, 'entry_hive_real_home', False) else []
    stamped_keys = sorted(key for key in os.environ if key.startswith(('HIVE_', 'APIARY_')))
    if stamped_keys:
        raise Refusal('stamped controller environment: ' + ','.join(stamped_keys))
    lane = Path.cwd().resolve()
    try:
        real_home = Path(pwd.getpwuid(os.getuid()).pw_dir).resolve()
    except (KeyError, OSError) as error:
        raise Refusal('passwd identity unavailable before first write') from error
    root = Path(args.root)
    bootstrap = getattr(args, 'download_node', False)
    if bootstrap and args.node:
        raise Refusal('select either pinned per-run Node or configured Node')
    node = str(root / 'node-distribution' / node_bootstrap.TOP / 'bin/node') if bootstrap else select_node(args.node, real_home)
    env = environment(root, node)
    guard = validate(root, env, real_home)
    lock_path = Path('/private/var/tmp/hb-darwin-gate.lock')
    fd, lock_metadata = acquire_lock(lock_path)
    LOCK_METADATA[str(root.resolve())] = lock_metadata
    before_mkdir = time.time_ns()
    root.mkdir(mode=0o700)
    focused_seal.ROOT_CREATION[str(root.resolve())] = {'clock': 'CLOCK_REALTIME', 'beforeMkdirNs': before_mkdir, 'afterMkdirNs': time.time_ns(), 'marginMicroseconds': 1000000}
    CREATED_ROOTS.add(root.resolve())
    if focused_seal.ROOT_CREATION[str(root.resolve())]['afterMkdirNs'] < before_mkdir:
        raise Refusal('run-root realtime clock moved backwards during mkdir')
    (root / 'workload.log').touch()
    for value in set(env[k] for k in DIRS):
        Path(value).mkdir(parents=True, exist_ok=True)
    write_json(root / 'entry-guard.json', guard, root)
    write_json(root / 'lock.json', lock_metadata, root)
    write_json(root / 'environment.json', {'keys': sorted(env), 'paths': {k: env[k] for k in DIRS}, 'node': node, 'python': str(Path(sys.executable).resolve()), 'pythonVersion': sys.version, 'architecture': os.uname().machine}, root)
    print('GATE_ROOT=' + str(root), flush=True)
    if bootstrap:
        if os.uname().machine != 'arm64' or sys.platform != 'darwin':
            raise Refusal('pinned Node download requires Darwin arm64')
        try:
            node = node_bootstrap.download(root, env)
        except (ValueError, tarfile.TarError) as error:
            raise Refusal(str(error)) from error
        write_json(root / 'node-bootstrap.json', {'version': node_bootstrap.VERSION, 'url': node_bootstrap.URL, 'sha256': node_bootstrap.SHA256, 'verifiedBeforeExtraction': True, 'node': node, 'lifetime': 'run root only'}, root)
    policy = profile(root, real_home, lane)
    (root / 'workload.sb').write_text(policy)
    env['SCG_SB_PROFILE'] = policy
    env['GATE_ROOT'] = str(root)
    env['SCG_REAL_HOME'] = str(real_home)
    env['SCG_NODE_BIN'] = node
    env['SCG_SELF_TEST'] = '1' if args.self_test else '0'
    env['SCG_PYTHON_BIN'] = str(Path(sys.executable).resolve())
    env['SCG_SCOPE_HELPER'] = str(root / 'scope')
    env['LAB_ROOT'] = str(root / 't/selftests')
    workspace = source_copy(lane, args.source, root, env)
    focused_seal.quiescence_input(root, root / 'scope')
    identity = root / 'scope'
    prefix = ['/usr/bin/sandbox-exec', '-p', policy]
    preflight = subprocess.run(['/usr/bin/sandbox-exec', '-f', str(root / 'workload.sb'), '/usr/bin/true'], cwd=workspace, env=env, capture_output=True)
    (root / 'policy-preflight.log').write_bytes(preflight.stdout + preflight.stderr)
    if preflight.returncode:
        diagnostic = (preflight.stdout + preflight.stderr)[-16384:].decode('utf-8', errors='replace')
        print('POLICY_PREFLIGHT_DIAGNOSTIC_LAST_60_LINES', flush=True)
        print('\n'.join(diagnostic.splitlines()[-60:]), flush=True)
        raise Refusal('policy preflight failed; receipts retained at ' + str(root))
    tools = compiler_tools(root, env)
    build_policy = compiler_profile(profile(root, real_home, lane, pty=False), tools)
    write_json(root / 'compiler-permissions.json', {'literalAncestorMetadataOnly': compiler_metadata_literals(tools['clang']), 'noUserPaths': True, 'noAdditionalDataRead': True}, root)
    (root / 'compiler.sb').write_text(build_policy)
    version_command = ['/usr/bin/sandbox-exec', '-f', str(root / 'compiler.sb'), tools['clang'], '--version']
    version = subprocess.run(version_command, cwd=workspace, env=env, capture_output=True)
    (root / 'compiler-version.log').write_bytes(version.stdout + version.stderr)
    major = re.search(rb'clang version ([0-9]+)\.', version.stdout + version.stderr)
    if version.returncode or major is None:
        raise Refusal('compiler version unavailable; receipts retained at ' + str(root))
    resource = str(Path(tools['toolchain']) / 'usr/lib/clang' / major.group(1).decode('ascii'))
    compile_command = ['/usr/bin/sandbox-exec', '-f', str(root / 'compiler.sb'), tools['clang'], '-fintegrated-cc1', '-ccc-install-dir', str(Path(tools['clang']).parent), '-resource-dir', resource, '-isysroot', tools['sdk'], '--ld-path=' + tools['ld'], '-fmodules-cache-path=' + env['CLANG_MODULE_CACHE_PATH'], str(workspace / 'scripts/gates/darwin/scope.c'), '-o', str(identity)]
    dry_command = compile_command + ['-###']
    write_json(root / 'compiler-command.json', {'argv': compile_command, 'dryRunArgv': dry_command, 'noLauncher': True}, root)
    dry_run = subprocess.run(dry_command, cwd=workspace, env=env, capture_output=True)
    dry_log = b'CLANG_DRY_RUN\n' + dry_run.stdout + dry_run.stderr
    (root / 'compiler-dry-run.log').write_bytes(dry_log)
    if dry_run.returncode or not absolute_compiler_jobs((dry_run.stdout + dry_run.stderr).decode('utf-8', errors='replace')):
        print('COMPILER_DRY_RUN_REFUSED', flush=True)
        print('\n'.join(dry_log[-16384:].decode('utf-8', errors='replace').splitlines()[-60:]), flush=True)
        raise Refusal('compiler dry run lacks absolute jobs/resources; no build executed; receipts retained at ' + str(root))
    compile_result = subprocess.run(compile_command, cwd=workspace, env=env, capture_output=True)
    build_log = dry_log + b'CLANG_BUILD\n' + compile_result.stdout + compile_result.stderr
    (root / 'scope-build.log').write_bytes(build_log)
    if compile_result.returncode:
        diagnostic = build_log[-16384:].decode('utf-8', errors='replace')
        print('SCOPE_BUILD_DIAGNOSTIC_LAST_60_LINES', flush=True)
        print('\n'.join(diagnostic.splitlines()[-60:]), flush=True)
        raise Refusal('scope helper build failed; receipts retained at ' + str(root))
    try:
        focused_flow.observe_controller(sys.modules[__name__], root, identity)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        raise Refusal('controller bootstrap observation failed: ' + str(error)) from error
    tree_scan_self_test(root, workspace, prefix, identity, env)
    if args.self_test:
        try:
            scope_controls.run(sys.modules[__name__], root, workspace, identity, node, env)
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            raise Refusal('real scope control failed: ' + str(error)) from error
        flags_test = subprocess.run(prefix + [env['SCG_PYTHON_BIN'], '-B', str(workspace / 'scripts/gates/darwin/focused_node_flags_test.py')], cwd=workspace, env=env, capture_output=True, timeout=20)
        (root / 'logs/node-default-argv-control.log').write_bytes(flags_test.stdout + flags_test.stderr)
        if flags_test.returncode:
            raise Refusal('real default-isolation Node argv control failed')
    if args.self_test or args.body == 'scripts/gates/darwin/focused-manifest-body.sh':
        try:
            pty_controls.run(sys.modules[__name__], root, workspace, identity, env, compile_command, self_test=args.self_test, focused_precondition=args.body == 'scripts/gates/darwin/focused-manifest-body.sh', baseline_policy=profile(root, real_home, lane, pty=False))
            pty_controls.require_precondition(root, pty_controls.os_build(env))
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            raise Refusal('real PTY precondition failed: ' + str(error)) from error
    static_rows = listener_static.scan(workspace)
    write_json(root / 'listener-static.json', {'violations': static_rows, 'scope': 'v2/** and tests/**'}, root)
    if static_rows and not args.self_test:
        raise Refusal('static listener check found wildcard or omitted/unresolved hosts')
    if args.self_test:
        negative = listener_static.violations('server.listen(0)')
        write_json(root / 'listener-static-self-test.json', {'fixture': 'server.listen(0)', 'expectedClassification': 'FAIL', 'detected': bool(negative), 'violations': negative}, root)
        if not negative:
            raise Refusal('static no-host listener self-test failed')
        listener_self_tests(root, workspace, prefix, identity, env)
    if args.self_test:
        seed_file = root / 'self-test-cache-seed.tar'
        with tarfile.open(seed_file, 'w') as archive:
            for name in ('npm', 'pnpm', 'node'):
                member = tarfile.TarInfo(name)
                member.type = tarfile.DIRTYPE
                archive.addfile(member)
        seed = seed_cache(seed_file, hashlib.sha256(seed_file.read_bytes()).hexdigest(), root, lane)
        seed['selfTestEmptySeed'] = True
    else:
        if not args.seed or not args.seed_sha:
            raise Refusal('per-run cache seed and sha256 required')
        seed = seed_cache(args.seed, args.seed_sha, root, lane)
    write_json(root / 'cache-seed.json', seed, root)
    sentinel_home = root / 'sentinel-fixture' if args.self_test else real_home
    before = launchagents(sentinel_home)
    write_json(root / 'launchagents-before.json', before, root)
    if args.body == 'scripts/gates/darwin/focused-manifest-body.sh':
        try:
            rc = focused_flow.run(sys.modules[__name__], root, workspace, env, tools, real_home)
        except (ValueError, KeyError, TypeError, RuntimeError) as error:
            raise Refusal('focused validation failed: ' + str(error)) from error
        after = launchagents(real_home)
        write_json(root / 'launchagents-after.json', after, root)
        if before != after:
            rc = 95
        reason = 'focused rows or sentinel failed' if rc else None
        write_json(root / 'receipt.json', {'version': 2, 'exit': rc, 'reason': reason, 'source': args.source, 'focused': True, 'limitations': focused_flow.LIMITATIONS, 'rootRetained': True, 'cacheSeed': seed, 'listenerLimit': LISTENER_LIMIT, 'siblingHarnessOutsideOuterSeatbelt': True, 'leftoverChild': list(LEFTOVER_CHILDREN)}, root)
        if rc:
            print('GATE_NONZERO_REASON=' + json.dumps(reason), flush=True)
        print('GATE_RECEIPT_SHA256=' + receipt_hashes(root), flush=True)
        os.close(fd)
        return rc
    if args.self_test:
        env.update(make_socket_controls(root))
        try:
            GIT_CONTROLS[str(root.resolve())] = git_boundary.prepare(root, env)
        except (ValueError, subprocess.SubprocessError) as error:
            raise Refusal('Git boundary fixture preparation failed: ' + str(error)) from error
    output = (root / 'workload.log').open('wb')
    read_fd, release_fd = os.pipe()
    command = prefix + ['/bin/bash', str(workspace / 'scripts/gates/darwin/workload.sh'), str(workspace / args.body)]
    proc = subprocess.Popen([sys.executable, '-B', str(workspace / 'scripts/gates/darwin/start_wait.py'), str(read_fd), *command], pass_fds=(read_fd,), cwd=workspace, env=env, stdout=output, stderr=subprocess.STDOUT)
    focused_seal.remember_launch(proc.pid)
    os.close(read_fd)
    write_json(root / 'workload-dispatch.json', {'pid': proc.pid, 'time': time.time(), 'cwd': str(workspace)}, root)
    try:
        birth = scope_call(identity, 'identity', proc.pid)
        if len(birth) != 1:
            raise Refusal('workload birth unobserved')
        write_json(root / 'workload-birth.json', {'birth': birth, 'releaseRecordedAt': time.time()}, root)
        os.write(release_fd, b'1')
    except (Refusal, OSError, subprocess.SubprocessError):
        os.close(release_fd)
        proc.wait(timeout=5)
        output.close()
        raise
    else:
        os.close(release_fd)
    tracked = {}
    scans = []
    tracked[(birth[0][0], birth[0][2], birth[0][3])] = birth[0]
    exited = set()
    scope_error = None
    listener_samples = []
    try:
        while proc.poll() is None:
            rows = scope_call(identity, 'scan', *birth[0])
            for row in rows:
                tracked.setdefault((row[0], row[2], row[3]), row)
            for sample in sample_retained_listeners(identity, tracked, exited):
                listener_samples.append(sample)
                if sample.get('error') or any(not listener['loopback'] for listener in sample['listeners']):
                    scope_error = 'non-loopback listener or unresolved listener observation'
            scans.append({'time': time.time(), 'rows': rows})
            if scope_error:
                break
            time.sleep(0.05)
    except (subprocess.SubprocessError, Refusal, OSError, ValueError):
        scope_error = 'scope or listener observation failed; no unobserved identity may be signalled'
    signals = []
    for row in tracked.values():
        if row == birth[0] and scope_error is None:
            continue
        for sig in (signal.SIGTERM, signal.SIGKILL):
            attempt = subprocess.run([str(identity), 'signal', *row, str(int(sig))], capture_output=True, text=True)
            signals.append({'identity': row, 'signal': int(sig), 'exit': attempt.returncode, 'result': attempt.stdout.strip()})
            if attempt.returncode == 3:
                break
            if attempt.returncode != 0:
                scope_error = 'cleanup birth unavailable or mismatched; refused signal'
                break
            time.sleep(0.25)
    remaining = []
    for row in tracked.values():
        check = subprocess.run([str(identity), 'status', *row], capture_output=True, text=True)
        remaining.append({'identity': row, 'exit': check.returncode, 'result': check.stdout.strip()})
        if check.returncode != 3:
            scope_error = 'tracked process still alive or unobserved after cleanup'
    if proc.poll() is None:
        scope_error = 'workload did not exit after identity-fenced cleanup'
    else:
        proc.wait()
    output.close()
    close_socket_controls(root)
    write_json(root / 'scope.json', {'rootBirth': birth, 'scans': scans, 'signals': signals, 'postCleanup': remaining, 'observations': SCOPE_OBSERVATIONS, 'error': scope_error}, root)
    intervals = [scans[index + 1]['time'] - scans[index]['time'] for index in range(len(scans) - 1)]
    write_json(root / 'listeners.json', {'samples': listener_samples, 'sleepSeconds': 0.05, 'cycleIntervalsSeconds': intervals, 'maximumCycleSeconds': max(intervals) if intervals else None, 'limit': LISTENER_LIMIT}, root)
    after = launchagents(sentinel_home)
    write_json(root / 'launchagents-after.json', after, root)
    rc = proc.returncode if proc.returncode is not None else 95
    if scope_error:
        rc = 95
    if before != after:
        rc = 95
    leftover = None
    try:
        leftover_fd = os.open(root / 'leftover-child.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        pass
    except OSError:
        leftover = {'state': 'unknown', 'error': 'unreadable leftover child record'}
        rc = 95
    else:
        try:
            with os.fdopen(leftover_fd, 'rb') as stream:
                if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                    raise ValueError('wrong leftover record type')
                data = stream.read(65537)
            if len(data) > 65536:
                raise ValueError('oversize leftover record')
            leftover = json.loads(data)
            if not isinstance(leftover, dict):
                raise ValueError('wrong leftover record shape')
        except (ValueError, OSError):
            leftover = {'state': 'unknown', 'error': 'malformed leftover child record'}
            rc = 95
    outcome = workload_outcome(root, proc.returncode, rc, scope_error, before != after, args.self_test)
    rc, reason = outcome['exit'], outcome['reason']
    if leftover:
        reason = (reason or 'recorded self-expiring test child') + '; leftoverChild=' + json.dumps(leftover, sort_keys=True)
    write_json(root / 'receipt.json', {'version': 2, 'exit': rc, 'reason': reason, 'workloadExit': outcome['workloadExit'], 'workloadNonzeroReason': outcome['workloadNonzeroReason'], 'secondaryNotes': outcome['secondaryNotes'], 'leftoverChild': leftover, 'source': args.source, 'selfTest': args.self_test, 'libraryScope': 'LaunchAgents names and sha256 only', 'cacheSeed': seed, 'rootRetained': True, 'network': {'namespace': 'SHARED', 'seatbelt': 'deny network*, allow loopback IP and Unix sockets under TMPDIR only', 'unixScope': str(root / 't'), 'residualRisk': 'outbound loopback can reach host-local services; no Darwin network namespace', 'neededBy': ['v2/daemon/tests/auth-death-fixture.test.ts:44,49', 'v2/daemon/tests/claude-refresh-transport.test.ts:22', 'v2/daemon/tests/lease-enrol-rpc.test.ts:19', 'v2/daemon/tests/auth-death-rpc.test.ts:44']}, 'scopeLimitation': 'sampling may miss a process born and reparented between observations'}, root)
    if rc or leftover:
        print('GATE_NONZERO_REASON=' + json.dumps(reason), flush=True)
    digest = receipt_hashes(root)
    print('GATE_RECEIPT_SHA256=' + digest, flush=True)
    os.close(fd)
    return rc


def workload_outcome(root, body_exit, rc, scope_error, launch_changed, git_required):
    notes = []
    body_reason = None
    if body_exit not in (None, 0):
        body_reason = 'workload exited ' + str(body_exit)
        try:
            descriptor = os.open(root / 'workload.log', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(descriptor, 'rb') as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode):
                    raise ValueError('nonregular workload log')
                stream.seek(max(0, info.st_size - 16384))
                tail = stream.read(16384).decode('utf-8', 'replace')
            for line in tail.splitlines():
                match = re.fullmatch(r'WORKLOAD_NONZERO_REASON=(phase:(?:startup|node-validation|body|final-guards) exit:([0-9]+))', line)
                if match and int(match[2]) == body_exit:
                    body_reason = match[1]
        except (OSError, ValueError):
            notes.append('workload nonzero marker unavailable')
    reason = body_reason or scope_error or ('LaunchAgents sentinel changed' if launch_changed else ('workload exited ' + str(rc) if rc else None))
    if body_reason and scope_error:
        notes.append(scope_error)
    if body_reason and launch_changed:
        notes.append('LaunchAgents sentinel changed')
    if git_required and not audit_git_controls(root):
        if body_exit not in (None, 0):
            notes.append('Git boundary audit failed; secondary to nonzero workload exit')
            audit = GIT_AUDITS.setdefault(str(root.resolve()), {'accepted': False, 'error': 'Git boundary fixture controls absent'})
            audit['secondaryToWorkloadExit'] = body_exit
            write_json(root / 'git-boundary-controller.json', audit, root)
        else:
            rc = 95
            reason = reason or 'Git boundary audit failed'
    return {'exit': rc, 'reason': reason, 'workloadExit': body_exit, 'workloadNonzeroReason': body_reason, 'secondaryNotes': notes}


def audit_git_controls(root):
    controls = GIT_CONTROLS.get(str(root.resolve()))
    if controls is None:
        return False
    try:
        after = git_boundary.snapshot(root / 'sealed-target')
        evidence = json.loads((root / 'git-boundary-workload.json').read_text())
        audit = {'unchanged': after == controls['before'], 'before': controls['before'], 'after': after, 'workload': evidence}
        accepted = audit['unchanged'] and evidence.get('allDenied') is True
    except (OSError, ValueError) as error:
        audit = {'accepted': False, 'error': str(error)}
        accepted = False
    audit['accepted'] = accepted
    GIT_AUDITS[str(root.resolve())] = audit
    write_json(root / 'git-boundary-controller.json', audit, root)
    return accepted


def acquire_lock(path):
    try:
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    except OSError as error:
        raise Refusal('unsafe or unavailable host lock') from error
    try:
        value = os.fstat(fd)
        if value.st_uid != os.getuid() or not stat.S_ISREG(value.st_mode) or stat.S_IMODE(value.st_mode) != 0o600 or value.st_size != 0:
            raise Refusal('unsafe host lock owner, mode, type or nonempty contents')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd, {'path': str(path), 'dev': value.st_dev, 'ino': value.st_ino, 'mode': stat.S_IMODE(value.st_mode), 'uid': value.st_uid, 'size': value.st_size, 'operation': 'flock only; never written, removed or swept', 'authorization': 'Queen, 17 Oct 12:13Z'}
    except Exception:
        os.close(fd)
        raise


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--root', required=True)
    p.add_argument('--node')
    p.add_argument('--download-node', action='store_true')
    p.add_argument('--seed')
    p.add_argument('--seed-sha')
    p.add_argument('--source', required=True)
    p.add_argument('--self-test', action='store_true')
    p.add_argument('--entry-hive-real-home', action='store_true')
    p.add_argument('body')
    args = p.parse_args()
    try:
        return run(args)
    except (Refusal, OSError, subprocess.SubprocessError) as error:
        if LEFTOVER_CHILDREN:
            error = Refusal(str(error) + '; leftoverChild=' + json.dumps(LEFTOVER_CHILDREN, sort_keys=True))
        print('REFUSING: ' + str(error), file=sys.stderr)
        print('GATE_NONZERO_REASON=' + json.dumps('guard refusal: ' + str(error)), flush=True)
        root = Path(args.root)
        if root.resolve() in CREATED_ROOTS:
            if str(root.resolve()) in GIT_CONTROLS:
                audit_git_controls(root)
            try:
                close_socket_controls(root)
            except (OSError, Refusal) as cleanup:
                error = Refusal(str(error) + '; control cleanup: ' + str(cleanup))
            write_json(root / 'receipt.json', {'version': 2, 'exit': 90, 'source': args.source, 'error': str(error), 'rootRetained': True, 'complete': False}, root)
            print('GATE_RECEIPT_SHA256=' + receipt_hashes(root), flush=True)
        return 90


if __name__ == '__main__':
    sys.exit(main())
