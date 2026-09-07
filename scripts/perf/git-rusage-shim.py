"""Diagnostic-only PATH shim for one synchronous Git invocation on macOS."""

import fcntl
import json
import os
import resource
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid


CONFIG_ENV = "HONEYBEE_GIT_RUSAGE_CONFIG"
COUNTER_FIELDS = (
    "ru_minflt",
    "ru_majflt",
    "ru_nswap",
    "ru_inblock",
    "ru_oublock",
    "ru_msgsnd",
    "ru_msgrcv",
    "ru_nsignals",
    "ru_nvcsw",
    "ru_nivcsw",
)


def usage_snapshot(value):
    result = {
        "userMicros": round(value.ru_utime * 1_000_000),
        "systemMicros": round(value.ru_stime * 1_000_000),
        # getrusage(2) documents bytes on macOS. This is a maximum, not an
        # additive counter, so it must never be subtracted or summed.
        "maxRssBytes": int(value.ru_maxrss),
    }
    for name in COUNTER_FIELDS:
        result[name[3:]] = int(getattr(value, name))
    return result


def additive_delta(before, after):
    keys = ("userMicros", "systemMicros") + tuple(
        name[3:] for name in COUNTER_FIELDS
    )
    return {key: after[key] - before[key] for key in keys}


def load_config():
    if sys.platform != "darwin":
        raise RuntimeError("Git rusage diagnostics require macOS")
    path = os.environ.get(CONFIG_ENV)
    if not path or not os.path.isabs(path):
        raise ValueError("missing absolute diagnostic config path")
    config_stat = os.stat(path, follow_symlinks=False)
    if (
        not stat.S_ISREG(config_stat.st_mode)
        or config_stat.st_uid != os.getuid()
        or stat.S_IMODE(config_stat.st_mode) & 0o077
    ):
        raise PermissionError("diagnostic config must be an owner-only file")
    with open(path, "r", encoding="utf-8") as handle:
        config = json.load(handle)
    expected = {
        "originalCfUserTextEncoding",
        "originalPath",
        "realGit",
        "recordsDir",
        "runId",
        "schemaVersion",
        "sequencePath",
    }
    if set(config) != expected or config["schemaVersion"] != 1:
        raise ValueError("unexpected diagnostic config shape")
    if config["originalPath"] is not None and not isinstance(
        config["originalPath"], str
    ):
        raise TypeError("originalPath must be a string or null")
    if config["originalCfUserTextEncoding"] is not None and not isinstance(
        config["originalCfUserTextEncoding"], str
    ):
        raise TypeError("originalCfUserTextEncoding must be a string or null")
    if not isinstance(config["runId"], str) or not config["runId"]:
        raise TypeError("runId must be a non-empty string")
    real_git = config["realGit"]
    records_dir = config["recordsDir"]
    sequence_path = config["sequencePath"]
    if (
        not isinstance(real_git, str)
        or not os.path.isabs(real_git)
        or not os.access(real_git, os.X_OK)
    ):
        raise ValueError("realGit must be an absolute executable")
    if not isinstance(records_dir, str) or not os.path.isabs(records_dir):
        raise ValueError("recordsDir must be absolute")
    if not isinstance(sequence_path, str) or not os.path.isabs(sequence_path):
        raise ValueError("sequencePath must be absolute")
    records_stat = os.stat(records_dir, follow_symlinks=False)
    if (
        not stat.S_ISDIR(records_stat.st_mode)
        or records_stat.st_uid != os.getuid()
        or stat.S_IMODE(records_stat.st_mode) & 0o077
    ):
        raise PermissionError("recordsDir must be an owner-only directory")
    sequence_stat = os.stat(sequence_path, follow_symlinks=False)
    if (
        not stat.S_ISREG(sequence_stat.st_mode)
        or sequence_stat.st_uid != os.getuid()
        or stat.S_IMODE(sequence_stat.st_mode) & 0o077
    ):
        raise PermissionError("sequencePath must be an owner-only file")
    return config


def child_environment(config):
    # The launcher adds only CONFIG_ENV and prepends the shim to PATH. Remove
    # that metadata and restore PATH before real Git starts, so Git and every
    # descendant see the original workload environment exactly.
    env = dict(os.environ)
    env.pop(CONFIG_ENV, None)
    if config["originalPath"] is None:
        env.pop("PATH", None)
    else:
        env["PATH"] = config["originalPath"]
    # CPython startup on macOS materializes this CoreFoundation variable even
    # when it was absent at exec. Restore the launcher's observed state.
    if config["originalCfUserTextEncoding"] is None:
        env.pop("__CF_USER_TEXT_ENCODING", None)
    else:
        env["__CF_USER_TEXT_ENCODING"] = config["originalCfUserTextEncoding"]
    return env


