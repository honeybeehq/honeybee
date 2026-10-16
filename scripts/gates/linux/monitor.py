import os, sys, json, time, pathlib, subprocess, threading, errno, re, hashlib, shutil, collections,signal
from policy import error_verdict, RULE_VERSION, within,update_fd_prior,pid_observation
from home_guard import entry_guard
from thread_records import ThreadRecords
ROOT = pathlib.Path(sys.argv[1])
LABEL = sys.argv[2]
CMD = sys.argv[3:]
OUT = ROOT / 'receipts' / LABEL
ENTRY_GUARD = entry_guard(ROOT)
OUT.mkdir(parents=True, exist_ok=True)
(OUT / 'entry-guard-monitor.json').write_text(json.dumps(ENTRY_GUARD))
REAL_HIVE = pathlib.Path(json.loads((ROOT / 'config.json').read_text())['realHome']) / '.hive/v2'
HASH = hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()
CG = open('/proc/self/cgroup').read().strip().split('::', 1)[1]
assert '/hbl-' in CG
CGFILE = pathlib.Path('/sys/fs/cgroup' + CG + '/cgroup.procs')
MASK = json.loads((OUT / 'mask-proof.json').read_text())
assert MASK['maskAsserted'] and MASK['insideAsserted'] and MASK['outsideAssertion']['asserted']
LAB = {k: os.readlink('/proc/self/ns/' + k) for k in ('user', 'mnt', 'net','pid')}
ANCHOR = os.getpid()
births = {}
errors = []
forbidden = []
peers = []
previous = {}
parent_edges = {}
threads = ThreadRecords()
samples = 0
stopped = False
lock = threading.Lock()
fdlog = open(OUT / 'samples.jsonl', 'w', buffering=1)
cglog = open(OUT / 'cgroup-sightings.jsonl', 'w', buffering=1)
cgroupTime = 0
assert MASK['namespaces'] == LAB
CONFIG = json.loads((ROOT / 'config.json').read_text())
LSOF = shutil.which('lsof')
EXCLUSIONS = CONFIG['lsofExclusions']
lsoflog = open(OUT / 'lsof.jsonl', 'w', buffering=1)
lsoferr = open(OUT / 'lsof-stderr.log', 'w', buffering=1)
identity = dict(maskProof=MASK, cgroup=CG, anchor=ANCHOR, namespaces=LAB, uid_map=pathlib.Path('/proc/self/uid_map').read_text(), command=CMD, monitorSha256=HASH, lsof=LSOF or 'unavailable; proc+ss fallback', exclusions=EXCLUSIONS, socketLimitation='ss unix_diag is private-netns scoped; real daemon sockets are inaccessible and not visible; only own-namespace peers can be compared')
(OUT / 'identity.json').write_text(json.dumps(identity, indent=2))
(OUT / 'exclusions.json').write_text(json.dumps(EXCLUSIONS))
mountpoints = {line.split()[4] for line in pathlib.Path('/proc/self/mountinfo').read_text().splitlines()}
for path in EXCLUSIONS:
    assert path in mountpoints and (not within(path, '/home')) and ('.hive' not in pathlib.Path(path).parts)
    try:
        os.stat(path)
    except OSError as e:
        lsoferr.write(json.dumps(dict(excluded=path, errno=e.errno)) + '\n')
    else:
        raise RuntimeError('lsof exclusion is stat-able: ' + path)

def stat_fields(pid):
    try:
        raw = pathlib.Path(f'/proc/{pid}/stat').read_text()
        fields = raw[raw.rfind(')') + 2:].split()
        return dict(state=fields[0], ppid=int(fields[1]), starttime=fields[19])
    except OSError as exc:
        return dict(error=type(exc).__name__, errno=exc.errno)

def thread_stat(tgid, tid):
    try:
        raw = pathlib.Path(f'/proc/{tgid}/task/{tid}/stat').read_text()
        fields = raw[raw.rfind(')') + 2:].split()
        return dict(state=fields[0], ppid=int(fields[1]), starttime=fields[19])
    except OSError as exc:
        return dict(error=type(exc).__name__, errno=exc.errno)

