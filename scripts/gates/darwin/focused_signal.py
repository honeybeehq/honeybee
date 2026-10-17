def authorize(requester, target, retained, approved, current, group_members=None):
    if not isinstance(approved, dict):
        raise ValueError('approved launch births must be exact identities')
    if type(requester) is not int or type(target) is not int or target in (0, -1):
        raise ValueError('non-descendant signal target')
    by_pid = {}
    for row in retained:
        pid = int(row[0])
        if pid in by_pid and by_pid[pid] != row:
            raise ValueError('ambiguous retained process birth')
        by_pid[pid] = row

    def descendant(pid):
        seen = set()
        while pid in by_pid and pid not in seen:
            seen.add(pid)
            row = by_pid[pid]
            if current.get(pid) != row:
                return False
            parent = int(row[1])
            if parent == requester:
                return approved.get(pid) == row
            pid = parent
        return False

    leader = abs(target)
    if current.get(requester) != by_pid.get(requester) or requester not in by_pid or approved.get(leader) != by_pid.get(leader) or leader not in approved or not descendant(leader):
        raise ValueError('non-descendant signal target')
    if target < 0:
        if not group_members or leader not in group_members or any(not descendant(pid) for pid in group_members):
            raise ValueError('unverified or foreign process-group member')
    return True
