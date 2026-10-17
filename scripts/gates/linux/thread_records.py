from policy import pid_observation
from stat_observation import resolve_stat_observation


class ThreadRecords:
    def __init__(self):
        self.births = {}
        self.current = {}
        self.observation_retries = []

    def observe(self, tgid, tid, proc_stat, sample, at, namespace=None):
        key = (tgid, tid)
        if key not in self.births:
            self.births[key] = dict(pid=tid, tid=tid, tgid=tgid, firstSample=sample, time=at, procStat=dict(proc_stat), pidNamespace=namespace, taskMembership=dict(ownerPid=tgid, tid=tid, firstSightAt=at, sample=sample))
        observation = dict(time=at, sample=sample, tgid=tgid, tid=tid, **pid_observation(True, proc_stat))
        birth_start = self.births[key]['procStat'].get('starttime')
        observation['identityChanged'] = bool(birth_start and proc_stat.get('starttime') and birth_start != proc_stat['starttime'])
        self.current[key] = observation
        if observation['state'] != 'pid_unobserved':
            self.record_next(key, observation)
        return self.births[key]

    def record_next(self, key, observation):
        birth = self.births[key]
        if observation['sample'] > birth['firstSample'] and 'nextBirthSample' not in birth:
            birth['nextBirthSample'] = dict(observation)

    def next_observation(self, tgid, tid, sample, at, read_stat):
        key = (tgid, tid)
        observation = self.current.get(key)
        if observation is None or observation['sample'] != sample:
            observation = dict(time=at, sample=sample, tgid=tgid, tid=tid, **pid_observation(False, read_stat(tgid, tid)))
        had_attempts = 'statObservationAttempts' in observation
        observation = resolve_stat_observation(observation, lambda: read_stat(tgid, tid))
        self.current[key] = observation
        if not had_attempts and 'statObservationAttempts' in observation:
            self.observation_retries.append(dict(observation))
        self.record_next(key, observation)
        return dict(observation)

    def scope(self, process_births):
        for birth in self.births.values():
            owner = process_births.get(birth['tgid'], {})
            birth['ownTreeAtFirstSight'] = bool(owner.get('ownTreeAtFirstSight'))
            birth['ownerPpidChain'] = owner.get('parentChain', [])
            birth['ownerProcessStarttime'] = owner.get('procStat', {}).get('starttime')
            birth['scopeProofKind'] = 'recorded task membership of a process with a recorded ppid chain'
