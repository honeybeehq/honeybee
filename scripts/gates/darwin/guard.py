import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import signal
import stat
import subprocess
import sys
import tarfile
import time

PROVIDERS = ('.claude', '.codex', '.grok', '.kimi', '.gemini', '.cursor', '.muse', '.config/opencode', '.config/muse', '.local/share/opencode')
PROTECTED = ('.hive', '.config', '.ssh', '.gnupg', 'Library', '.apiary', '.local/share/apiary', '.local/share/apiary-satellite', '.local/share/apiary/satellite-updater', *PROVIDERS)
SCOPE_OBSERVATIONS = []
CREATED_ROOTS = set()
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
    return '(version 1)(allow default)(deny file-write*)(allow file-write* (subpath ' + quote(root) + '))(deny file-read* (subpath ' + quote(home) + '))(deny file-read* (subpath "/Library/Keychains") (subpath "/private/var/db/Keychains"))(deny process-exec (literal "/usr/bin/security"))(deny mach-lookup)(deny signal)(allow signal (target same-sandbox))(deny process-info*)(allow process-info* (target same-sandbox))(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))(allow network-outbound (remote unix-socket (subpath ' + quote(root) + '))))'


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


def scope_call(helper, command, *args):
    argv = [str(helper), command, *map(str, args)]
    value = subprocess.run(argv, capture_output=True, text=True)
    SCOPE_OBSERVATIONS.append({'time': time.time(), 'argv': argv, 'exit': value.returncode, 'stdout': value.stdout, 'stderr': value.stderr})
    value.check_returncode()
    return [line.split() for line in value.stdout.splitlines()]


def run(args):
    lane = Path.cwd().resolve()
    real_home = Path(pwd.getpwuid(os.getuid()).pw_dir).resolve()
    root = Path(args.root)
    node = select_node(args.node, real_home)
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
    policy = profile(root, real_home, lane)
    (root / 'workload.sb').write_text(policy)
    env['SCG_SB_PROFILE'] = policy
    env['GATE_ROOT'] = str(root)
    env['SCG_REAL_HOME'] = str(real_home)
    env['SCG_NODE_BIN'] = node
    env['SCG_SELF_TEST'] = '1' if args.self_test else '0'
    env['SCG_PYTHON_BIN'] = str(Path(sys.executable).resolve())
    env['SCG_SCOPE_HELPER'] = str(root / 'scope')
    env['LAB_ROOT'] = str(root / 'selftests')
    workspace = source_copy(lane, args.source, root, env)
    identity = root / 'scope'
    prefix = ['/usr/bin/sandbox-exec', '-p', policy]
    compile_result = subprocess.run(prefix + ['/usr/bin/cc', str(workspace / 'scripts/gates/darwin/scope.c'), '-o', str(identity)], cwd=workspace, env=env, capture_output=True)
    (root / 'scope-build.log').write_bytes(compile_result.stdout + compile_result.stderr)
    if compile_result.returncode:
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
            attempt = subprocess.run([str(identity), 'signal', *row, str(sig)], capture_output=True, text=True)
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
    write_json(root / 'scope.json', {'rootBirth': birth, 'scans': scans, 'signals': signals, 'postCleanup': remaining, 'observations': SCOPE_OBSERVATIONS, 'error': scope_error}, root)
    after = launchagents(sentinel_home)
    write_json(root / 'launchagents-after.json', after, root)
    rc = proc.returncode if proc.returncode is not None else 95
    if scope_error:
        rc = 95
    if before != after:
        rc = 95
    write_json(root / 'receipt.json', {'version': 2, 'exit': rc, 'source': args.source, 'selfTest': args.self_test, 'libraryScope': 'LaunchAgents names and sha256 only', 'cacheSeed': seed, 'rootRetained': True, 'network': {'namespace': 'SHARED', 'seatbelt': 'non-loopback outbound denied'}, 'scopeLimitation': 'sampling may miss a process born and reparented between observations'}, root)
    digest = receipt_hashes(root)
    print('GATE_RECEIPT_SHA256=' + digest, flush=True)
    os.close(fd)
    return rc


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--root', required=True)
    p.add_argument('--node')
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
        root = Path(args.root)
        if root.resolve() in CREATED_ROOTS:
            write_json(root / 'receipt.json', {'version': 2, 'exit': 90, 'source': args.source, 'error': str(error), 'rootRetained': True, 'complete': False}, root)
            print('GATE_RECEIPT_SHA256=' + receipt_hashes(root), flush=True)
        return 90


if __name__ == '__main__':
    sys.exit(main())