def thread_error(tgid, tid, slot, number, message):
    errors.append(dict(pid=tid, tid=tid, tgid=tgid, threadScoped=True, fd=None, slot=slot, time=time.time(), sample=samples, errno=number, message=message, previousTarget=None, atErrorStat=thread_stat(tgid, tid)))

def checked_stat(pid, slot):
    value = stat_fields(pid)
    if 'error' in value:
        errors.append(dict(pid=pid, fd=None, slot=slot, time=time.time(), sample=samples, errno=value['errno'], error=value['error'], message='stat metadata read failed', atErrorStat=value))
    return value

def err(pid, slot, e):
    fd = slot[3:] if slot.startswith('fd/') else None
    errors.append(dict(pid=pid, fd=fd, slot=slot, time=time.time(), sample=samples, errno=e.errno, error=type(e).__name__, message=str(e), previousTarget=previous.get(pid, {}).get(fd), atErrorStat=checked_stat(pid, 'atErrorStat')))

def capture(pid):
    b = dict(pid=pid,ppid=parent_edges.get(pid), time=time.time(), firstSample=samples, cgroupSightingTime=None, procStat=checked_stat(pid, 'firstSightStat'))
    pending = []
    base = f'/proc/{pid}'
    for k, suffix in [('argv', 'cmdline'), ('status', 'status'), ('uid_map', 'uid_map'), ('user', 'ns/user'), ('mnt', 'ns/mnt'), ('net', 'ns/net'),('pidNamespace','ns/pid')]:
        try:
            v = os.readlink(base + '/' + suffix) if suffix.startswith('ns/') else pathlib.Path(base + '/' + suffix).read_text(errors='replace').replace('\x00', ' ')
            if k == 'status':
                v = {l.split(':', 1)[0]: l.split(':', 1)[1].strip() for l in v.splitlines() if l.split(':', 1)[0] in ('State', 'PPid', 'Uid', 'Gid', 'NoNewPrivs', 'NSpid','CoreDumping', 'Dumpable')}
                if 'PPid' in v:
                    b['ppid'] = int(v['PPid'])
            b[k] = v
        except OSError as e:
            b[k + '_error'] = dict(errno=e.errno, error=type(e).__name__)
            pending.append((suffix, e))
    births[pid] = b
    for slot, e in pending:
        err(pid, slot, e)

def chain(pid):
    path = []
    visited = set()
    while pid != 1:
        if pid in visited or pid not in births:
            return (False, path)
        visited.add(pid)
        path.append(pid)
        pid = births[pid].get('ppid')
    path.append(1)
    return (True, path)

