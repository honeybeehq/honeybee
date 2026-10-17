class Roles:
    def __init__(self, root_pid, entries, instrumented):
        self.root_pid = root_pid
        self.entries = entries
        self.instrumented = instrumented
        self.identities = {}
        self.internal = set()

    def observe(self, birth, entry):
        pid, parent = int(birth[0]), int(birth[1])
        role = self.entries.get(entry)
        if role is None:
            raise ValueError('Node entry outside exact reviewed role allowlist')
        if pid in self.identities:
            if self.identities[pid] != (tuple(birth), role, entry):
                raise ValueError('Node identity or role changed')
            return role
        if role == 'test-runner':
            if pid != self.root_pid:
                root = self.identities.get(self.root_pid)
                if self.instrumented or parent != self.root_pid or root is None or root[1] != 'test-runner' or root[2] != entry or self.internal:
                    raise ValueError('unapproved internal test-runner child')
                self.internal.add(pid)
        elif role == 'runner-host-main':
            expected_parent = self.root_pid if self.instrumented else next(iter(self.internal), None)
            if parent != expected_parent or self.identities.get(parent, (None, None))[1] != 'test-runner':
                raise ValueError('runner host has wrong parent role')
        elif role == 'reader':
            if self.identities.get(parent, (None, None))[1] != 'runner-host-main':
                raise ValueError('reader has wrong parent role')
        else:
            raise ValueError('unapproved Node entry role')
        self.identities[pid] = (tuple(birth), role, entry)
        return role

    def finish(self):
        roles = [row[1] for row in self.identities.values()]
        if len(self.internal) != (0 if self.instrumented else 1) or roles.count('reader') != 1 or roles.count('runner-host-main') != 1 or roles.count('test-runner') != (1 if self.instrumented else 2):
            raise ValueError('missing or duplicate Node entry role observation')
        return {'ok': True, 'internalTestRunnerChildren': len(self.internal), 'identities': [{'birth': list(value[0]), 'role': value[1], 'entry': value[2]} for value in self.identities.values()]}
