import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import time

root = pathlib.Path.cwd()
name = sys.argv[1]
if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', name):
    raise ValueError('run name must be a simple slug')
out = root / '.audit/macos-gate' / name
out.mkdir(exist_ok=False)
tmp = pathlib.Path(tempfile.mkdtemp(prefix='hbm-', dir='/tmp'))
home = tmp / 'home'
home.mkdir()
env = os.environ.copy()
# Match the deploy gate's HIVE isolation. Fixture daemons disable gateways in
# helpers.ts; disabling discovery globally breaks the gateway unit fixture.
for key in list(env):
    if (key.startswith('HIVE_') and not key.startswith('HIVE_TEST_')) or key.startswith('APIARY_'):
        env.pop(key)
for key in ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME', 'KIMI_CONFIG_DIR', 'MUSE_HOME', 'AGY_HOME', 'OPENCODE_CONFIG_DIR']:
    env.pop(key, None)
env.update(HOME=str(home), TMPDIR=str(tmp),
    XDG_CONFIG_HOME=str(home / 'config'), XDG_DATA_HOME=str(home / 'data'),
    XDG_CACHE_HOME=str(home / 'cache'), XDG_STATE_HOME=str(home / 'state'),
    HIVE_HOME=str(home / '.hive'), HIVE_STORE_ROOT=str(home / '.hive'),
    HIVE_SOCKET=str(home / '.hive/v2/hived.sock'), HIVE_NO_KEYCHAIN='1',
    npm_config_offline='true', npm_config_update_notifier='false', npm_config_audit='false', npm_config_fund='false')
args = sys.argv[2:]
if args == ['--driver-serial']:
    command = ['node', 'scripts/with-fixture-warden.mjs', 'node', '--test', '--test-concurrency=1', 'v2/adapters/tests/*.test.ts', 'v2/driver-hsr/tests/*.test.ts']
elif args[:1] == ['--npm-script']:
    if len(args) != 2 or args[1] not in ['v2:test', 'v2:driver', 'v2:driver2', 'v2:harness']:
        raise ValueError('expected one pinned repository test script')
    command = ['npm', 'run', args[1]]
else:
    command = ['node', 'scripts/with-fixture-warden.mjs', 'node', 'scripts/run-v2-daemon-tests.mjs', *args]
workers = []
child = None
started = time.time()
try:
    for _ in range(int(os.environ.get('STRESS_WORKERS', '10'))):
        workers.append(subprocess.Popen([sys.executable, '-c', 'while True: pass']))
    workload = dict(command=command, launcherPid=os.getpid(), stressPids=[p.pid for p in workers],
        cpuCount=os.cpu_count(), load=os.getloadavg(), tmp=str(tmp), startedAt=started,
        nodeExecutable=str(pathlib.Path(shutil.which('node')).resolve()),
        isolation='suite HOME/HIVE_HOME/HIVE_STORE_ROOT/HIVE_SOCKET; fixture daemons set their own data and Node paths',
        harnessSha256=hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
        sourceFingerprints={str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted([*(root / 'v2').rglob('*.ts'), *(root / 'scripts').rglob('*.mjs'), root / 'package.json', root / 'package-lock.json'])
            if p.is_file() and not p.is_symlink()})
    (out / 'workload.json').write_text(json.dumps(workload))
    with (out / 'suite.log').open('w') as log:
        child = subprocess.Popen(command, env=env, stdout=log, stderr=subprocess.STDOUT)
        workload['commandPid'] = child.pid
        (out / 'workload.json').write_text(json.dumps(workload))
        code = child.wait()
    (out / 'result.json').write_text(json.dumps(dict(exit=code, seconds=time.time() - started, load=os.getloadavg())))
    print(out, code, flush=True)
finally:
    if child is not None and child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=15)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    for worker in workers:
        if worker.poll() is None:
            worker.terminate()
    for worker in workers:
        worker.wait()