def do_sample():
    global samples, previous, cgroupTime
    samples += 1
    now = time.time()
    try:
        host_pids = [int(p) for p in CGFILE.read_text().split()]
        cgroupTime = time.time()
        cglog.write(json.dumps(dict(time=cgroupTime, sample=samples, hostPids=host_pids)) + '\n')
    except OSError as e:
        err(ANCHOR, 'cgroup.procs', e)
        return
    pids=[];pending=[1];seen=set()
    while pending:
        pid=pending.pop()
        if pid in seen:continue
        seen.add(pid);pids.append(pid)
        try:
            tasks=list(pathlib.Path(f'/proc/{pid}/task').iterdir())
            for task in tasks:
                tid = int(task.name)
                current = thread_stat(pid, tid)
                key = (pid, tid)
                namespace = None
                if key not in threads.births:
                    try:
                        namespace = os.readlink(str(task / 'ns/pid'))
                    except OSError as error:
                        threads.observe(pid, tid, current, samples, time.time())
                        thread_error(pid, tid, 'thread/ns/pid', error.errno, str(error))
                threads.observe(pid, tid, current, samples, time.time(), namespace)
                if threads.current[key].get('identityChanged'):
                    thread_error(pid, tid, 'pid_reused', None, 'thread starttime changed after first sight')
                if 'errno' in current:
                    thread_error(pid, tid, 'thread/stat', current['errno'], 'thread stat metadata read failed')
                try:
                    children=[int(value) for value in (task/'children').read_text().split()]
                    for child in children:parent_edges[child]=pid
                    pending.extend(children)
                except OSError as e:thread_error(pid,tid,'children',e.errno,str(e))
        except OSError as e:err(pid,'task',e)
    for pid in pids:
        if pid not in births:
            capture(pid)
    for pid in pids:
        b = births[pid]
        if 'ownTreeAtFirstSight' not in b:
            ok, path = chain(pid)
            b.update(ownTreeAtFirstSight=ok, parentChain=path, scopePidsAtFirstSight=pids)
            b['nestedSandboxAtFirstSight'] = ok and b.get('user') is not None and (b.get('mnt') is not None) and (b['user'] != LAB['user']) and (b['mnt'] != LAB['mnt']) and (pid != ANCHOR)
    rows = []
    inodes = set()
    for pid in pids:
        base = f'/proc/{pid}'
        row = {'pid': pid, 'time': time.time(), 'fds': [], 'fdObservations': [], 'procStat': checked_stat(pid, 'sampleStat')}
        for k, suffix in [('cwd', 'cwd'), ('argv', 'cmdline')]:
            try:
                row[k] = os.readlink(base + '/' + suffix) if k == 'cwd' else pathlib.Path(base + '/' + suffix).read_text(errors='replace').replace('\x00', ' ')
            except OSError as e:
                err(pid, suffix, e)
        try:
            with os.scandir(base + '/fd') as scan:
                for entry in scan:
                    try:
                        target = os.readlink(base + '/fd/' + entry.name)
                    except OSError as e:
                        err(pid, 'fd/' + entry.name, e)
                        continue
                    row['fds'].append([entry.name, target])
                    row['fdObservations'].append(dict(fd=entry.name, target=target, priorTarget=previous.get(pid, {}).get(entry.name)))
                    m = re.fullmatch('socket:\\[(\\d+)\\]', target)
                    if m:
                        inodes.add(m[1])
        except OSError as e:
            err(pid, 'fd', e)
            row['fdReadError'] = True
        for kind, target in [('cwd', row.get('cwd', ''))] + row['fds']:
            if within(target, str(REAL_HIVE.parent)):
                forbidden.append(dict(pid=pid, slot=kind, target=target, time=time.time()))
        first = births[pid].get('procStat', {})
        current = row['procStat']
        if first.get('starttime') and current.get('starttime') and (first['starttime'] != current['starttime']) or (births[pid].get('seenZombie') and current.get('state') not in (None, 'Z')):
            errors.append(dict(pid=pid, slot='pid_reused', time=time.time(), sample=samples, errno=None, atErrorStat=first, nextSample=dict(state='pid_present', procStat=current)))
        births[pid]['seenZombie'] = births[pid].get('seenZombie', False) or current.get('state') == 'Z'
        rows.append(row)
    if LSOF and pids:
        exclusions = []
        for path in EXCLUSIONS:
            exclusions.extend(['-e', path])
        for pid in pids:
            lsargs = [LSOF, '-nP', *exclusions, '-a', '-p', str(pid), '-Fpn']
            atstat = stat_fields(pid)
            ls = subprocess.run(lsargs, capture_output=True, text=True)
            lsoflog.write(json.dumps(dict(time=time.time(), sample=samples, pid=pid, argv=lsargs, exit=ls.returncode, stdout=ls.stdout, stderr=ls.stderr)) + '\n')
            lsoferr.write(ls.stderr)
            if ls.stderr or ls.returncode:
                errors.append(dict(pid=pid, slot='lsof', time=time.time(), sample=samples, errno=None, error='lsof', message='unexpected stderr or exit', atErrorStat=atstat))
            for line in ls.stdout.splitlines():
                if line.startswith('n') and within(line[1:], str(REAL_HIVE.parent)):
                    forbidden.append(dict(pid=pid, slot='lsof', target=line[1:], time=time.time()))
    lines = []
    ownlines = []
    ss_stderr = ''
    try:
        ss = subprocess.run(['ss', '-x', '-n', '-a'], capture_output=True, text=True)
        ss_stderr = ss.stderr
        if ss.returncode or ss.stderr:
            errors.append(dict(pid=ANCHOR, slot='ss', time=time.time(), sample=samples, error='ss', errno=None, message=f'exit={ss.returncode};stderr={ss.stderr}'))
        lines = [l for l in ss.stdout.splitlines() if str(REAL_HIVE / 'hived.sock') in l]
        ownlines = [l for l in ss.stdout.splitlines() if inodes.intersection(l.split())]
        for line in lines:
            cols = line.split()
            if len(cols) > 4 and cols[4] == str(REAL_HIVE / 'hived.sock') and inodes.intersection(cols):
                peers.append(dict(time=time.time(), line=line))
    except OSError as e:
        err(ANCHOR, 'ss', e)
    for e in list(errors):
        if e['sample'] >= samples or 'nextSample' in e:
            continue
        pid = e['pid']
        if e.get('threadScoped'):
            e['nextSample'] = threads.next_observation(e['tgid'], e['tid'], samples, time.time(), thread_stat)
            continue
        row = next((r for r in rows if r['pid'] == pid), None)
        obs = dict(time=time.time(), sample=samples, **pid_observation(pid in pids, row.get('procStat') if row else None))
        if obs['state'] == 'pid_gone':
            pass
        elif pid not in pids:
            obs['state'] = 'pid_gone' if not os.path.exists(f'/proc/{pid}') else 'pid_outside_scope'
            if obs['state'] == 'pid_outside_scope':
                obs['procStat'] = checked_stat(pid, 'nextSampleStat')
                obs['statEnoent'] = obs['procStat'].get('errno') == errno.ENOENT
                if obs['statEnoent']:
                    obs['state'] = 'pid_gone'
        elif row is None:
            obs['state'] = 'pid_unreadable'
        elif e.get('fd') is not None and (not row.get('fdReadError')):
            target = dict(row['fds']).get(e['fd'])
            obs.update(target=target, state='fd_absent' if target is None else 'fd_changed' if e.get('previousTarget') is not None and target != e['previousTarget'] else 'fd_present')
        else:
            obs['state'] = 'pid_present'
        e['nextSample'] = obs
    for row in rows:
        previous[row['pid']]=update_fd_prior(previous.get(row['pid'],{}),dict(row['fds']),not row.get('fdReadError'))
    for pid,birth in births.items():
        if birth['firstSample']<samples and 'nextBirthSample' not in birth:
            row=next((item for item in rows if item['pid']==pid),None)
            birth['nextBirthSample']=dict(time=time.time(),sample=samples,**pid_observation(pid in pids,row['procStat'] if row else None,os.path.exists(f'/proc/{pid}') if row is None else None),ppidSource='process-tree edges from /proc/<own parent>/task/<own tid>/children; status PPid when readable')
    for key,birth in threads.births.items():
        if birth['firstSample'] < samples and 'nextBirthSample' not in birth:
            threads.next_observation(*key, samples, time.time(), thread_stat)
    threads.scope(births)
    fdlog.write(json.dumps(dict(time=now, sample=samples, scopePids=pids, pids=rows, threads=[observation for observation in threads.current.values() if observation['sample']==samples],realSocketLines=lines, ownSocketLines=ownlines, ssStderr=ss_stderr)) + '\n')
    (OUT / 'first-sight.json').write_text(json.dumps(list(births.values()), indent=2))
    (OUT / 'errors.json').write_text(json.dumps(errors, indent=2))

