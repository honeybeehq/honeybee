import errno
import pathlib

RULE_VERSION = 29


def within(target, root):
    return target == root or target.startswith(root + '/')


def pid_transition(before, observation):
    if observation.get('state') == 'pid_unobserved':
        return 'unproven'
    after = observation.get('procStat') or {}
    same = before.get('starttime') is not None and before.get('starttime') == after.get('starttime')
    reused = before.get('state') == 'Z' and after.get('state') not in (None, 'Z')
    reused |= bool(before.get('starttime') and after.get('starttime') and not same)
    if reused:
        return 'reused'
    exiting = observation.get('state') == 'pid_gone' or after.get('errno') == errno.ENOENT
    exiting |= before.get('state') == 'Z' and after.get('state') == 'Z' and same
    exiting |= before.get('state') not in (None, '', 'Z') and after.get('state') == 'Z' and same
    return 'exiting' if exiting else 'unproven'


def pid_observation(tree_listed, proc_stat, proc_exists=None):
    stat_enoent = (proc_stat or {}).get('errno') == errno.ENOENT
    gone = stat_enoent or proc_exists is False
    observed = bool((proc_stat or {}).get('state') and (proc_stat or {}).get('starttime'))
    state = 'pid_gone' if gone else 'pid_unobserved' if not observed else 'pid_present' if tree_listed else 'pid_outside_scope'
    return dict(treeListed=tree_listed, procStat=proc_stat, statEnoent=stat_enoent, procExistsObserved=proc_exists, state=state)


def error_verdict(error, birth, masked, real_hive):
    observation = error.get('nextSample') or {}
    after = observation.get('procStat') or {}
    before = error.get('atErrorStat') or {}
    if not before.get('starttime'):
        before = birth.get('procStat') or {}
    transition = pid_transition(before, observation)
    scoped = birth.get('cgroupSightingTime') is not None or birth.get('ownTreeAtFirstSight', False)
    if birth.get('procStat', {}).get('starttime') and after.get('starttime') and birth['procStat']['starttime'] != after['starttime']:
        return 'FAIL'
    if error.get('threadScoped'):
        membership = birth.get('taskMembership', {})
        if birth.get('tid') != error.get('tid') or birth.get('tgid') != error.get('tgid') or membership.get('tid') != error.get('tid') or membership.get('ownerPid') != error.get('tgid'):
            return 'FAIL'
        if observation.get('tid') != error.get('tid') or observation.get('tgid') != error.get('tgid') or observation.get('sample', -1) <= error.get('sample', -1):
            return 'FAIL'
        born_start = birth.get('procStat', {}).get('starttime')
        if born_start and before.get('starttime') and born_start != before['starttime']:
            return 'FAIL'
        if after.get('state') == 'Z' and (not born_start or after.get('starttime') != born_start):
            return 'FAIL'
    if not scoped or transition == 'reused' or error.get('slot') in ('ss', 'sampler_gap', 'cgroup.procs', 'pid_reused', 'lingering_pid'):
        return 'FAIL'
    if transition == 'exiting':
        return 'scope_proven_exiting'
    if error.get('threadScoped'):
        return 'FAIL'
    live = after.get('state') not in (None, 'Z') and observation.get('state') != 'pid_gone'
    if live and error.get('errno') == errno.ENOENT and error.get('fd') is not None:
        prior = error.get('previousTarget')
        if prior is not None and not within(prior, real_hive):
            return 'prior_target_outside_hive'
        if prior is None and masked:
            return 'masked_unknown_prior_WARN'
    return 'FAIL'


def wal_mtime_only(path, old, new, real_home):
    allowed = {str(pathlib.Path(real_home) / '.hive/v2' / name) for name in ('core.sqlite3-wal', 'core.sqlite3-shm')}
    if path not in allowed or not old or not new:
        return False
    return old != new and all(old.get(key) == new.get(key) for key in ('inode', 'size', 'uid', 'gid', 'mode', 'type')) and old.keys() == new.keys() and all(old[key] == new[key] for key in old if key != 'mtime_ns')


def differences(before, after):
    return [dict(path=path, before=before.get(path), after=after.get(path)) for path in sorted(before.keys() | after.keys()) if before.get(path) != after.get(path)]


