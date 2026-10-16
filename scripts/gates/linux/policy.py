import errno
import pathlib

RULE_VERSION = 27


def within(target, root):
    return target == root or target.startswith(root + '/')


def error_verdict(error, birth, masked, real_hive):
    observation = error.get('nextSample') or {}
    before = error.get('atErrorStat') or {}
    after = observation.get('procStat') or {}
    scoped = birth.get('cgroupSightingTime') is not None or birth.get('ownTreeAtFirstSight', False)
    same = before.get('starttime') is not None and before.get('starttime') == after.get('starttime')
    reused = before.get('state') == 'Z' and after.get('state') not in (None, 'Z')
    reused |= bool(before.get('starttime') and after.get('starttime') and not same)
    if not scoped or reused or error.get('slot') in ('ss', 'sampler_gap', 'cgroup.procs', 'pid_reused', 'lingering_pid'):
        return 'FAIL'
    exiting = observation.get('state') == 'pid_gone'
    exiting |= before.get('state') == 'Z' and after.get('state') == 'Z' and same
    exiting |= before.get('state') == 'R' and after.get('state') == 'Z' and same
    if exiting:
        return 'scope_proven_exiting'
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
    scoped = birth.get('ownTreeAtFirstSight') or start and birth.get('pidNamespace')
    if scoped and birth.get('nextBirthSample',{}).get('state')=='pid_gone':
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
