#!/usr/bin/env python3
"""Golden tests for the naturalness wrappers (injected back-ends → no models/venvs).

Run:  python3 scripts/fms-killshot/bench_naturalness_test.py   (exit 0 = all pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bench_naturalness as bn  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


# injected back-ends → deterministic, no venv/model needed
got = bn.naturalness("x.wav", pq_fn=lambda w: 6.4, singmos_fn=lambda w: 4.2)
check("naturalness wires both scores", got == {"pq": 6.4, "singmos": 4.2}, str(got))

# absent back-ends degrade to None, never crash
none = bn.naturalness("x.wav", pq_fn=lambda w: None, singmos_fn=lambda w: None)
check("absent back-ends -> None", none == {"pq": None, "singmos": None}, str(none))

# a raising back-end is caught -> None (best-effort, never fails a benchmark row)
crash = bn.naturalness("x.wav", pq_fn=lambda w: (_ for _ in ()).throw(RuntimeError("boom")),
                       singmos_fn=lambda w: 3.0)
check("raising pq back-end -> None", crash == {"pq": None, "singmos": 3.0}, str(crash))

# non-numeric back-end result coerces to None (never leaks a str/dict into the metric)
bad = bn.naturalness("x.wav", pq_fn=lambda w: "nope", singmos_fn=lambda w: True)
check("non-numeric -> None (bool rejected too)", bad == {"pq": None, "singmos": None}, str(bad))

# the default real back-ends must not crash when venvs are absent (graceful None)
real = bn.naturalness("/nonexistent/does-not-exist.wav")
check("real back-ends graceful on missing venv/file",
      set(real.keys()) == {"pq", "singmos"} and real["singmos"] is None, str(real))

print("\n" + ("ALL PASS" if not fails else "FAILURES: " + ", ".join(fails)))
sys.exit(1 if fails else 0)
