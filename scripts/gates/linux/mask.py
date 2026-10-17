import os, sys, pathlib, json, ctypes, subprocess, time, stat, uuid, socket, fcntl, struct, hashlib
from home_guard import entry_guard
from filesystem import seal_filesystem, mount_readonly, assert_filesystem, filesystem_probes
from test_capabilities import SETPRIV_ARGS
R = pathlib.Path(sys.argv[1])
ENTRY_GUARD = entry_guard(R)
H = pathlib.Path(json.loads((R / 'config.json').read_text())['realHome'])
CACHE = R
label = sys.argv[2]
cmd = sys.argv[3:]
out = R / 'receipts' / label
out.mkdir(parents=True, exist_ok=True)
outfd = os.open(out, os.O_RDONLY | os.O_DIRECTORY)

def save(name, value):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 384, dir_fd=outfd)
    with os.fdopen(fd, 'w') as f:
        json.dump(value, f, indent=2)

save('entry-guard-mask.json', ENTRY_GUARD)

def mount(source, target, kind, flags, data=None):
    args = [x.encode() if isinstance(x, str) else x for x in (source, str(target), kind, data)]
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.mount(args[0], args[1], args[2], ctypes.c_ulong(flags), args[3]) != 0:
        raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()), str(target))

def mount_table():
    result = {}
    for line in pathlib.Path('/proc/self/mountinfo').read_text().splitlines():
        a, b = line.split(' - ', 1)
        cols = a.split()
        result[cols[4]] = dict(type=b.split()[0], options=cols[5].split(','))
    return result