def preexec_verdict(change, real_home, named=(), touched=()):
    path, old, new = change['path'], change['before'], change['after']
    hive = str(pathlib.Path(real_home) / '.hive')
    if not old or not new or path in touched or any(within(path, name) for name in named):
        return 'FAIL', 'other'
    if pathlib.Path(path).parent == pathlib.Path(real_home) or path == hive + '/v2/core.sqlite3':
        return 'FAIL', 'other'
    identity = all(old.get(key) == new.get(key) for key in ('inode', 'uid', 'gid', 'mode', 'type'))
    if wal_mtime_only(path, old, new, real_home):
        return 'WARN', 'WAL/SHM mtime-only'
    if identity and path == hive + '/v2/auto-title.json' and old.keys() == new.keys() and all(old[key] == new[key] for key in old if key != 'mtime_ns') and old != new:
        return 'WARN', '~/.hive/v2/auto-title.json mtime-only'
    if identity and path == hive + '/v2/hived.log' and new['size'] > old['size']:
        return 'WARN', 'hived.log growth'
    direct = str(pathlib.Path(path).parent) in (hive, hive + '/v2')
    if identity and direct and old['type'] == 'directory' and all(old[key] == new[key] for key in old if key != 'mtime_ns'):
        return 'WARN', '~/.hive direct-entry directory mtime-only'
    return 'FAIL', 'other'


def flake_verdict(rows, count):
    versions = ('candidate', 'base')
    by_version = {version: [row for row in rows if row['physical']['version'] == version] for version in versions}
    valid = all(len(items) == count and all(item.get('guardAccepted') and item.get('testExit') is not None and item.get('testEvidence', {}).get('exists') and item.get('testEvidence', {}).get('testFailure') for item in items if item.get('testExit') not in (None, 0)) and all(item.get('guardAccepted') and item.get('testEvidence', {}).get('exists') and item.get('testExit') is not None for item in items) for items in by_version.values())
    failures = {version: sum(item.get('testExit') not in (None, 0) for item in items) for version, items in by_version.items()}
    return dict(failures=failures, classification='flake evidence' if valid and all(failures.values()) else 'no flake attribution', attempts=[item['physical']['attemptId'] for item in rows])


def update_fd_prior(prior, observed, complete):
    if complete:
        return dict(observed)
    return dict(prior, **observed)


def namespace_pid(nspid):
    return nspid[1] if len(nspid) > 1 else None


def mapping_coverage(birth, mappings, errors):
    start = birth.get('procStat', {}).get('starttime')
    if start and any(item.get('namespacePid') == birth['pid'] and item.get('starttime') == start for item in mappings):
        return 'mapped'
    scoped = birth.get('ownTreeAtFirstSight') or birth.get('cgroupSightingTime') is not None
    if scoped and pid_transition(birth.get('procStat') or {}, birth.get('nextBirthSample') or {}) == 'exiting':
        return 'mapping unavailable: exited before host capture'
    return 'FAIL'


def probe_failed(result):
    return result is not None and (result.get('childExit') != 0 or len(result.get('probes', [])) != 3 or any(not item.get('expectedFailure') for item in result.get('probes', [])))


def closing_verdict(change, real_home, masked_eligible, clean, config_times, touched, named):
    path, old, new = change['path'], change['before'], change['after']
    hive = str(pathlib.Path(real_home) / '.hive')
    core = hive + '/v2/core.sqlite3'
    if path == core and (not old or not new or old['inode'] != new['inode'] or new['size'] < old['size']):
        return 'FAIL'
    if path == hive + '/v2/config.json':
        changed_at = (new or old)['mtime_ns'] / 1e9
        return 'WARN' if clean and any(abs(t - changed_at) <= 2 for t in config_times) else 'FAIL'
    dotdir = pathlib.Path(path).parent == pathlib.Path(real_home) and pathlib.Path(path).name.startswith('.') and (old or new).get('type') in ('directory', 'symlink')
    unnamed = not any(within(name, path) for name in named)
    if dotdir and unnamed and any(within(target, path) for target in touched):
        return 'FAIL'
    if masked_eligible and (within(path, hive) or dotdir):
        return 'WARN'
    if clean and wal_mtime_only(path, old, new, real_home) and path not in touched:
        return 'WARN'
    same_identity = old and new and all(old[k] == new[k] for k in ('inode', 'uid', 'gid', 'mode', 'type'))
    if clean and same_identity:
        if path in (hive + '/v2/core.sqlite3-wal', hive + '/v2/hived.log', core) and new['size'] >= old['size']:
            return 'WARN'
    if clean and dotdir and unnamed and not any(within(target, path) for target in touched):
        return 'WARN'
    return 'FAIL'
