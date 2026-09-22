# macOS Cell process census

Honeybee uses `/bin/ps` for POSIX topology and process-birth inspection. It does
not build or select a native process-census companion. Apiary consumers must not
expect `dist/native/process-census` in new runtime artifacts.

The reader pins `LC_ALL=C`, bounds execution to five seconds and output to
16 MiB, and retains PID/PGID plus birth checks before destructive recovery.
Inspection failures remain unverifiable; they must never authorize signaling
or be treated as proof that a process is gone. A selected-PID ps exit of 1
retains its existing no-match meaning.

An inherited macOS Cell previously reproduced `spawn /bin/ps EPERM`. Removing
the native workaround does not solve that limitation: detached admission and
recovery requiring OS-comparable identity can fail closed in affected Cells.
The suspected connection to the setuid system executable is not an established
root cause. Investigate host versus fresh/inherited sandbox behavior and
whether daemon-owned inspection can meet the need before adding native build
and distribution requirements again.

Track reproduction, alternatives, and acceptance evidence in
[HIVE-82](https://linear.app/trmd/issue/HIVE-82).
