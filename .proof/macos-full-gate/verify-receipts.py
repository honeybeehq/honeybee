"""Check defined source paths and stored full-run receipts; never re-execute tests."""
import hashlib
import json
import pathlib
import re

SOURCE_ROOTS = ("v2", "scripts", ".agents/skills/perf-honeybee")
SOURCE_SUFFIXES = {".ts", ".mjs", ".c", ".h", ".json", ".md"}
ROOT_FILES = {"package.json", "package-lock.json"}


def source_paths(root):
    return ROOT_FILES | {str(p.relative_to(root)) for folder in SOURCE_ROOTS
                         for p in (root / folder).rglob("*")
                         if p.is_file() and not p.is_symlink() and p.suffix in SOURCE_SUFFIXES}


def launch_fingerprints(manifest):
    return {path: value for path, value in manifest.items()
            if path in ROOT_FILES or path.startswith("v2/") and path.endswith(".ts")
            or path.startswith("scripts/") and path.endswith(".mjs")}


def require_exact(actual, expected, label):
    assert actual == expected, label


def check_source(root, proof):
    manifest = json.loads((proof / "source-fingerprints.json").read_text())
    require_exact(set(manifest), source_paths(root), "defined source path set changed")
    for path, expected in manifest.items():
        assert hashlib.sha256((root / path).read_bytes()).hexdigest() == expected, path
    census = json.loads((proof / "census.json").read_text())
    for kind in ("daemon", "cli"):
        actual = sorted(str(p.relative_to(root)) for p in (root / ("v2/" + kind + "/tests")).glob("*.test.ts"))
        require_exact(census[kind], actual, kind + " test file names changed")
        assert census[kind + "Count"] == len(actual)
    runner = (root / "scripts/run-v2-daemon-tests.mjs").read_text()
    unit_block = runner.split("const UNIT_FILES = new Set([", 1)[1].split("]);", 1)[0]
    units = sorted(re.findall(r'"(v2/daemon/tests/[^"\n]+\.test\.ts)"', unit_block))
    assert len(units) == len(set(units)) == census["unitCount"]
    assert set(units) <= set(census["daemon"])
    groups = [units] + [[path] for path in census["daemon"] if path not in units] + [[path] for path in census["cli"]]
    require_exact(census["groups"], groups, "declared runner grouping changed")
    assert census["groupCount"] == len(groups) and census["serialCount"] == len(groups) - 1
    return manifest, census


def check_harness(proof):
    used = (proof / "run-capture-harness-v1.py").read_text()
    assert used.count("out.mkdir(exist_ok=False)") == 1
    footer = "\n# Preserve the test command status after owned-process cleanup.\nif code != 0:\n    raise SystemExit(code if code > 0 else 128 - code)\n"
    expected = used.replace("out.mkdir(exist_ok=False)", "out.mkdir(parents=True, exist_ok=False)") + footer
    require_exact((proof / "run-stressed-suite.py").read_text(), expected, "reproducer differs beyond parent creation and status propagation")


def main():
    root = pathlib.Path(__file__).resolve().parents[2]
    proof = pathlib.Path(__file__).resolve().parent
    manifest, census = check_source(root, proof)
    check_harness(proof)
    samples = [json.loads(line) for line in (proof / "stress-samples.jsonl").read_text().splitlines() if line]
    roots, workers = [], []
    for name in ("verified-full-a", "verified-full-b"):
        result = json.loads((proof / (name + "-result.json")).read_text())
        workload = json.loads((proof / (name + "-workload.json")).read_text())
        log = (proof / (name + ".log")).read_text()
        assert result["exit"] == 0, name
        require_exact(workload["command"], ["node", "scripts/with-fixture-warden.mjs", "node", "scripts/run-v2-daemon-tests.mjs"], name + " unfiltered command")
        require_exact(workload["sourceFingerprints"], launch_fingerprints(manifest), name + " complete launch fingerprint set")
        assert hashlib.sha256((proof / "run-capture-harness-v1.py").read_bytes()).hexdigest() == workload["harnessSha256"], name
        ids = set(workload["stressPids"])
        assert len(workload["stressPids"]) == len(ids) == 10, name
        roots.append(workload["tmp"])
        workers.append(ids)
        reported = re.findall(r"^ℹ duration_ms ", log, re.M)
        assert len(reported) == census["groupCount"], (name, len(reported))
        assert not re.search(r"^ℹ (?:fail|cancelled) [1-9]", log, re.M), name
        assert not re.search(r"^✖", log, re.M), name
        prefixes = ["credential handoff " + harness + ":" for harness in ("claude", "codex", "grok")]
        prefixes += ["admission.pause: pause ownership", "rpc.accounts.fuzzy: one selector", "central Grok review: live ownership", "quiet facts through a throwaway daemon", "question egress root reuse preserves cyclic reachability"]
        for prefix in prefixes:
            assert len(re.findall(r"^✔ " + re.escape(prefix), log, re.M)) == 1, (name, prefix)
        observed = sorted((sample for sample in samples if sample["run"] == name), key=lambda sample: sample["at"])
        assert len(observed) >= 2, name + " stress samples missing"
        for sample in observed:
            assert len(sample["workers"]) == 10
            require_exact({row["pid"] for row in sample["workers"]}, ids, name + " sampled worker IDs")
            assert all(row["ppid"] == workload["launcherPid"] for row in sample["workers"])
            assert sum(row["cpuPercent"] for row in sample["workers"]) > 0
            assert workload["startedAt"] <= sample["at"] <= workload["startedAt"] + result["seconds"]
        span = round(observed[-1]["at"] - observed[0]["at"])
        print(f"{name}: stored exit 0; {len(reported)} reported groups; named cases pass; configured 10 stress workers; {len(observed)} owned CPU samples spanning {span}s")
    assert len(set(roots)) == 2 and workers[0].isdisjoint(workers[1])
    assert json.loads((proof / "host.json").read_text())["platform"].startswith(("Darwin", "macOS")), "recorded host must be macOS"
    print(f"{len(manifest)} defined source paths/hashes and exact discovered file names/grouping match")
    print("Scope: trusts stored harness metadata/logs; group summaries lack per-file identity. Other-stage logs and build artifacts are separate evidence. No tests were re-executed.")


if __name__ == "__main__":
    main()
