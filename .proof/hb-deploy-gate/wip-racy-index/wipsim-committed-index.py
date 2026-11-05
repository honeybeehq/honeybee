import os, subprocess, tempfile, shutil
d = tempfile.mkdtemp(prefix="wipsim-", dir="/private/tmp/hb-gate")
repo = os.path.join(d, "repo"); os.makedirs(os.path.join(repo, "src"))
def git(*args, env=None, cwd=repo):
    e = dict(os.environ); e.update(env or {})
    return subprocess.run(["git", *args], cwd=cwd, env=e, capture_output=True, text=True, check=True).stdout.strip()
git("init", "-q"); git("config", "user.email", "a@b"); git("config", "user.name", "t"); git("config", "core.trustctime", "false")
app = os.path.join(repo, "src", "app.ts")
open(app, "w").write("export const version = 1;\n")
git("add", "-A"); git("commit", "-qm", "one")
index = os.path.join(repo, ".git", "index")
orig = os.stat(app); st = os.stat(index)
open(app, "w").write("export const version = 2;\n")
os.utime(app, ns=(orig.st_atime_ns, orig.st_mtime_ns))  # same mtime as the index write, same size: a same-second write on a seconds-only git
for mode in ("bumped", "preserved"):
    wip = os.path.join(d, "wip.index"); shutil.copyfile(index, wip)
    if mode == "preserved": os.utime(wip, ns=(st.st_atime_ns, st.st_mtime_ns))
    env = {"GIT_INDEX_FILE": wip}
    git("add", "-A", "--", ".", env=env); tree = git("write-tree", env=env)
    print(mode, "copy -> snapshot app.ts =", git("show", f"{tree}:src/app.ts").strip())
    os.remove(wip)
print(git("--version"))