def next_sequence(path):
    with open(path, "r+", encoding="ascii") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        raw = handle.read().strip()
        if not raw.isdigit():
            raise ValueError("invalid Git rusage sequence")
        value = int(raw)
        handle.seek(0)
        handle.truncate()
        handle.write("%d\n" % (value + 1))
        handle.flush()
        os.fsync(handle.fileno())
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        return value


def write_record(records_dir, sequence, record):
    final_name = "%06d-%s-%d-%s.json" % (
        sequence,
        time.time_ns(),
        os.getpid(),
        uuid.uuid4().hex,
    )
    final_path = os.path.join(records_dir, final_name)
    fd, temporary_path = tempfile.mkstemp(
        prefix=".record-", suffix=".tmp", dir=records_dir
    )
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            fd = -1
            json.dump(record, handle, sort_keys=True, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, final_path)
    finally:
        if fd >= 0:
            os.close(fd)
        try:
            os.unlink(temporary_path)
        except FileNotFoundError:
            pass
def run():
    config = load_config()
    sequence = next_sequence(config["sequencePath"])
    before = usage_snapshot(resource.getrusage(resource.RUSAGE_CHILDREN))
    started_monotonic_ns = time.monotonic_ns()
    started_epoch_ns = time.time_ns()
    argv = ["git"] + sys.argv[1:]
    child = subprocess.Popen(
        argv,
        executable=config["realGit"],
        env=child_environment(config),
        # stdin/stdout/stderr and cwd are deliberately inherited unchanged.
    )

    prior_handlers = {}

    def forward(signum, _frame):
        try:
            child.send_signal(signum)
        except ProcessLookupError:
            pass

    for signum in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM, signal.SIGQUIT):
        prior_handlers[signum] = signal.getsignal(signum)
        signal.signal(signum, forward)

    returncode = child.wait()
    finished_monotonic_ns = time.monotonic_ns()
    after = usage_snapshot(resource.getrusage(resource.RUSAGE_CHILDREN))
    delta = additive_delta(before, after)
    record = {
        "schemaVersion": 1,
        "runId": config["runId"],
        "sequence": sequence,
        "wrapperPid": os.getpid(),
        "launcherPid": os.getppid(),
        "realGitPid": child.pid,
        "argv": argv,
        "cwd": os.getcwd(),
        # Decimal string: epoch nanoseconds exceed JavaScript's safe integer.
        "startedEpochNs": str(started_epoch_ns),
        # Retained for within-process timing provenance; the locked sequence
        # above, not this process-local clock, orders separate wrappers.
        "startedMonotonicNs": str(started_monotonic_ns),
        "diagnosticWallNs": finished_monotonic_ns - started_monotonic_ns,
        "returncode": returncode,
        "terminatedBySignal": -returncode if returncode < 0 else None,
        "rusageChildrenBefore": before,
        "rusageChildrenAfter": after,
        "additiveDelta": delta,
        "cpuMicros": delta["userMicros"] + delta["systemMicros"],
        "maxRssBytes": after["maxRssBytes"],
        "maxRssAttributable": before["maxRssBytes"] == 0,
        "scope": (
            "real Git plus descendants that it terminated and waited for; "
            "excludes this Python wrapper"
        ),
    }
    try:
        write_record(config["recordsDir"], sequence, record)
    except Exception:
        # Telemetry failure must not replace Git's stdout, stderr, or status.
        # The outside aggregator detects the missing record and fails closed.
        pass
    finally:
        for signum, handler in prior_handlers.items():
            signal.signal(signum, handler)

    if returncode < 0:
        signum = -returncode
        try:
            signal.signal(signum, signal.SIG_DFL)
        except (OSError, RuntimeError, ValueError):
            pass
        os.kill(os.getpid(), signum)
        os._exit(128 + signum)
    return returncode


if __name__ == "__main__":
    try:
        status = run()
    except BaseException:
        # A malformed diagnostic is invalid rather than a different Git call.
        # Stay silent so the shim never writes into Git's captured streams.
        status = 125
    sys.exit(status)
