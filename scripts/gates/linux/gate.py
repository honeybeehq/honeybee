import argparse
import collections
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import platform
import re
import shutil
import stat
import subprocess
import sys
import time
from filesystem import proc_receipt_valid
from git_boundary import snapshot as git_boundary_snapshot, receipt_valid as git_boundary_receipt_valid
import uuid
import threading
import pwd
from home_guard import entry_guard, pull_destination
from birth_identity import birth_identity
from test_capabilities import SETPRIV_ARGS, capability_receipt_valid
from stat_observation import parse_stat, resolve_stat_observation, STAT_RETRY_LIMIT, STAT_RETRY_DELAY
from error_summary import error_summary_valid, error_summary_totals

from policy import RULE_VERSION, closing_verdict, differences, preexec_verdict, flake_verdict, within,namespace_pid,error_verdict,mapping_coverage,mask_probe_failed,pid_observation


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def read(path):
    return json.loads(path.read_text())


def append(path, value):
    with path.open('a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        stream.write(json.dumps(value) + '\n')
        stream.flush()
        os.fsync(stream.fileno())


def record_attempt(root, value):
    append(root / 'attempt-ledger.jsonl', value)
    append(root.parent / 'attempt-ledger.jsonl', dict(runRoot=str(root), **value))


def snapshot(home):
    entries, errors = {}, []
    def take(path):
        try:
            item = os.lstat(path)
            kind = 'directory' if stat.S_ISDIR(item.st_mode) else 'symlink' if stat.S_ISLNK(item.st_mode) else 'socket' if stat.S_ISSOCK(item.st_mode) else 'file'
            entries[str(path)] = dict(inode=item.st_ino, size=item.st_size, mtime_ns=item.st_mtime_ns, mode=item.st_mode, uid=item.st_uid, gid=item.st_gid, type=kind)
        except OSError as error:
            errors.append(dict(path=str(path), errno=error.errno))
    for folder in (home, home / '.hive', home / '.hive/v2'):
        take(folder)
        try:
            for name in os.listdir(folder):
                take(folder / name)
        except OSError as error:
            errors.append(dict(path=str(folder), errno=error.errno))
    known = str(home / '.hive/v2/hived.sock')
    return dict(time=time.time(), entries=entries, errors=errors, valid=bool(entries and known in entries and not errors), known=known)


def fake_env(home, search_path):
    env = dict(PATH=search_path, HOME=str(home), TMPDIR=str(home / 't'), LANG='C.UTF-8', HIVE_REAL_HOME=str(home))
    for key, folder in dict(XDG_CONFIG_HOME='config', XDG_DATA_HOME='data', XDG_CACHE_HOME='cache', XDG_STATE_HOME='state', XDG_RUNTIME_DIR='runtime', CLAUDE_CONFIG_DIR='claude', CODEX_HOME='codex', GROK_HOME='grok', GEMINI_CLI_HOME='gemini', OPENCODE_CONFIG_DIR='opencode', KIMI_CODE_HOME='kimi', CURSOR_CONFIG_DIR='cursor').items():
        env[key] = str(home / folder)
    return env


def tmp_snapshot():
    entries, errors = {}, []
    for path in [pathlib.Path('/tmp'), *pathlib.Path('/tmp').iterdir()]:
        try:
            meta = path.lstat()
            entries[str(path)] = dict(inode=meta.st_ino, device=meta.st_dev, size=meta.st_size, mtime_ns=meta.st_mtime_ns, mode=meta.st_mode, uid=meta.st_uid, gid=meta.st_gid)
        except OSError as error:
            errors.append(dict(path=str(path), errno=error.errno))
    return dict(entries=entries, errors=errors, valid=bool(entries) and not errors, metadataOnly=True, directEntriesOnly=True)


def tmp_audit(root, out):
    before, after = read(out / 'host-tmp-before.json'), read(out / 'host-tmp-after.json')
    changes = differences(before['entries'], after['entries'])
    probes = []
    for name in ('filesystem-proof.json', 'filesystem-workload.json', 'filesystem-tests.json'):
        if not (out / name).exists():
            continue
        probe = read(out / name)['probes']['privateTmpWrite']
        assert re.fullmatch('hbl-private-[a-f0-9]{32}', probe['name']) and within(probe['source'], str(root))
        probes.append(dict(name=probe['name'], hostPathAbsent=not os.path.lexists('/tmp/' + probe['name']), physicalFileUnderRunRoot=(pathlib.Path(probe['source']) / probe['name']).is_file()))
    result = dict(asserted=before['valid'] and after['valid'] and not changes and bool(probes) and all(item['hostPathAbsent'] and item['physicalFileUnderRunRoot'] for item in probes), changes=changes, privateProbeFiles=probes, metadataOnly=True, directEntriesOnly=True)
    save(out / 'host-tmp-audit.json', result)
    return result


def lab_home(root, index):
    return pathlib.Path(root) / 'h' / format(index, 'x')


def socket_path_lengths(paths):
    return [dict(path=path, encodedBytes=len(os.fsencode(path)), sunPathBytes=108, fits=len(os.fsencode(path)) < 108) for path in sorted(set(paths))]


def inventory(out):
    pids, daemons, socket_pids, bees, ids, sockets, touched = (set() for _ in range(7))
    samples = out / 'samples.jsonl'
    if samples.exists():
        for line in samples.open():
            record = json.loads(line)
            for socket_line in record.get('ownSocketLines', []):
                sockets.update(value for value in socket_line.split() if value.startswith('/'))
            for row in record['pids']:
                pid = row['pid']
                pids.add(pid)
                argv = row.get('argv', '')
                targets = [target for _, target in row['fds']]
                touched.update(targets)
                touched.add(row.get('cwd', ''))
                touched.update(re.findall(r'/[^\s]+', argv))
                text = argv + ' ' + row.get('cwd', '') + ' ' + ' '.join(targets)
                bees.update(re.findall(r'/runners/([^/\s]+?)\.\d+\.json', text))
                ids.update(re.findall(r'\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b', text))
                sockets.update(re.findall(r'/[^\s]*\.sock\b', text))
                if '/v2/daemon/src/bin.ts' in argv or '/daemon/main.js' in argv:
                    daemons.add(pid)
                if any(target.startswith('socket:[') for target in targets):
                    socket_pids.add(pid)
    lsof = out / 'lsof.jsonl'
    if lsof.exists():
        for line in lsof.open():
            touched.update(value[1:] for value in json.loads(line).get('stdout', '').splitlines() if value.startswith('n'))
    host_map = read(out / 'host-pid-map.json') if (out / 'host-pid-map.json').exists() else []
    host_pids = set()
    sightings = out / 'host-cgroup-sightings.jsonl'
    if sightings.exists():
        for line in sightings.open():
            host_pids.update(json.loads(line)['pids'])
    result = dict(pids=sorted(host_pids), namespacePids=sorted(pids), hostPidMap=host_map, daemonNamespacePids=sorted(daemons), daemonPids=sorted(item['hostPid'] for item in host_map if item.get('namespacePid') in daemons),socketOwningNamespacePids=sorted(socket_pids), socketOwningPids=sorted(item['hostPid'] for item in host_map if item.get('namespacePid') in socket_pids), runnerBeeIds=sorted(bees), uuidCandidates=sorted(ids), socketPaths=sorted(sockets), touched=sorted(touched))
    diagnostics = out / 'stdout.log'
    diagnostic_paths = re.findall(r'/[^\s\'\"]+\.sock\b', diagnostics.read_text(errors='replace')) if diagnostics.exists() else []
    result['socketPathLengths'] = socket_path_lengths(sockets | set(diagnostic_paths))
    save(out / 'lab-inventory.json', result)
    return result


def log_audit(home, out, before, after, inv, root):
    path = str(home / '.hive/v2/hived.log')
    old, new = before['entries'].get(path), after['entries'].get(path)
    if not old or not new or old['inode'] != new['inode'] or new['size'] < old['size']:
        result = dict(valid=False, realHiveRead=True, reason='log missing, replaced or shrunk')
        save(out / 'real-log-audit.json', result)
        return result
    start, end = old['size'], new['size']
    groups = dict(runRoot=[str(root)], throwawayUUIDs=inv['uuidCandidates'], beeIds=[value for value in inv['runnerBeeIds'] if value != 'bee'], socketPaths=inv['socketPaths'], labPids=[str(pid) for pid in inv['pids']])
    patterns = {key: re.compile('|'.join(re.escape(value) if key in ('runRoot', 'socketPaths') else r'(?<![\w-])' + re.escape(value) + r'(?![\w-])' for value in values)) if values else None for key, values in groups.items()}
    counts = dict.fromkeys(groups, 0)
    types, config_times, generic = collections.Counter(), [], 0
    with open(path, 'rb') as stream:
        assert os.fstat(stream.fileno()).st_ino == old['inode']
        stream.seek(start)
        remaining, pending = end - start, b''
        while remaining:
            block = stream.read(min(65536, remaining))
            if not block:
                raise RuntimeError('short appended-log read')
            remaining -= len(block)
            lines = (pending + block).split(b'\n')
            pending = lines.pop()
            if not remaining and pending:
                lines.append(pending)
            for raw in lines:
                line = raw.decode(errors='replace')
                generic += bool(re.search(r'\bbee\b', line))
                for key, pattern in patterns.items():
                    counts[key] += bool(pattern and pattern.search(line))
                kind, timestamp = 'text', None
                try:
                    data = json.loads(line)
                    level = data.get('level')
                    kind = 'json:' + str(level if level in ('trace', 'debug', 'info', 'warn', 'error', 'fatal', 10, 20, 30, 40, 50, 60) else 'unknown')
                    timestamp = data.get('time', data.get('ts', data.get('timestamp')))
                except (ValueError, AttributeError):
                    pass
                types[kind] += 1
                if 'config.patch' in line:
                    try:
                        stamp = float(timestamp) if isinstance(timestamp, (float, int)) else datetime.datetime.fromisoformat(timestamp.replace('Z', '+00:00')).timestamp()
                        config_times.append(stamp / 1000 if stamp > 1e11 else stamp)
                    except (TypeError, ValueError, AttributeError):
                        pass
    result = dict(valid=True, realHiveRead=True, rangeStart=start, rangeEnd=end, bytes=end-start, matchLineCounts=counts, genericBeeLineCount=generic, lineTypes=dict(types), configPatch=[dict(op='config.patch', time=stamp) for stamp in config_times])
    save(out / 'real-log-audit.json', result)
    return result


def outside_assertion(home, out, before):
    after = snapshot(home)
    save(out / 'outside-preexec-snapshot.json', after)
    inside, ready = read(out / 'mask-inside.json'), read(out / 'mask-ready.json')
    changes = differences(before['entries'], after['entries'])
    for change in changes:
        change['verdict'], change['category'] = preexec_verdict(change, str(home), inside['namedRealExceptions'])
    ns = {key: os.readlink('/proc/self/ns/' + key) for key in ('user', 'mnt', 'net')}
    asserted = before['valid'] and after['valid'] and inside['insideAsserted'] and ns['mnt'] != inside['namespaces']['mnt'] and all(item['verdict'] == 'WARN' for item in changes)
    code = str(home / 'Code')
    code_before, code_after = before['entries'].get(code), after['entries'].get(code)
    code_unchanged = code_before == code_after
    asserted = asserted and code_unchanged
    result = dict(repoRootSelfTests=dict(path=code, before=code_before, after=code_after, unchanged=code_unchanged, metadataOnly=True), asserted=asserted, insideAsserted=inside['insideAsserted'], nonce=ready['nonce'], at=time.time(), windowMs=(after['time']-before['time'])*1000, changes=changes, outsideNamespaces=ns, fdHistoryCondition='provisional until closing sampler adjudication')
    save(out / 'outside-preexec.json', result)
    save(out / ('GO.json' if asserted else 'ABORT.json'), result)


def host_stat(pid):
    try:
        return parse_stat(pathlib.Path(f'/proc/{pid}/stat').read_text())
    except OSError as error:
        return dict(errno=error.errno, error=type(error).__name__)


def host_observation(pid, tree_listed, stamp):
    observation = dict(time=stamp, **pid_observation(tree_listed, host_stat(pid), os.path.exists(f'/proc/{pid}')))
    return resolve_stat_observation(observation, lambda: host_stat(pid), lambda: os.path.exists(f'/proc/{pid}'))


def map_host_pids(group, out, stopped):
    births = {}
    with (out / 'host-cgroup-sightings.jsonl').open('w', buffering=1) as sightings:
        while not stopped.is_set():
            try:
                pids = [int(value) for value in group.read_text().split()]
                stamp = time.time()
                sightings.write(json.dumps(dict(time=stamp, pids=pids))+'\n')
                changed=False
                for known in births.values():
                    if 'readError' in known and 'nextSample' not in known['readError']:
                        changed=True
                        error = known['readError']
                        error['nextSample'] = host_observation(known['hostPid'], known['hostPid'] in pids, stamp)
                        error['verdict']=error_verdict(error,dict(cgroupSightingTime=known['scopeSightingAt']),False,'')
                for pid in pids:
                    if pid in births:
                        continue
                    changed=True
                    item = dict(hostPid=pid, scopeSightingAt=stamp, capturedAt=time.time())
                    try:
                        status = pathlib.Path('/proc') / str(pid) / 'status'
                        def proc_stat():
                            value = host_stat(pid)
                            if not value.get('state'):
                                raise OSError(value.get('errno') or 11, 'host stat unavailable or empty')
                            return value
                        first = proc_stat()
                        item['procStat'] = first
                        fields = dict(line.split(':', 1) for line in status.read_text().splitlines() if ':' in line)
                        namespaces = {key: os.readlink(status.parent / 'ns' / key) for key in ('user', 'mnt', 'net', 'pid')}
                        identity = birth_identity(first, fields, namespaces, proc_stat())
                        item.update(identity)
                        if 'identityErrno' in identity:
                            raise OSError(identity['identityErrno'], 'supplemental birth identity unavailable or changed')
                        item['namespacePid'] = namespace_pid(item['NSpid'])
                        item['starttime'] = first['starttime']
                    except (OSError, KeyError) as error:
                        item['error'] = type(error).__name__
                        item['readError']=dict(pid=pid,slot='host-pid-map',errno=getattr(error,'errno',None),time=time.time(),scopeSightingAt=stamp,atErrorStat=item.get('procStat',{}))
                    births[pid] = item
                if changed:
                    save(out / 'host-pid-map.json', list(births.values()))
            except OSError as error:
                removed = error.errno == 2 and not group.exists()
                append(out / 'host-mapper-events.jsonl', dict(time=time.time(), errno=error.errno, event='scope_removed' if removed else 'FAIL'))
                if removed:
                    break
            stopped.wait(.02)
    for item in births.values():
        if 'readError' in item and 'nextSample' not in item['readError']:
            item['readError']['nextSample'] = host_observation(item['hostPid'], False, time.time())
            item['readError']['verdict']=error_verdict(item['readError'],dict(cgroupSightingTime=item['scopeSightingAt']),False,'')
    save(out / 'host-pid-map.json',list(births.values()))


def adjudicate(home, root, out, physical, before, after):
    raw = read(out / 'result.json') if (out / 'result.json').exists() else {}
    diagnostic_reads = read(out / 'diagnostic-stat-reads.json') if (out / 'diagnostic-stat-reads.json').exists() else None
    observation_retries = read(out / 'stat-observation-retries.json') if (out / 'stat-observation-retries.json').exists() else None
    summary_accepted = error_summary_valid(raw.get('errorSummary'), raw.get('errors'), diagnostic_reads, observation_retries)
    guard_names = ['mask','init','monitor','workload']
    if pathlib.Path(physical['command'][-1]).name == 'policy_test.py':
        guard_names.append('tests')
    guard_records = {name: read(out / ('entry-guard-'+name+'.json')) if (out / ('entry-guard-'+name+'.json')).exists() else None for name in guard_names}
    entry_guards = bool(read(root/'config.json').get('entryGuard',{}).get('allowed')) and all(record and record.get('allowed') and record.get('beforeFirstWrite') and record.get('ruleVersion') == RULE_VERSION for record in guard_records.values())
    capabilities = read(out / 'capability-drop.json') if (out / 'capability-drop.json').exists() else None
    entry_guards = entry_guards and summary_accepted and capability_receipt_valid(capabilities, read(root / 'config.json'), physical['command'], physical['label'])
    save(out/'entry-guards.json',dict(asserted=entry_guards,records=guard_records))
    inv = inventory(out)
    audit = log_audit(home, out, before, after, inv, root)
    mask = read(out / 'mask-proof.json') if (out / 'mask-proof.json').exists() else {}
    code_probe = mask.get('repoRootSelfTests', {})
    code = str(home / 'Code')
    code_outside = dict(path=code, before=before['entries'].get(code), after=after['entries'].get(code), metadataOnly=True)
    code_outside['unchanged'] = code_outside['before'] == code_outside['after']
    save(out / 'repo-root-outside.json', code_outside)
    valid_mask = code_outside['unchanged'] and mask.get('maskAsserted', False) and code_probe.get('asserted') is True and code_probe.get('empty') is True and code_probe.get('refused') is True and code_probe.get('errno') in (13, 30)
    filesystem = read(out / 'filesystem-workload.json') if (out / 'filesystem-workload.json').exists() else {}
    fs_probes = filesystem.get('probes', {})
    valid_mask = valid_mask and proc_receipt_valid(filesystem, root, mask.get('namespaces', {}).get('pid'))
    valid_mask = valid_mask and filesystem.get('state', {}).get('asserted', False) and fs_probes.get('asserted', False) and fs_probes.get('privilegeChecks') is True and {item.get('operation') for item in fs_probes.get('privilegeProbes', [])} == {'remount-proc-rw','remount-root-rw','umount-tmp','unshare-mount'} and all(item.get('refused') and item.get('childExit') == 0 for item in fs_probes['privilegeProbes'])
    temporary = tmp_audit(root, out)
    valid_mask = valid_mask and temporary['asserted']
    fixture_path = root / 'git-boundary' / physical['label'] / 'fixture.json'
    boundary_path = out / 'git-boundary-tests.json'
    boundary_valid = False
    if fixture_path.exists() and boundary_path.exists():
        fixture = read(fixture_path)
        outside_after = git_boundary_snapshot(fixture['backingTarget'])
        save(out / 'git-boundary-outside.json', dict(metadataAndHashesOnly=True, entries=outside_after, unchanged=outside_after == fixture['before']))
        baseline = read(out / 'git-boundary-baseline.json')['entries']
        boundary_valid = baseline == fixture['before'] and git_boundary_receipt_valid(read(boundary_path), fixture, outside_after)
    valid_mask = valid_mask and boundary_valid
    coverage = [dict(pid=birth['pid'],outcome=mapping_coverage(birth,inv['hostPidMap'],raw.get('errors',[]))) for birth in raw.get('births',[])]
    save(out/'mapping-coverage.json',coverage)
    missing_mappings = [item['pid'] for item in coverage if item['outcome']=='FAIL']
    host_errors = [item['readError'] for item in inv['hostPidMap'] if 'readError' in item]
    mapper_events = [json.loads(line) for line in (out / 'host-mapper-events.jsonl').open()] if (out / 'host-mapper-events.jsonl').exists() else []
    clean = bool(raw.get('fullyClean')) and not missing_mappings and all(item.get('verdict') == 'scope_proven_exiting' for item in host_errors) and not any(item['event'] == 'FAIL' for item in mapper_events)
    pre = read(out / 'outside-preexec.json') if (out / 'outside-preexec.json').exists() else dict(asserted=False, changes=[])
    for change in pre['changes']:
        if change['path'] in inv['touched']:
            change['verdict'] = 'FAIL'
    pre_clean = pre['asserted'] and all(item['verdict'] != 'FAIL' for item in pre['changes'])
    eligible = entry_guards and valid_mask and pre_clean and clean and audit['valid'] and not any(audit.get('matchLineCounts', {}).values())
    changes = differences(before['entries'], after['entries'])
    config_times = [item['time'] for item in audit.get('configPatch', [])]
    for change in changes:
        change['verdict'] = closing_verdict(change, str(home), eligible, clean, config_times, inv['touched'], mask.get('namedRealExceptions', []))
    guard_accepted = physical['workloadStarted'] and eligible and before['valid'] and after['valid'] and all(item['verdict'] != 'FAIL' for item in changes)
    ok = physical.get('scopeExit') == 0 and guard_accepted
    warnings = sum(item['verdict'] == 'WARN' for item in changes) + sum(item['verdict'] == 'WARN' for item in pre['changes']) + raw.get('errorCounts', {}).get('masked_unknown_prior_WARN', 0)
    result = dict(ruleVersion=RULE_VERSION, outcome=('WARN' if warnings else 'PASS') if ok else 'FAIL', guardAccepted=guard_accepted, testCapabilities=capabilities, testExit=raw.get('exit'), testEvidence=raw.get('testEvidence'),missingHostPidMappings=missing_mappings,hostMapErrors=host_errors,preExec=pre, closingChanges=changes, errorCounts=raw.get('errorCounts'), errnoCounts=raw.get('errnoCounts'), samplerClean=clean, logAudit=audit, maskAsserted=valid_mask, citedAttempt=physical['attemptId'] if ok else None, physical=physical)
    result.update(errorSummary=raw.get('errorSummary'), errorSummaryAccepted=summary_accepted)
    save(out / 'adjudication.json', result)
    return result


def run_step(config, step):
    root, home = pathlib.Path(config['runRoot']), pathlib.Path(config['realHome'])
    label = step['label']
    out = root / 'receipts' / label
    out.mkdir(parents=True)
    fake = lab_home(root, step['homeIndex'])
    env = fake_env(fake, config['path'])
    for directory in set(env.values()):
        if directory.startswith(str(fake)):
            pathlib.Path(directory).mkdir(parents=True, exist_ok=True)
    boundary_setup = subprocess.run(['unshare', '-rn', 'python3', '-B', str(root / 'git_boundary.py'), str(root), label], env=env, capture_output=True)
    if boundary_setup.returncode:
        raise RuntimeError('git boundary controller fixture setup failed')
    fixture = read(root / 'git-boundary' / label / 'fixture.json')
    baseline = git_boundary_snapshot(fixture['backingTarget'])
    assert baseline == fixture['before']
    save(out / 'git-boundary-baseline.json', dict(entries=baseline, metadataAndHashesOnly=True))
    before = snapshot(home)
    save(out / 'before.json', before)
    save(out / 'host-tmp-before.json', tmp_snapshot())
    attempt = dict(attemptId=str(uuid.uuid4()), label=label, version=step['version'], command=step['command'], rulesVersion=RULE_VERSION, start=time.time(), scopeExit=None, workloadStarted=False, receipt=str(out))
    record_attempt(root, dict(event='started', **attempt))
    if before['valid']:
        scope = 'hbl-' + root.name + '-' + label
        launcher = dict(PATH=config['path'], HOME=str(fake), TMPDIR=env['TMPDIR'], LANG='C.UTF-8', XDG_RUNTIME_DIR='/run/user/' + str(os.getuid()), DBUS_SESSION_BUS_ADDRESS='unix:path=/run/user/' + str(os.getuid()) + '/bus')
        args = ['systemd-run', '--user', '--scope', '--quiet', '--unit=' + scope, '--', 'env', '-i'] + [key + '=' + value for key, value in env.items()] + ['unshare', '-rmnpf', '--mount-proc','python3', '-B', str(root / 'mask.py'), str(root), label, *step['command']]
        save(out / 'launch.json', dict(argv=args, environment=env, scope=scope, envException='HIVE_REAL_HOME equals fake HOME; all other HIVE_*/APIARY_* absent'))
        with (out / 'launcher.log').open('w') as log:
            process = subprocess.Popen(args, cwd=root / step['version'] if (root / step['version']).exists() else root, env=launcher, stdout=log, stderr=subprocess.STDOUT)
            mapper_stop = threading.Event()
            mapper = None
            for unused in range(100):
                unit = subprocess.run(['systemctl', '--user', 'show', scope+'.scope', '--property=ControlGroup', '--value'], env=launcher, capture_output=True, text=True)
                group = pathlib.Path('/sys/fs/cgroup'+unit.stdout.strip()) / 'cgroup.procs'
                if unit.returncode == 0 and unit.stdout.strip().startswith('/') and group.is_file():
                    mapper = threading.Thread(target=map_host_pids, args=(group, out, mapper_stop))
                    mapper.start()
                    break
                if process.poll() is not None:
                    break
                time.sleep(.01)
            deadline = time.monotonic() + 30
            while process.poll() is None and not (out / 'mask-ready.json').exists() and not (out / 'mask-failure.json').exists() and time.monotonic() < deadline:
                time.sleep(.05)
            if (out / 'mask-ready.json').exists():
                try:
                    if mapper is None:
                        raise RuntimeError('own scope host-pid mapper unavailable')
                    outside_assertion(home, out, before)
                except Exception as error:
                    save(out / 'ABORT.json', dict(reason='outside assertion error', error=type(error).__name__))
            elif process.poll() is None:
                save(out / 'ABORT.json', dict(reason='mask assertion timeout'))
            attempt['scopeExit'] = process.wait()
            mapper_stop.set()
            if mapper:
                mapper.join()
    attempt.update(end=time.time(), workloadStarted=(out / 'workload-started.json').exists())
    save(out / 'physical-attempt.json', attempt)
    test_guard = fake/'entry-guard-tests.json'
    if test_guard.exists():
        shutil.copyfile(test_guard,out/'entry-guard-tests.json')
    filesystem_test = fake / 'filesystem-tests.json'
    if filesystem_test.exists():
        shutil.copyfile(filesystem_test, out / 'filesystem-tests.json')
    save(out / 'host-tmp-after.json', tmp_snapshot())
    after = snapshot(home)
    save(out / 'after.json', after)
    try:
        result = adjudicate(home, root, out, attempt, before, after)
    except Exception as error:
        result = dict(ruleVersion=RULE_VERSION, outcome='FAIL', citedAttempt=None, error=type(error).__name__ + ': ' + str(error), physical=attempt)
        save(out / 'adjudication.json', result)
    record_attempt(root, dict(event='finished', attemptId=attempt['attemptId'], rulesVersion=RULE_VERSION, outcome=result['outcome'], citedAttempt=result['citedAttempt'], label=label, receipt=str(out), preExecChanges=result.get('preExec', {}).get('changes', [])))
    print(json.dumps(dict(step=label, outcome=result['outcome'], receipt=str(out), samplerErrors=result.get('errorSummary'))), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description='Guarded Linux gate, rules v29. One physical attempt per planned step; no retries.', epilog='Steps: check,v2:check,npm-test,v2:test,v2:daemon,v2:driver,v2:driver2,v2:harness,build,gate-tests,test:<repo-relative.test.ts>,flake:<repo-relative.test.ts>:N. N>=3; daemon-shutdown N>=10. Preparation, offline npm ci and peercred prebuild are automatic. Receipts: REAL_HOME/.cache/hbl/<run>. Approved satellites only. Start with env -i PATH=... HOME=<fake under ~/.cache> TMPDIR=<fake> LANG=C.UTF-8 run.sh --real-home REAL_HOME --candidate SHA --base SHA --steps LIST --npm-cache FILE --npm-cache-sha256 SHA256. No other HIVE_*/APIARY_* variables are accepted.')
    parser.add_argument('--real-home', required=True)
    parser.add_argument('--candidate', required=True)
    parser.add_argument('--base', required=True)
    parser.add_argument('--steps', required=True)
    parser.add_argument('--npm-cache', required=True)
    parser.add_argument('--npm-cache-sha256', required=True)
    parser.add_argument('--lsof-exclude', action='append', default=[])
    args = parser.parse_args()
    controller_guard = entry_guard()
    if any(key.startswith(('HIVE_', 'APIARY_')) for key in os.environ):
        parser.error('controller must start under env -i with no HIVE_*/APIARY_* variables')
    if pathlib.Path(os.environ['HOME']).absolute() == pathlib.Path(args.real_home).absolute():
        parser.error('controller HOME must be fake; pass the real home explicitly')
    passwd_home = pathlib.Path(pwd.getpwuid(os.getuid()).pw_dir).resolve()
    if pathlib.Path(args.real_home).resolve() != passwd_home:
        parser.error('--real-home must match the passwd home')
    if platform.system() != 'Linux' or not re.match(r'^(netcup-|.*metal-)', platform.node()):
        parser.error('satellite Linux host required')
    if any(within(path, '/home') or '.hive' in pathlib.Path(path).parts or not path.startswith('/') for path in args.lsof_exclude):
        parser.error('lsof exclusions must be exact unrelated absolute mountpoints outside /home and .hive')
    repo = pathlib.Path(__file__).resolve().parents[3]
    gate_sha = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
    if subprocess.check_output(['git', '-C', str(repo), 'status', '--porcelain', '--', 'scripts/gates/linux'], text=True).strip():
        parser.error('gate source must match its committed revision')
    shas = {key: subprocess.check_output(['git', '-C', str(repo), 'rev-parse', '--verify', value + '^{commit}'], text=True).strip() for key, value in dict(candidate=args.candidate, base=args.base).items()}
    plan, flakes = [], []
    for version in shas:
        plan.append(dict(label=version + '-prepare', version=version, command=['@prepare']))
        plan.append(dict(label=version + '-ci', version=version, command=['npm', 'ci', '--offline', '--no-audit', '--no-fund']))
        plan.append(dict(label=version + '-prebuild', version=version, command=['node', 'scripts/build-peercred.mjs']))
    for index, token in enumerate(args.steps.split(',')):
        if token.startswith('flake:'):
            _, test, count = token.split(':')
            count = int(count)
            if count < (10 if pathlib.Path(test).name == 'daemon-shutdown.test.ts' else 3):
                parser.error('flake repetition count below rules minimum')
            flakes.append(dict(test=test, count=count, index=index))
            versions = [(version, n) for version in shas for n in range(count)]
        else:
            test = token[5:] if token.startswith('test:') else None
            versions = [('candidate', 0)]
        if test and (pathlib.Path(test).is_absolute() or '..' in pathlib.Path(test).parts or not test.endswith(('.test.ts', '.test.mjs', '_test.py'))):
            parser.error('test path must be a repository relative test file')
        for version, n in versions:
            if token == 'gate-tests':
                command = ['python3', '-B', str(pathlib.Path(__file__).parent / 'policy_test.py')]
            elif test:
                command = ['node', 'scripts/with-fixture-warden.mjs', 'node', '--test', '--test-reporter=tap',test]
            elif token == 'npm-test':
                command = ['npm', 'test']
            elif token in ('check', 'v2:check', 'v2:test', 'v2:daemon', 'v2:driver', 'v2:driver2', 'v2:harness', 'build'):
                command = ['npm', 'run', token]
            else:
                parser.error('unknown step: ' + token)
            plan.append(dict(label=version + '-step' + str(index) + '-' + str(n), version=version, command=command, token=token))
    for version in shas:
        plan.append(dict(label=version + '-verify', version=version, command=['@verify']))
    home = pathlib.Path(args.real_home).absolute()
    parent = home / '.cache/hbl'
    if len(os.fsencode(parent)) >= 40:
        parser.error('run-root prefix must be shorter than 40 bytes')
    parent.mkdir(parents=True, exist_ok=True)
    root = parent / uuid.uuid4().hex[:8]
    root.mkdir()
    config = dict(runRoot=str(root), realHome=str(home), gateSha=gate_sha,controllerEnvironmentKeys=sorted(os.environ), path=os.environ['PATH'], shas=shas, rulesVersion=RULE_VERSION, lsofExclusions=args.lsof_exclude, cacheSource=str(pathlib.Path(args.npm_cache).absolute()), cacheSha256=args.npm_cache_sha256, provenance='findings/hb-turn-quiet-netcup2-script-bundle.json v1', flakePlan=flakes)
    config['toolHashes'] = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in pathlib.Path(__file__).parent.iterdir() if path.is_file()}
    config['testCapabilities'] = dict(setprivArgv=SETPRIV_ARGS, assertedSets=['CapEff','CapPrm','CapBnd','CapInh','CapAmb'], expectedValue=0, noNewPrivs=1, appliesTo='every workload command', appliedAfter='mask assertions and locked-mount negative probes')
    config['statObservationRetries'] = dict(limit=STAT_RETRY_LIMIT, delaySeconds=STAT_RETRY_DELAY, unresolved='FAIL', explicitEnoent='pid_gone')
    config['ledger'] = str(parent / 'attempt-ledger.jsonl')
    config['entryGuard'] = controller_guard
    config['passwdHome'] = str(passwd_home)
    config['createdAt'] = time.time()
    config['createdUtc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    config['socketPathLimitBytes'] = 108
    for index, step in enumerate(plan):
        step['homeIndex'] = index
        tmpdir = fake_env(lab_home(root, index), config['path'])['TMPDIR']
        if len(os.fsencode(tmpdir)) > 48:
            parser.error('lab TMPDIR exceeds the 48-byte gate budget')
    config['maxTmpdirBytes'] = max(len(os.fsencode(fake_env(lab_home(root, index), config['path'])['TMPDIR'])) for index in range(len(plan)))
    save(root / 'config.json', config)
    save(root / 'entry-guard-controller.json', controller_guard)
    save(root / 'plan.json', plan)
    for path in pathlib.Path(__file__).parent.glob('*.py'):
        shutil.copyfile(path, root / path.name)
    for step in plan:
        if step.get('token') == 'gate-tests':
            step['command'] = ['python3', '-B', str(root / 'policy_test.py')]
    save(root / 'plan.json', plan)
    bootstrap = root / 'bootstrap'
    bootstrap.mkdir()
    env = fake_env(bootstrap, config['path'])
    pull = root / 'pull'
    pull.mkdir()
    scripts = set(config['toolHashes'])
    config['sourceArchives'] = {version: str(pull_destination(root, version+'-source.tar', scripts)) for version in shas}
    config['cacheArchive'] = str(pull_destination(root, 'npm-cache.tar.gz', scripts))
    config['pullDirectory'] = str(pull)
    save(root/'config.json',config)
    for version, sha in shas.items():
        with pathlib.Path(config['sourceArchives'][version]).open('xb') as archive:
            subprocess.run(['git', '-C', str(repo), 'archive', sha], env=env, stdout=archive, check=True)
    cache = pathlib.Path(args.npm_cache)
    digest = hashlib.sha256(cache.read_bytes()).hexdigest()
    if digest != args.npm_cache_sha256:
        failure = dict(ruleVersion=RULE_VERSION, outcome='FAIL', reason='npm cache SHA256 mismatch', source=str(cache), actualSha256=digest, expectedSha256=args.npm_cache_sha256, workloadStarted=False)
        save(root / 'receipt.json', failure)
        record_attempt(root, dict(event='setup-failed', **failure))
        raise RuntimeError('npm cache SHA256 mismatch')
    with cache.open('rb') as source, pathlib.Path(config['cacheArchive']).open('xb') as destination:
        shutil.copyfileobj(source,destination)
    save(root / 'cache-transfer.json', dict(source=str(cache), sha256=digest, bytes=cache.stat().st_size))
    print(json.dumps(dict(runRoot=str(root), candidate=shas['candidate'], base=shas['base'], planned=len(plan))), flush=True)
    results = []
    abort_reason = None
    for step in plan:
        result = run_step(config, step)
        results.append(result)
        probe_path = pathlib.Path(result['physical']['receipt'])/'locked-mount-probes.json'
        inside_path = probe_path.parent / 'mask-inside.json'
        inside = read(inside_path) if inside_path.exists() else None
        before = read(probe_path.parent / 'before.json')
        if mask_probe_failed(read(probe_path) if probe_path.exists() else None, inside, home, root, before):
            abort_reason = 'locked mount negative probe failed; invocation aborted before any further step'
            record_attempt(root,dict(event='invocation-aborted',rulesVersion=RULE_VERSION,attemptId=result['physical']['attemptId'],reason=abort_reason,at=time.time()))
            break
        if step['label'].endswith(('-prepare', '-ci', '-prebuild')) and result['outcome'] == 'FAIL':
            break
    flake_results = []
    for flake in flakes:
        rows = [item for item in results if '-step' + str(flake['index']) + '-' in item['physical']['label']]
        flake_results.append(dict(**flake, **flake_verdict(rows, flake['count'])))
    pre_warnings = sum(any(change['verdict'] == 'WARN' and change.get('category') == 'WAL/SHM mtime-only' for change in item.get('preExec', {}).get('changes', [])) for item in results)
    summary = dict(config=config, planned=len(plan), completed=len(results), overall='PASS' if len(results) == len(plan) and all(item['outcome'] != 'FAIL' for item in results) else 'FAIL', abortReason=abort_reason,preExecWalShmWarnAttempts=pre_warnings, physicalAttempts=len(results), preExecWalShmWarnRate=pre_warnings / len(results), flakeResults=flake_results, steps=[dict(label=item['physical']['label'], outcome=item['outcome'], citedAttempt=item['citedAttempt']) for item in results])
    summary['samplerErrors'] = error_summary_totals([item.get('errorSummary') if item.get('errorSummaryAccepted') else None for item in results])
    save(root / 'receipt.json', summary)
    print(json.dumps(summary), flush=True)
    return 0 if summary['overall'] == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
