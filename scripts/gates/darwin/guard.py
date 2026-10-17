import argparse
import fcntl
import hashlib
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

PROVIDERS = ('.claude', '.codex', '.grok', '.kimi', '.gemini', '.cursor', '.muse', '.config/opencode', '.config/muse', '.local/share/opencode')
PROTECTED = ('.hive', '.config', '.ssh', '.gnupg', 'Library', '.apiary', '.local/share/apiary', '.local/share/apiary-satellite', '.local/share/apiary/satellite-updater', *PROVIDERS)
SCOPE_OBSERVATIONS = []
CREATED_ROOTS = set()
CONTROL_SOCKETS = []
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


def write_json(path, value, root):
    path = Path(path)
    if not inside(path.resolve(), root.resolve()):
        raise Refusal('write outside run root')
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


def seed_cache(source, expected, root, lane):
    source = Path(source).resolve()
    if not inside(source, root) and not inside(source, lane):
        raise Refusal('cache seed outside run root or pinned lane')
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    if digest != expected:
        raise Refusal('cache seed hash mismatch')
    with tarfile.open(source) as archive:
        members = archive.getmembers()
        names = set()
        for member in members:
            path = Path(member.name)
            if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] not in ('npm', 'pnpm', 'node') or path.as_posix() in names or not (member.isfile() or member.isdir()):
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


def profile(root, home, lane):
    quote = lambda p: json.dumps(str(p))
    return ''.join((
        '(version 1)(allow default)',
        '(deny file-write*)(allow file-write* (subpath ' + quote(root) + '))',
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


def without_ip_bind(policy):
    rule = '(allow network-bind (local ip "localhost:*"))'
    assert policy.count(rule) == 1, 'expected exactly one IP bind rule'
    return policy.replace(rule, '', 1)


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


def scope_call(helper, command, *args):
    argv = [str(helper), command, *map(str, args)]
    value = subprocess.run(argv, capture_output=True, text=True)
    SCOPE_OBSERVATIONS.append({'time': time.time(), 'argv': argv, 'exit': value.returncode, 'stdout': value.stdout, 'stderr': value.stderr})
    value.check_returncode()
    return [line.split() for line in value.stdout.splitlines()]


def run(args):
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
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    lock_stat = os.fstat(fd)
    if lock_stat.st_uid != os.getuid() or not stat.S_ISREG(lock_stat.st_mode):
        raise Refusal('unsafe host lock')
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise Refusal('another gate holds the host lock')
    root.mkdir(mode=0o700)
    CREATED_ROOTS.add(root.resolve())
    for value in set(env[k] for k in DIRS):
        Path(value).mkdir(parents=True, exist_ok=True)
    write_json(root / 'entry-guard.json', guard, root)
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
    if args.self_test:
        for name, probe_policy in (('real-profile', policy), ('no-ip-bind', without_ip_bind(policy))):
            profile_path = root / (name + '-probe.sb')
            profile_path.write_text(probe_policy)
            command = ['/usr/bin/sandbox-exec', '-f', str(profile_path), env['SCG_PYTHON_BIN'], '-B', str(workspace / 'scripts/gates/darwin/bind_probe.py'), str(root), name]
            probe = subprocess.run(command, cwd=workspace, env=env, capture_output=True, text=True)
            diagnostic = {'selfTestOnly': True, 'profile': name, 'argv': command, 'exit': probe.returncode, 'stdout': probe.stdout[-16384:], 'stderr': probe.stderr[-4096:]}
            write_json(root / (name + '-probe.json'), diagnostic, root)
            print('CONTROLLER_BIND_PROFILE_DIAGNOSTIC=' + json.dumps(diagnostic), flush=True)
            if probe.returncode:
                raise Refusal('controller bind probe failed: ' + name)
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
    build_policy = compiler_profile(policy, tools)
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
    if args.self_test:
        env.update(make_socket_controls(root))
    output = (root / 'workload.log').open('wb')
    read_fd, release_fd = os.pipe()
    command = prefix + ['/bin/bash', str(workspace / 'scripts/gates/darwin/workload.sh'), str(workspace / args.body)]
    proc = subprocess.Popen([sys.executable, '-B', str(workspace / 'scripts/gates/darwin/start_wait.py'), str(read_fd), *command], pass_fds=(read_fd,), cwd=workspace, env=env, stdout=output, stderr=subprocess.STDOUT)
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
    tracked[tuple(birth[0])] = birth[0]
    scope_error = None
    try:
        while proc.poll() is None:
            rows = scope_call(identity, 'scan', *birth[0])
            for row in rows:
                tracked[tuple(row)] = row
            scans.append({'time': time.time(), 'rows': rows})
            time.sleep(0.05)
    except subprocess.SubprocessError:
        scope_error = 'scope observation failed; no unobserved identity may be signalled'
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
    reason = scope_error or ('LaunchAgents sentinel changed' if before != after else ('workload exited ' + str(rc) + '; diagnostic: ' + str(root / 'workload.log') if rc else None))
    if leftover:
        reason = (reason or 'recorded self-expiring test child') + '; leftoverChild=' + json.dumps(leftover, sort_keys=True)
    write_json(root / 'receipt.json', {'version': 2, 'exit': rc, 'reason': reason, 'leftoverChild': leftover, 'source': args.source, 'selfTest': args.self_test, 'libraryScope': 'LaunchAgents names and sha256 only', 'cacheSeed': seed, 'rootRetained': True, 'network': {'namespace': 'SHARED', 'seatbelt': 'deny network*, allow loopback IP and Unix sockets under TMPDIR only', 'unixScope': str(root / 't'), 'residualRisk': 'outbound loopback can reach host-local services; no Darwin network namespace', 'neededBy': ['v2/daemon/tests/auth-death-fixture.test.ts:44,49', 'v2/daemon/tests/claude-refresh-transport.test.ts:22', 'v2/daemon/tests/lease-enrol-rpc.test.ts:19', 'v2/daemon/tests/auth-death-rpc.test.ts:44']}, 'scopeLimitation': 'sampling may miss a process born and reparented between observations'}, root)
    if rc or leftover:
        print('GATE_NONZERO_REASON=' + json.dumps(reason), flush=True)
    digest = receipt_hashes(root)
    print('GATE_RECEIPT_SHA256=' + digest, flush=True)
    os.close(fd)
    return rc


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--root', required=True)
    p.add_argument('--node')
    p.add_argument('--download-node', action='store_true')
    p.add_argument('--seed')
    p.add_argument('--seed-sha')
    p.add_argument('--source', required=True)
    p.add_argument('--self-test', action='store_true')
    p.add_argument('body')
    args = p.parse_args()
    try:
        return run(args)
    except (Refusal, OSError, subprocess.SubprocessError) as error:
        print('REFUSING: ' + str(error), file=sys.stderr)
        print('GATE_NONZERO_REASON=' + json.dumps('guard refusal: ' + str(error)), flush=True)
        root = Path(args.root)
        if root.resolve() in CREATED_ROOTS:
            try:
                close_socket_controls(root)
            except (OSError, Refusal) as cleanup:
                error = Refusal(str(error) + '; control cleanup: ' + str(cleanup))
            write_json(root / 'receipt.json', {'version': 2, 'exit': 90, 'source': args.source, 'error': str(error), 'rootRetained': True, 'complete': False}, root)
            print('GATE_RECEIPT_SHA256=' + receipt_hashes(root), flush=True)
        return 90


if __name__ == '__main__':
    sys.exit(main())