def sample():
    with lock:
        do_sample()

def loop():
    try:
        while not stopped:
            sample()
            time.sleep(0.1)
    except BaseException as e:
        errors.append(dict(pid=ANCHOR, slot='sampler_gap', time=time.time(), sample=samples, errno=None, error=type(e).__name__, message=str(e)))
sample()
log = open(OUT / 'stdout.log', 'w')
process = subprocess.Popen(CMD, stdout=log, stderr=subprocess.STDOUT)
thread = threading.Thread(target=loop)
thread.start()
rc = process.wait()
sample()
time.sleep(0.15)
sample()
cleanup=[]
for pid,birth in list(births.items()):
    if pid in (1,ANCHOR):continue
    current=stat_fields(pid)
    if current.get('state') in (None,'Z'):continue
    errors.append(dict(pid=pid,slot='lingering_pid',time=time.time(),sample=samples,errno=None,atErrorStat=current))
    if current.get('starttime')!=birth.get('procStat',{}).get('starttime') or not birth.get('ownTreeAtFirstSight'):continue
    try:
        descriptor=os.pidfd_open(pid)
        if stat_fields(pid).get('starttime')!=current['starttime']:
            os.close(descriptor);continue
        signal.pidfd_send_signal(descriptor,signal.SIGTERM)
        cleanup.append(dict(pid=pid,starttime=current['starttime'],signal='SIGTERM',time=time.time()))
        time.sleep(.1)
        if stat_fields(pid).get('state') not in (None,'Z'):
            signal.pidfd_send_signal(descriptor,signal.SIGKILL)
            cleanup.append(dict(pid=pid,starttime=current['starttime'],signal='SIGKILL',time=time.time()))
        os.close(descriptor)
    except ProcessLookupError:pass
