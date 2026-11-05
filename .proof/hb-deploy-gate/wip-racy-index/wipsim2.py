import os, subprocess, tempfile, shutil
d = tempfile.mkdtemp(prefix="wipsim2-", dir="/private/tmp/hb-gate")
origin = os.path.join(d, "origin"); os.makedirs(os.path.join(origin, "src"))
def git(*args, cwd, env=None):
    e = dict(os.environ); e.update(env or {})
    return subprocess.run(["git", *args], cwd=cwd, env=e, capture_output=True, text=True, check=True).stdout.strip()
git("init", "-q", cwd=origin); git("config", "user.email", "a@b", cwd=origin); git("config", "user.name", "t", cwd=origin)
open(os.path.join(origin, "src", "app.ts"), "w").write("export const version = 1;\n")
git("add", "-A", cwd=origin); git("commit", "-qm", "one", cwd=origin)
space = os.path.join(d, "space"); git("clone", "-q", origin, space, cwd=d)
git("config", "core.trustctime", "false", cwd=space)
app = os.path.join(space, "src", "app.ts"); index = os.path.join(space, ".git", "index")
orig = os.stat(app); ist = os.stat(index)
open(app, "w").write("export const version = 2;\n")
os.utime(app, ns=(orig.st_atime_ns, orig.st_mtime_ns))
print("entry mtime == file mtime:", os.stat(app).st_mtime_ns == orig.st_mtime_ns, "| index mtime - file mtime (ms):", (ist.st_mtime_ns - orig.st_mtime_ns) / 1e6)
for mode in ("bumped", "preserved"):
    wip = os.path.join(d, "wip.index"); shutil.copyfile(index, wip)
    if mode == "preserved": os.utime(wip, ns=(ist.st_atime_ns, ist.st_mtime_ns))
    env = {"GIT_INDEX_FILE": wip}
    git("add", "-A", "--", ".", cwd=space, env=env); tree = git("write-tree", cwd=space, env=env)
    print(mode, "copy -> snapshot app.ts =", git("show", f"{tree}:src/app.ts", cwd=space).strip())
    os.remove(wip)
