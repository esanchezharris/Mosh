#!/usr/bin/env python3
"""One-entry verification for the teardown lane (mirrors scripts/verify-hardware ethos).

Runs each component's self-test 3x and asserts (a) exit 0 and (b) byte-identical output
across runs (the repo's deterministic bar). Pure Python; no engine/build needed.

    python3 service/teardown/verify.py     (exit 0 = all green)
"""
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PY = sys.executable

# (label, test script) — grows as the lane does (oracle, etc.)
SUITE = [
    ("recipe contract (§0)", HERE / "recipe_test.py"),
    ("drum matcher (§1)", HERE / "drummatch" / "drummatch_test.py"),
    ("render-and-compare oracle (§6)", HERE / "oracle" / "oracle_test.py"),
    ("render compiler (§9)", HERE / "render" / "compile_test.py"),
]

fails: list[str] = []


def run3(label: str, script: Path) -> None:
    outs = []
    for i in range(3):
        p = subprocess.run([PY, str(script)], capture_output=True, text=True)
        if p.returncode != 0:
            fails.append(f"{label} (run {i + 1} exit {p.returncode})")
            print(f"  FAIL {label} — run {i + 1} exit {p.returncode}")
            print((p.stdout or "")[-600:])
            print((p.stderr or "")[-600:])
            return
        outs.append(p.stdout)
    if len(set(outs)) != 1:
        fails.append(f"{label} (non-deterministic)")
        print(f"  FAIL {label} — output differs across 3 runs")
        return
    last = outs[-1].strip().splitlines()[-1] if outs[-1].strip() else ""
    print(f"  ok   {label} — 3x deterministic, exit 0   [{last}]")


print("— teardown lane verify —")
for label, script in SUITE:
    if not script.exists():
        fails.append(f"{label} (missing {script.name})")
        print(f"  FAIL {label} — {script} not found")
        continue
    run3(label, script)

print(f"\n{'ALL GREEN' if not fails else 'FAILURES: ' + ', '.join(fails)}")
sys.exit(len(fails))
