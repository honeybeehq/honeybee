import json
import os
import pathlib
import pwd
import sys

PROVIDER_DIRS = ('.claude', '.codex', '.grok', '.kimi', '.gemini', '.cursor', '.muse', '.config/opencode', '.config/muse', '.local/share/opencode')
APIARY_DIRS = ('.apiary', '.local/share/apiary', '.local/share/apiary-satellite', '.local/share/apiary/satellite-updater')
PROVIDER_KEYS = ('CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GROK_HOME', 'GEMINI_CLI_HOME', 'OPENCODE_CONFIG_DIR', 'KIMI_CODE_HOME', 'CURSOR_CONFIG_DIR', 'HIVE_REAL_HOME')


def home_guard(environment, passwd_homes, resolve=os.path.realpath, protected_roots=(), allowed_roots=()):
    homes = [resolve(str(home)) for home in passwd_homes]
    protected = [resolve(str(pathlib.Path(home) / name)) for home in homes for name in ('.hive', '.config', '.ssh', '.gnupg', 'Library', *PROVIDER_DIRS, *APIARY_DIRS)]
    protected.extend(resolve(str(path)) for path in protected_roots)
    allowed = [resolve(str(pathlib.Path(home) / '.cache/hbl')) for home in homes]
    allowed.extend(resolve(str(path)) for path in allowed_roots)
    names = sorted({'HOME', 'TMPDIR'} | {name for name in environment if name.startswith('XDG_') or name in PROVIDER_KEYS})
    for name in names:
        value = environment.get(name)
        if not value:
            return dict(allowed=False, offendingVariable=name, checkedVariables=names)
        values = value.split(os.pathsep) if name.startswith('XDG_') and name.endswith('_DIRS') else [value]
        try:
            paths = [resolve(part) for part in values]
        except (OSError, ValueError):
            return dict(allowed=False, offendingVariable=name, checkedVariables=names)
        if any(path in homes or any(path == target or path.startswith(target + os.sep) for target in protected) for path in paths):
            return dict(allowed=False, offendingVariable=name, checkedVariables=names)
        if name in ('HOME', 'TMPDIR') or name.startswith('XDG_'):
            if any(not any(path == target or path.startswith(target + os.sep) for target in allowed) for path in paths):
                return dict(allowed=False, offendingVariable=name, checkedVariables=names)
    return dict(allowed=True, checkedVariables=names, beforeFirstWrite=True, ruleVersion=30, protectedRoots=sorted(set(protected)), allowedRoots=sorted(set(allowed)))


def entry_guard(root=None):
    try:
        homes = [pwd.getpwuid(os.getuid()).pw_dir]
        protected = []
        allowed = []
        if root is not None and (pathlib.Path(root) / 'config.json').is_file():
            config = json.loads((pathlib.Path(root) / 'config.json').read_text())
            homes.append(config.get('passwdHome', config['realHome']))
            allowed = config.get('entryGuard',{}).get('allowedRoots',[]) + [str(root)]
            protected = config.get('entryGuard',{}).get('protectedRoots',[])
        result = home_guard(os.environ, homes, protected_roots=protected, allowed_roots=allowed)
    except (OSError, KeyError, ValueError):
        result = dict(allowed=False, offendingVariable='HOME')
    if not result['allowed']:
        print('refused unsafe ' + result['offendingVariable'], file=sys.stderr)
        raise SystemExit(2)
    return result


def pull_destination(root, name, script_names):
    if pathlib.PurePath(name).name != name or name in ('', '.', '..') or name in script_names:
        raise ValueError('remote output cannot share a local script name or escape the pull directory')
    return pathlib.Path(root) / 'pull' / name