sample()
stopped = True
thread.join()
final_observations=[]
for error in errors:
    if 'nextSample' in error:continue
    if error.get('threadScoped'):
        error['nextSample'] = threads.next_observation(error['tgid'], error['tid'], samples+1, time.time(), thread_stat)
        final_observations.append(dict(pid=error['pid'],tid=error['tid'],tgid=error['tgid'],errorTime=error['time'],observation=error['nextSample']))
        continue
    current=stat_fields(error['pid'])
    gone=current.get('errno')==errno.ENOENT and not os.path.exists(f"/proc/{error['pid']}")
    observation=dict(time=time.time(),sample=samples+1,procStat=current,state='pid_gone' if gone else 'pid_present',observationOnly=True)
    error['nextSample']=observation
    final_observations.append(dict(pid=error['pid'],errorTime=error['time'],observation=observation))
(OUT/'final-observations.json').write_text(json.dumps(final_observations,indent=2))
log.close()
fdlog.close()
cglog.close()
lsoflog.close()
lsoferr.close()
for e in errors:
    e['scopeProof'] = threads.births.get((e['tgid'],e['tid']),{}) if e.get('threadScoped') else births.get(e['pid'], {})
    if e.get('threadScoped'):
        e['exitIdentitySource'] = 'atErrorStat' if e.get('atErrorStat',{}).get('starttime') else 'thread birth'
    e['verdict'] = error_verdict(e, e['scopeProof'], MASK['maskAsserted'], str(REAL_HIVE.parent))
counts = {k: sum((e['verdict'] == k for e in errors)) for k in ('scope_proven_exiting', 'prior_target_outside_hive', 'masked_unknown_prior_WARN', 'FAIL')}
byerrno = collections.defaultdict(collections.Counter)
for e in errors:
    byerrno[str(e.get('errno'))][e['verdict']] += 1
test_input=json.loads((OUT/'test-input.json').read_text()) if (OUT/'test-input.json').exists() else {}
test_input['testFailure']=bool(re.search(r'^# fail [1-9]\d*$',(OUT/'stdout.log').read_text(),re.M))
result = dict(ruleVersion=RULE_VERSION, label=LABEL, command=CMD, exit=rc, testEvidence=test_input,cleanup=cleanup,monitorSha256=HASH, ownPids=sorted(births), errors=errors, errorCounts=counts, errnoCounts={k: dict(v) for k, v in byerrno.items()}, forbidden=forbidden, peers=peers, fullyClean=not (counts['FAIL'] or forbidden or peers), births=list(births.values()),threadBirths=list(threads.births.values()),samplingLimitation='A failed children-file read can leave that sample tree walk incomplete; processes born and gone between samples may be unseen.')
(OUT / 'result.json').write_text(json.dumps(result, indent=2))
print(json.dumps(dict(label=LABEL, exit=rc, ownPids=len(births), errorCounts=counts, forbidden=len(forbidden), peers=len(peers), fullyClean=result['fullyClean'])), flush=True)
sys.exit(rc)
