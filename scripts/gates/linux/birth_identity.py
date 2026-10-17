import errno


def birth_identity(proc_stat, status, namespaces, confirmation):
    first = dict(proc_stat)
    raw_status = dict(status)
    raw_namespaces = dict(namespaces)
    result = dict(procStat=first, ppid=first.get('ppid'), rawStatus=raw_status, rawNamespaces=raw_namespaces, confirmationStat=dict(confirmation))
    same = bool(first.get('starttime')) and first.get('starttime') == confirmation.get('starttime')
    try:
        nspid = [int(value) for value in status.get('NSpid', '').split()]
    except ValueError:
        nspid = []
    valid = same and status.get('State', '').split()[:1] not in (['X'], ['x']) and bool(nspid) and all(value > 0 for value in nspid)
    result['supplementalIdentityAccepted'] = valid
    if valid:
        result.update(status=raw_status, NSpid=nspid, namespaces=raw_namespaces)
    else:
        result.update(status={}, NSpid=[], namespaces={}, identityErrno=confirmation.get('errno') or errno.ESRCH)
    return result


def parent_chain(pid, births):
    path, visited = [], set()
    while pid != 1:
        if pid in visited or pid not in births:
            return False, path
        visited.add(pid)
        path.append(pid)
        pid = births[pid].get('ppid')
    return True, path + [1]
