import time
from policy import pid_observation

STAT_RETRY_LIMIT = 3
STAT_RETRY_DELAY = .01


def parse_stat(raw):
    try:
        fields = raw[raw.rfind(')') + 2:].split()
        return dict(state=fields[0], ppid=int(fields[1]), starttime=fields[19])
    except (IndexError, ValueError):
        return {}


def resolve_stat_observation(observation, read_stat, exists=None, wait=time.sleep, clock=time.time):
    if observation.get('state') != 'pid_unobserved' or observation.get('statRetryExhausted'):
        return dict(observation)
    attempts = [dict(time=observation.get('time', clock()), procStat=observation.get('procStat'), state='pid_unobserved')]
    result = dict(observation)
    for unused in range(STAT_RETRY_LIMIT):
        wait(STAT_RETRY_DELAY)
        try:
            current = read_stat()
        except OSError as error:
            current = dict(errno=error.errno, error=type(error).__name__)
        present = exists() if exists is not None else None
        result.update(time=clock(), **pid_observation(observation.get('treeListed', False), current, present))
        attempts.append(dict(time=result['time'], procStat=current, state=result['state'], procExistsObserved=present))
        if result['state'] != 'pid_unobserved':
            break
    result.update(statObservationAttempts=attempts, statRetryLimit=STAT_RETRY_LIMIT, statRetryExhausted=result['state'] == 'pid_unobserved')
    return result
