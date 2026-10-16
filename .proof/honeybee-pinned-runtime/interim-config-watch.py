import datetime, hashlib, hmac, json, os, pathlib, re, secrets, subprocess, sys, time
mode, root_arg, real_arg, *extra = sys.argv[1:]
root, real = pathlib.Path(root_arg), pathlib.Path(real_arg)
receipt = root / 'interim-config.json'
if mode == 'coverage':
    state = json.loads(receipt.read_text())
    needed = bool(state['configChanges']) or not state['logicalEqual']
    ok = not needed or (state['lsofClean'] and state['attributed'])
    print('INTERIM_ATTRIBUTION_NEEDED',json.dumps({'needed':needed,'accepted':ok,'lsofClean':state['lsofClean'],'coverageErrors':state['errors']}))
    raise SystemExit(0 if ok else 1)
if mode == 'verdict':
    def normalized(path):
        section = ''
        result = []
        for line in pathlib.Path(path).read_text().splitlines():
            if line.startswith('#'): section = line
            result.append('<attributed config.json inode>' if section == '# real hive data dir (inode name)' and re.fullmatch(r'\d+ config\.json', line) else line)
        return result
    state = json.loads(receipt.read_text())
    ok = normalized(extra[0]) == normalized(extra[1]) and state['lsofClean'] and state['configChanges'] and state['attributed']
    print('INTERIM_CONFIG_ONLY_VERDICT', json.dumps({'accepted':bool(ok),'rule':'config.patch within +/-2s and clean scoped lab-pid lsof; remove after d9182a65 fleet deployment'}))
    raise SystemExit(0 if ok else 1)
gate_pid = int(extra[0]); own_pid = os.getpid()
assert root.is_dir() and str(root).startswith(str(real / '.cache/scg') + '/')
salt = secrets.token_bytes(32)
def value_hash(value):
    return hmac.new(salt, json.dumps(value, sort_keys=True, separators=(',',':'), ensure_ascii=False).encode(), hashlib.sha256).hexdigest()
def config_state():
    p = real / '.hive/v2/config.json'; st = p.stat(); value = json.loads(p.read_bytes())
    return {'inode':st.st_ino,'mtimeNs':st.st_mtime_ns,'ctimeNs':st.st_ctime_ns,'canonicalSaltedHash':value_hash(value),'keySaltedHashes':{k:value_hash(v) for k,v in value.items()}}
