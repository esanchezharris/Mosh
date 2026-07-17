#!/usr/bin/env python3
"""Golden tests for the time-scheduled steering envelope (`build_envelope`) —
HERMETIC: pure numpy, no MLX. 3× deterministic. Covers the "Sustain" color's
per-latent-position schedule that holds the opening character across the clip.

Run:  python3 service/sa3/scheduled_steer_test.py     (exit 0 = all pass)
"""
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from sa3.scheduled_steer import build_envelope  # noqa: E402

LAT_S = 4096 / 44100.0   # ~0.0929 s per latent position (SAMPLES_PER_LATENT / SAMPLE_RATE)
fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


# None spec => no schedule (uniform steer, byte-identical to stock).
check("None spec -> None", build_envelope(None, 130, LAT_S) is None)
check("empty spec -> None", build_envelope({}, 130, LAT_S) is None)

# flat: full `hi` everywhere (hi=1 => a genuine no-op vs the uniform steer).
flat = build_envelope({"kind": "flat"}, 10, LAT_S)
check("flat is all-ones (uniform)", flat is not None and np.allclose(flat, 1.0) and flat.shape == (10,),
      f"{None if flat is None else flat.tolist()}")

# linear: lo..hi across the clip.
lin = build_envelope({"kind": "linear"}, 5, LAT_S)
check("linear ramps 0..1 across positions",
      lin is not None and np.allclose(lin, [0.0, 0.25, 0.5, 0.75, 1.0]),
      f"{None if lin is None else lin.tolist()}")

# hold: flat lo through the first knee_s, then ramp to hi; leaves the intro alone.
t_lat = 130                                    # ~12 s at 92.9 ms/pos
knee = int(round(1.5 / LAT_S))                 # ~16 positions
hold = build_envelope({"kind": "hold", "knee_s": 1.5}, t_lat, LAT_S)
check("hold: intro (through the knee) is 0",
      hold is not None and float(hold[:knee].max()) == 0.0, f"knee={knee}")
check("hold: first post-knee position lifts above 0", float(hold[knee]) >= 0.0 and float(hold[knee + 1]) > 0.0)
check("hold: reaches full (1.0) at the end", abs(float(hold[-1]) - 1.0) < 1e-6, f"end={float(hold[-1]):.4f}")
check("hold: monotonic non-decreasing", bool(np.all(np.diff(hold) >= -1e-7)))
check("hold: dtype float32", hold.dtype == np.float32)

# hold on a clip SHORTER than the knee => no hold (all lo); a <1.5 s clip has no tail.
short = build_envelope({"kind": "hold", "knee_s": 1.5}, 10, LAT_S)   # 10 pos ≈ 0.93 s < knee
check("hold shorter than knee -> all zeros (no-op)", np.allclose(short, 0.0), f"{short.tolist()}")

# lo/hi overrides.
lohi = build_envelope({"kind": "linear", "lo": 0.5, "hi": 1.0}, 3, LAT_S)
check("lo/hi honored", np.allclose(lohi, [0.5, 0.75, 1.0]), f"{None if lohi is None else lohi.tolist()}")

# t_lat == 1 edge (degenerate grid) must not crash.
one = build_envelope({"kind": "hold", "knee_s": 1.5}, 1, LAT_S)
check("t_lat==1 does not crash", one is not None and one.shape == (1,))

# unknown kind rejected.
try:
    build_envelope({"kind": "bogus"}, 10, LAT_S)
    check("unknown kind raises", False, "no exception")
except ValueError:
    check("unknown kind raises", True)

# determinism (3×): identical arrays.
a = build_envelope({"kind": "hold", "knee_s": 1.5}, t_lat, LAT_S)
b = build_envelope({"kind": "hold", "knee_s": 1.5}, t_lat, LAT_S)
check("deterministic (identical across calls)", np.array_equal(a, b))

print(("FAILS: " + ", ".join(fails)) if fails else "ALL PASS")
sys.exit(1 if fails else 0)
