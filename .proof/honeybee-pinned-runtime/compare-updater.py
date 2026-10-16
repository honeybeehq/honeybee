import ast, difflib, hashlib, os, pathlib, shlex
root = pathlib.Path(os.environ['LAB_ROOT'])
source = (root/'apiary-honeybee-update-host.py').read_text()
tree = ast.parse(source)
functions = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in ('service_args', 'replace')]
namespace = {'Path':pathlib.Path, 'shlex':shlex}
exec(compile(ast.Module(body=functions, type_ignores=[]), '<apiary updater replace>', 'exec'), namespace)
raw = (root/'updater-old.service').read_bytes()
actual = namespace['replace'](raw, 'linux', '/scratch/.hive/v2', '/packages/new/dist/cli.js')
expected = (root/'deploy-new.service').read_bytes()
print('Apiary main 39a7835d146a2bff7bbd83941b5d1cd6654f1609; Honeybee base a1da490a4d39c904e1af8016e664905daa543ef5')
print('Same label, argv, data dir, HOME, PATH, version, hash and log path; existing unit already has pin env.')
print('updater sha256='+hashlib.sha256(actual).hexdigest())
print('deploy sha256='+hashlib.sha256(expected).hexdigest())
print('byte_equal='+str(actual==expected))
print(''.join(difflib.unified_diff(actual.decode().splitlines(True),expected.decode().splitlines(True),fromfile='apiary-updater',tofile='honeybee-deploy')))
assert actual != expected
converged=namespace['replace'](expected,'linux','/scratch/.hive/v2','/packages/new/dist/cli.js')
assert converged == expected
print('Already-canonical new unit: updater preserves exact bytes=True')
print('Older units lacking HIVE_NODE_PATH/VERSION/SHA256 keep lacking them; updater does not persist node-runtime.json or scrub inherited environment. Apiary-side fix must call Honeybee install with pin before activation or share canonical rendering; updater does not currently defer.')
