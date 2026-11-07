import os, subprocess, pathlib, sys, shutil, tempfile
root=pathlib.Path.cwd(); run=root/'.audit/runner-reap'/sys.argv[1]; run.mkdir(parents=True, exist_ok=False)
env=os.environ.copy(); fixture=pathlib.Path(tempfile.mkdtemp(prefix='hb-rs-', dir='/tmp')); home=fixture/'home'; home.mkdir()
env.update(HIVE_NODE_VERSION='', HIVE_NODE_SHA256='', HIVE_NODE_PATH=str(pathlib.Path(shutil.which('node')).resolve()), TMPDIR=str(fixture), HOME=str(home), HIVE_HOME=str(home/'.hive'), HIVE_STORE_ROOT=str(home/'.hive'), HIVE_V2_DATA_DIR=str(home/'v2'), HIVE_SOCKET=str(home/'v2/hived.sock'), HIVE_NO_KEYCHAIN='1', HIVE_GATEWAYS_DISABLE='1')
# Keep all test/stress descendants within this fixture's CPU allocation.
concurrency=int(os.environ.get('HIVE_REAP_CONCURRENCY', '2'))
stress_workers=int(os.environ.get('HIVE_REAP_STRESS_WORKERS', '1'))
cpus=sorted(os.sched_getaffinity(0))[:4]; os.sched_setaffinity(0,cpus)
(run/'workload.txt').write_text(f'cpus={cpus}; stress_workers={stress_workers}; test_concurrency={concurrency}; files={sys.argv[2:]}\n')
workers=[subprocess.Popen([sys.executable,'-c','while True: pass']) for _ in range(stress_workers)]
try:
 with (run/'suite.log').open('w') as log:
  p=subprocess.run((['npm','run','v2:daemon'] if len(sys.argv)<3 else ['node','scripts/with-fixture-warden.mjs','node','--test',f'--test-concurrency={concurrency}',*sys.argv[2:]]),env=env,stdout=log,stderr=subprocess.STDOUT)
 (run/'result').write_text(str(p.returncode)+'\n'); print(run, p.returncode, flush=True)
finally:
 for p in workers: p.terminate()
 for p in workers: p.wait()