initialcwd = os.getcwd()
nonce = str(uuid.uuid4())
receipt = dict(label=label, nonce=nonce, preparedAt=time.time(), pid=os.getpid(), command=cmd, ownCgroup=pathlib.Path('/proc/self/cgroup').read_text(), namespaces={k: os.readlink('/proc/self/ns/' + k) for k in ('user', 'mnt', 'net','pid')}, namedRealExceptions=[str(CACHE)], samplerStartsBeforeWorkload=True)
try:
    propagation = {}
    for target in ('/', '/home'):
        p = subprocess.run(['findmnt', '-n', '-o', 'PROPAGATION', '--target', target], capture_output=True, text=True)
        propagation[target] = dict(exit=p.returncode, stdout=p.stdout.strip(), stderr=p.stderr)
        if p.returncode or p.stdout.strip() != 'private' or p.stderr:
            raise RuntimeError('mount propagation is not private: ' + target)
    receipt['preMountPropagation'] = propagation
    visible = sorted(int(name) for name in os.listdir('/proc') if name.isdigit())
    assert os.getpid() == 1 and visible == [1]
    assert os.readlink('/proc/1/ns/pid') == os.readlink('/proc/self/ns/pid')
    receipt['privateProcAssertion'] = dict(asserted=True, initPid=1, init='mask.py execs reaping init.py before monitor',visiblePids=visible, namespace=os.readlink('/proc/self/ns/pid'), filesystem=mount_table()['/proc']['type'],mountOrder='unshare makes propagation recursively private before --mount-proc; explicit propagation assertions at Python entry')
    assert receipt['privateProcAssertion']['filesystem'] == 'proc'
    save('mask-setup.json', receipt)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    request = struct.pack('16sH14s', b'lo', 0, b'')
    flags = struct.unpack('16sH14s', fcntl.ioctl(sock.fileno(), 35091, request))[1]
    fcntl.ioctl(sock.fileno(), 35092, struct.pack('16sH14s', b'lo', flags | 1, b''))
    sock.close()
    before = json.loads((out / 'before.json').read_text())
    assert before['entries'] and str(H / '.hive/v2/hived.sock') in before['entries'] and (not before['errors'])
    explicit = ['.hive', '.claude', '.codex', '.grok', '.kimi', '.gemini', '.cursor', '.muse', '.ssh', '.gnupg', '.config/systemd/user', '.config/opencode', '.config/muse', '.local/share/opencode', 'Code', 'Projects']
    scaffolds = {str(H), str(H / '.cache'), str(H / '.config'), str(H / '.config/systemd'), str(H / '.local'), str(H / '.local/share')}
    targets = set((str(H / p) for p in explicit))
    for path, meta in before['entries'].items():
        p = pathlib.Path(path)
        if p.parent == H and str(p) not in scaffolds:
            targets.add(str(p))
    targets.discard(str(CACHE))
    targets.discard(str(H / '.cache'))
    empty = R / 'empty' / label
    empty.mkdir(parents=True, exist_ok=True)
    cachefd = os.open(CACHE, os.O_PATH | os.O_DIRECTORY)
    cacheid = os.fstat(cachefd)
    mount('tmpfs', empty, 'tmpfs', 1 | 2 | 4 | 8, 'size=4096,mode=0555')
    emptyfd = os.open(empty, os.O_PATH | os.O_DIRECTORY)
    emptydev = os.fstat(emptyfd).st_dev
    mount('tmpfs', H, 'tmpfs', 2 | 4, 'size=16777216,mode=0755')
    CACHE.mkdir(parents=True)
    mount('/proc/self/fd/' + str(cachefd), CACHE, None, 4096 | 16384)
    assert os.stat(CACHE).st_ino == cacheid.st_ino and os.stat(CACHE).st_dev == cacheid.st_dev
    for target in sorted(targets, key=lambda p: (p.count('/'), p)):
        p = pathlib.Path(target)
        p.mkdir(parents=True, exist_ok=True)
        mount('/proc/self/fd/' + str(emptyfd), p, None, 4096)
        mount(None, p, None, 4096 | 32 | 1)
    mount(None, H, None, 32 | 1)
    mounts = mount_table()
    assertions = []
    for target in sorted(targets):
        v = dict(path=target, **mounts.get(target, {}), empty=os.listdir(target) == [], readOnly=bool(os.statvfs(target).f_flag & os.ST_RDONLY), device=os.stat(target).st_dev)
        v['asserted'] = v.get('type') == 'tmpfs' and v['empty'] and v['readOnly'] and ('ro' in v.get('options', [])) and (v['device'] == emptydev)
        assertions.append(v)
        if not v['asserted']:
            raise RuntimeError('mask assertion failed: ' + target)
    os.chdir(initialcwd)
    assert os.getcwd() == str(CACHE) or os.getcwd().startswith(str(CACHE) + '/'), 'cwd must be inside the current run root'
    assert mounts[str(H)]['type'] == 'tmpfs' and 'ro' in mounts[str(H)]['options']
    assert sorted(os.listdir(H / '.cache')) == [CACHE.parent.name]
    assert sorted(os.listdir(CACHE.parent)) == [CACHE.name]
    assert not os.path.lexists(H / '.hive/v2/hived.sock')
    libc=ctypes.CDLL(None,use_errno=True)
    private_tmp = CACHE / 'lab-tmp' / label
    private_tmp.mkdir(parents=True, mode=0o1777)
    private_tmp.chmod(0o1777)
    mount(str(private_tmp), '/tmp', None, 4096)
    os.close(outfd)
    outfd = os.open(out, os.O_RDONLY | os.O_DIRECTORY)
    seal_filesystem(CACHE)
    parent_namespaces=dict(receipt['namespaces'])
    outer_uid,outer_gid=os.getuid(),os.getgid()
    if libc.unshare(ctypes.c_int(0x10000000|0x00020000))!=0:raise OSError(ctypes.get_errno(),'nested user/mount unshare failed')
    pathlib.Path('/proc/self/setgroups').write_text('deny')
    pathlib.Path('/proc/self/uid_map').write_text(f'1000 {outer_uid} 1')
    pathlib.Path('/proc/self/gid_map').write_text(f'1000 {outer_gid} 1')
    assert os.getuid() == os.getgid() == 1000
    receipt['workloadIdentity'] = dict(uid=1000, gid=1000, uidMap=pathlib.Path('/proc/self/uid_map').read_text(), gidMap=pathlib.Path('/proc/self/gid_map').read_text())
    receipt['filesystem'] = assert_filesystem(CACHE, 'mask.py')
    receipt['namespaces']={key:os.readlink('/proc/self/ns/'+key) for key in ('user','mnt','net','pid')}
    receipt['parentNamespaces']=parent_namespaces
    repo_targets = sorted(target for target in targets if pathlib.Path(target).parent == H and not pathlib.Path(target).name.startswith('.'))
    locked_probes = [('umount-home', str(H), 'umount'), ('umount-proc', '/proc', 'umount'), ('remount-hive-rw', str(H / '.hive'), 'mount')]
    locked_probes += [(operation + ':' + target, target, operation) for target in repo_targets for operation in ('umount', 'mount')]
    readfd,writefd=os.pipe()
    probe=os.fork()
    if probe==0:
        os.close(readfd)
        if libc.unshare(ctypes.c_int(0x00020000))!=0:os._exit(3)
        for name,target,operation in locked_probes:
            ctypes.set_errno(0)
            result=libc.umount2(target.encode(),0) if operation=='umount' else libc.mount(None,target.encode(),None,ctypes.c_ulong(4096|32),None)
            number=ctypes.get_errno()
            record=dict(probe=name,path=target,result=result,errno=number,expectedFailure=result==-1 and number in (1,22))
            os.write(writefd,(json.dumps(record)+'\n').encode())
            if not record['expectedFailure']:os._exit(2)
        os._exit(0)
    os.close(writefd)
    with os.fdopen(readfd) as stream:probe_records=[json.loads(line) for line in stream]
    unused,probe_status=os.waitpid(probe,0)
    receipt['lockedMountProbes']=probe_records
    save('locked-mount-probes.json',dict(probes=probe_records,childExit=os.waitstatus_to_exitcode(probe_status)))
    if probe_status or len(probe_records)!=len(locked_probes) or not all(item['expectedFailure'] for item in probe_records):raise RuntimeError('locked mount negative probe failed; workload forbidden')
    code = H / 'Code'
    code_probe = dict(path=str(code), empty=os.listdir(code) == [], refused=False)
    try:
        fd = os.open(code / ('gate-write-' + nonce), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except OSError as error:
        code_probe.update(errno=error.errno, refused=error.errno in (13, 30))
    else:
        os.close(fd)
    code_probe['asserted'] = code_probe['empty'] and code_probe['refused']
    receipt['repoRootSelfTests'] = code_probe
    save('repo-root-tests.json', code_probe)
    if not code_probe['asserted']:
        raise RuntimeError('Code mask read/write self-test failed; workload forbidden')
    receipt['filesystemProbes'] = filesystem_probes(CACHE, privilege_checks=False)
    save('filesystem-proof.json', dict(state=receipt['filesystem'], probes=receipt['filesystemProbes']))
    if not receipt['filesystemProbes']['asserted']:
        raise RuntimeError('filesystem write-exclusion or device probe failed; workload forbidden')
    receipt.update(maskTargets=assertions, syntheticScaffolds=sorted(scaffolds), realHomeOverlay=mounts[str(H)], cacheException=dict(path=str(CACHE), inode=cacheid.st_ino, device=cacheid.st_dev), insideAsserted=True, insideAssertedAt=time.time(), loopbackUp=True, cwdAfter=os.getcwd())
    save('mask-inside.json', receipt)
    save('mask-ready.json', dict(nonce=nonce, time=time.time(), insideAsserted=True))
    os.close(emptyfd)
    os.close(cachefd)
    while not (out / 'GO.json').exists() and (not (out / 'ABORT.json').exists()):
        time.sleep(0.05)
    if (out / 'ABORT.json').exists():
        raise RuntimeError('outside pre-exec assertion failed')
    go = json.loads((out / 'GO.json').read_text())
    assert go['nonce'] == nonce and go['asserted'] and go['insideAsserted']
    assert go['outsideNamespaces']['mnt'] != receipt['namespaces']['mnt']
    receipt.update(outsideAssertion=go, maskAsserted=True, maskAssertedAt=time.time())
    class CapHeader(ctypes.Structure):
        _fields_ = [('version', ctypes.c_uint32), ('pid', ctypes.c_int)]
    class CapData(ctypes.Structure):
        _fields_ = [('effective', ctypes.c_uint32), ('permitted', ctypes.c_uint32), ('inheritable', ctypes.c_uint32)]
    header, capabilities = CapHeader(0x20080522, 0), (CapData * 2)()
    if libc.capget(ctypes.byref(header), capabilities) != 0:
        raise OSError(ctypes.get_errno(), 'sampler capability read failed')
    for word in capabilities:
        word.inheritable = word.permitted
    if libc.capset(ctypes.byref(header), capabilities) != 0:
        raise OSError(ctypes.get_errno(), 'sampler capability inheritance failed')
    for number in range(64):
        if capabilities[number // 32].permitted & (1 << (number % 32)):
            if libc.prctl(47, 2, number, 0, 0) != 0:
                raise OSError(ctypes.get_errno(), 'sampler ambient capability failed')
    receipt['samplerCapabilitiesBeforeExec'] = {key:value.strip() for line in pathlib.Path('/proc/self/status').read_text().splitlines() for key, separator, value in [line.partition(':')] if key.startswith('Cap')}
    save('mask-proof.json', receipt)
    os.close(outfd)
    os.execvpe('python3', ['python3','-B',str(R/'init.py'),str(R),label,'python3','-B', str(R / 'monitor.py'), str(R), label, *SETPRIV_ARGS, 'python3','-B',str(R/'test_capabilities.py'),str(R),label,'python3','-B', str(R / 'workload.py'), str(R), label, *cmd], os.environ)
except BaseException as e:
    receipt.update(maskAsserted=False, error=type(e).__name__ + ': ' + str(e), failedAt=time.time())
    save('mask-failure.json', receipt)
    print(json.dumps(dict(label=label, maskFailure=receipt['error'])), flush=True)
    sys.exit(2)
