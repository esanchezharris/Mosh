#!/usr/bin/env python3
"""Unit tests for the auto mix-balance controller (engine-free).

    service/teardown/.venv/bin/python service/teardown/render/balance_test.py   (exit 0 = pass)
"""
import math
import os
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(os.path.dirname(_HERE))
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

from teardown.render import balance as B  # noqa: E402

fails: list[str] = []


def check(name, cond, extra=""):
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond or not extra else f"  [{extra}]"))
    if not cond:
        fails.append(name)


ROLES = ["kick", "snare", "hat", "pad", "808", "lead"]

# in-band → converged, no offsets
check("in-band mix converges immediately",
      B.compute_offsets({"subRatio": 0.70}, None, ROLES) is None)

# starved sub → 808 up, melodics duck, drums untouched
offs = B.compute_offsets({"subRatio": 0.10}, {"subRatio": 0.9}, ROLES)
check("starved sub raises the 808", offs is not None and offs[4] > B.HEADROOM_TRIM_DB, str(offs))
check("starved sub ducks pad and lead",
      offs[3] < B.HEADROOM_TRIM_DB and offs[5] < B.HEADROOM_TRIM_DB, str(offs))
check("starved sub leaves drums alone", all(i not in offs for i in (0, 1, 2)), str(offs))
check("big deficit takes the big step", offs[4] == B.HEADROOM_TRIM_DB + 6.0, str(offs))

# small deficit → small step
offs_s = B.compute_offsets({"subRatio": 0.45}, None, ROLES)
check("small deficit takes the small step", offs_s[4] == B.HEADROOM_TRIM_DB + 3.0, str(offs_s))

# drowned sub → 808 down
offs_d = B.compute_offsets({"subRatio": 0.92}, None, ROLES)
check("drowned sub lowers the 808", offs_d[4] == B.HEADROOM_TRIM_DB - 3.0, str(offs_d))

# boost is capped and clamp-exhaustion terminates the loop
prev = None
for _ in range(10):
    nxt = B.compute_offsets({"subRatio": 0.05}, None, ROLES, prev)
    if nxt is None:
        break
    prev = nxt
check("808 boost caps at HEADROOM+MAX", prev[4] == B.HEADROOM_TRIM_DB + B.MAX_808_BOOST_DB, str(prev))
check("clamp exhaustion terminates (None once no move remains)",
      B.compute_offsets({"subRatio": 0.05}, None, ROLES, prev) is None)

# no bass element → nothing to do
check("no 808/bass role → converged (no-op)",
      B.compute_offsets({"subRatio": 0.05}, None, ["kick", "pad"]) is None)

# command shapes
cmds = B._volume_cmds({4: -1.5, 3: -6.0})
check("volume commands are absolute per-track set_track_volume",
      cmds == [{"command": "set_track_volume", "args": {"trackId": "${T3}", "db": -6.0}},
               {"command": "set_track_volume", "args": {"trackId": "${T4}", "db": -1.5}}], str(cmds))
solo = B._solo_cmds(4, 6)
check("solo mutes every other track", len(solo) == 5 and
      all(c["args"]["mute"] and c["args"]["trackId"] != "${T4}" for c in solo), str(solo))

# band_metrics on synthetic audio: pure 40 Hz → sub-dominated; pure 1 kHz → subRatio ~0
try:
    import numpy as np
    import soundfile as sf
    sr = 44100
    t = np.arange(sr * 2) / sr
    with tempfile.TemporaryDirectory() as td:
        p40 = os.path.join(td, "s40.wav")
        p1k = os.path.join(td, "s1k.wav")
        sf.write(p40, 0.5 * np.sin(2 * math.pi * 40 * t), sr)
        sf.write(p1k, 0.5 * np.sin(2 * math.pi * 1000 * t), sr)
        m40, m1k = B.band_metrics(p40), B.band_metrics(p1k)
    check("40 Hz tone is sub-dominated (ratio > 0.95, peak ≈ 40)",
          m40["subRatio"] > 0.95 and abs(m40["peakHz"] - 40) < 2, str(m40))
    check("1 kHz tone has ~zero sub ratio", m1k["subRatio"] < 0.05, str(m1k))
    check("rmsDb is sane for a 0.5-amp sine", -12.0 < m40["rmsDb"] < -6.0, str(m40["rmsDb"]))
except ImportError:
    print("  skip band_metrics (numpy/soundfile absent)")

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
