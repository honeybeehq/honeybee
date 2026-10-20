from pathlib import Path
import re
import subprocess

pattern = re.compile(r"/home/trmd/\.hive/v2/cells/[^/\s\"'<>]+/[^/\s\"'<>]+")
paths = {Path(name) for name in subprocess.check_output(["git", "ls-files", "--", ".proof/C", ".proof/E"], text=True).splitlines()}
paths.update(path for path in Path(".proof/E").iterdir() if path.is_file())
for path in sorted(paths):
    if path.is_symlink() or not path.is_file():
        continue
    try:
        original = path.read_text()
    except UnicodeDecodeError:
        continue
    updated, count = pattern.subn("<CELL>", original)
    if count:
        path.write_text(updated)
        print(f"{path}: {count} Cell-root replacements")