before = config_state(); previous = before; changes = []; seen = set(); checked = set(); exited = set(); errors = []; hits = []; samples = 0; terminal_states = {}
host_log = real / '.hive/v2/hived.log'; log_stat = host_log.stat(); log_offset = log_stat.st_size
(root / 'logs').mkdir(exist_ok=True)
(root / 'interim-ready').touch()
with (root / 'logs/lsof-samples.jsonl').open('w') as journal:
    while not (root / 'interim-stop').exists():
        try:
            listing = subprocess.check_output(['ps','-axo','pid=,ppid=,command='], text=True)
            processes = {}
            for line in listing.splitlines():
                fields = line.strip().split(None,2)
                if len(fields)==3: processes[int(fields[0])] = (int(fields[1]), fields[2])
            excluded = {own_pid}; selected = {gate_pid}
            for _ in range(30):
                grown = {p for p,(parent,_) in processes.items() if parent in excluded}
                if grown <= excluded: break
                excluded |= grown
            for p,(_,argv) in processes.items():
                if str(root) in argv and '\\012' not in argv: selected.add(p)
            for _ in range(30):
                grown = {p for p,(parent,_) in processes.items() if parent in selected and p not in excluded}
                if grown <= selected: break
                selected |= grown
            selected = (selected & set(processes)) - excluded
            if selected:
                seen |= selected
                result = subprocess.run(['/usr/sbin/lsof','-nP','-Fpn','-a','-p',','.join(map(str,sorted(selected)))], capture_output=True, text=True, timeout=10)
                if result.returncode not in (0,1): errors.append('lsof_exit_'+str(result.returncode))
                sampled = set(); current_pid = None; matched = []
                for line in result.stdout.splitlines():
                    if line.startswith('p') and line[1:].isdigit(): current_pid=int(line[1:]); sampled.add(current_pid)
                    elif line.startswith('n'+str(real / '.hive/v2')) and (line[1:]==str(real / '.hive/v2') or line[1:].startswith(str(real / '.hive/v2')+'/')): matched.append({'pid':current_pid,'path':line[1:]})
                for pid in selected - sampled:
                    state = subprocess.run(['ps','-p',str(pid),'-o','stat='],capture_output=True,text=True).stdout.strip()
                    if not state or state.startswith('Z'):
                        exited.add(pid);terminal_states[pid]=state or 'gone';continue
                    retry = subprocess.run(['/usr/sbin/lsof','-nP','-Fpn','-a','-p',str(pid)],capture_output=True,text=True,timeout=10)
                    if retry.returncode not in (0,1): errors.append('lsof_retry_exit_'+str(retry.returncode))
                    inspected = False
                    for field in retry.stdout.splitlines():
                        if field == 'p'+str(pid): sampled.add(pid);inspected=True
                        elif field.startswith('n'+str(real / '.hive/v2')) and (field[1:]==str(real / '.hive/v2') or field[1:].startswith(str(real / '.hive/v2')+'/')): matched.append({'pid':pid,'path':field[1:]})
                    if not inspected:
                        state = subprocess.run(['ps','-p',str(pid),'-o','stat='],capture_output=True,text=True).stdout.strip()
                        if not state or state.startswith('Z'): exited.add(pid);terminal_states[pid]=state or 'gone'
                        else: errors.append('live_pid_unsampled_'+str(pid))
                checked |= sampled; hits.extend(matched)
                journal.write(json.dumps({'at':time.time(),'pids':sorted(selected),'sampled':sorted(sampled),'realHiveOpen':matched})+'\n');journal.flush();samples+=1
            current = config_state()
            if (current['inode'],current['mtimeNs'],current['canonicalSaltedHash']) != (previous['inode'],previous['mtimeNs'],previous['canonicalSaltedHash']): changes.append(current);previous=current
        except Exception as error: errors.append(type(error).__name__)
        time.sleep(.1)
after = config_state()
if (after['inode'],after['mtimeNs'],after['canonicalSaltedHash']) != (previous['inode'],previous['mtimeNs'],previous['canonicalSaltedHash']): changes.append(after)
ops = []
if host_log.stat().st_ino != log_stat.st_ino or host_log.stat().st_size < log_offset: errors.append('host_log_rotated')
else:
    with host_log.open('rb') as f:
        f.seek(log_offset);offset=log_offset
        for line in f:
            start=offset;offset+=len(line)
            try: record=json.loads(line)
            except (ValueError,UnicodeDecodeError):continue
            if isinstance(record.get('op'),str) and record['op'].startswith('config.patch') and isinstance(record.get('ts'),(int,float)):
                ops.append({'byteStart':start,'byteEndExclusive':offset,'op':'config.patch','timeUtc':datetime.datetime.fromtimestamp(record['ts']/1000,datetime.timezone.utc).isoformat(),'ts':record['ts']})
clean = bool(samples and checked) and not errors and not hits
state={'rule':'INTERIM only ~/.hive/v2/config.json; config.patch +/-2s and clean lab-pid lsof; remove after d9182a65 fleet deployment','before':before,'after':after,'logicalEqual':before['canonicalSaltedHash']==after['canonicalSaltedHash'],'configChanges':changes,'configPatchOps':ops,'attributed':all(any(abs(c['mtimeNs']/1e9-o['ts']/1000)<=2 for o in ops) for c in changes),'lsofClean':clean,'samples':samples,'seenPids':sorted(seen),'sampledPids':sorted(checked),'exitedBeforeSample':sorted(exited),'terminalStates':terminal_states,'errors':errors,'realHiveOpen':hits}
receipt.write_text(json.dumps(state,sort_keys=True)+'\n');os.chmod(receipt,0o600)
print('SCOPED_LSOF_CONFIG_RECEIPT',json.dumps(state,sort_keys=True))
raise SystemExit(0 if clean else 1)
