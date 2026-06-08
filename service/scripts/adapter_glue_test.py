#!/usr/bin/env python3
"""Fast CPU-only check of the SA3 adapter glue (no model load): colorrack resolution,
/colors descriptor, health, color normalization, judge readout."""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)
os.environ["MOSH_ADAPTER"] = "stable_audio_3"

import adapters.stable_audio3_adapter as A  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


ad = A.StableAudio3Adapter()

h = ad.health()
check("health advertises colors+judge+cache", h.get("colors") and h.get("judge") == "dsp" and h.get("initLatentCache"), str(h))

desc = ad.colors()
names = {c["name"] for c in desc}
check("colors() descriptor has 9 calibrated colors", len(desc) == 9, sorted(names))
air = next((c for c in desc if c["name"] == "air"), None)
check("air carries astd_max ceiling 0.08", air and abs(air["astd_max"] - 0.08) < 1e-6, str(air))

# normalization: mixed dict + string forms
norm = A._normalize_colors([{"name": "grit", "value": 80}, "air", {"name": "", "value": 5}])
check("normalize colors (dict+string, drop empty)", norm == [{"name": "grit", "value": 80.0}, {"name": "air", "value": 100.0}], str(norm))

# steering resolution (calibrated + lab)
steers, summary = A._steers_for([{"name": "grit", "value": 100}], lab=False)
check("steers_for grit@100 -> 1 tuple (layer,alpha,vec)", len(steers) == 1 and steers[0][2].shape == (1536,),
      f"layer={steers[0][0]} alpha={round(steers[0][1],3)}" if steers else "none")
steers_lab, _ = A._steers_for([{"name": "grit", "value": 100}], lab=True)
check("lab unlocks larger alpha than calibrated", steers_lab and abs(steers_lab[0][1]) >= abs(steers[0][1]),
      f"cal={round(steers[0][1],3)} lab={round(steers_lab[0][1],3)}")

# no_stack_with rejection (drum_aggression + grid_tightness)
try:
    A._steers_for([{"name": "drum_aggression", "value": 80}, {"name": "grid_tightness", "value": 80}], lab=False)
    check("no_stack_with raises", False, "did not raise")
except RuntimeError as e:
    check("no_stack_with raises", True, str(e)[:60])

# <=3 cap
many = [{"name": n, "value": 70} for n in ["grit", "air", "brightness", "epic"]]
s_many, _ = A._steers_for(many, lab=False)
check("<=3 colors enforced", len(s_many) <= 3, f"{len(s_many)} steers")

# judge readout on a smoke output if present
import glob  # noqa: E402
wavs = sorted(glob.glob(os.path.join(HERE, "_sa3_smoke_out", "*.wav")))
if wavs:
    import quality_readout as qr  # noqa: E402
    r = qr.analyze_wav(wavs[0])
    check("quality readout pq+flags", 0 <= r["pq"] <= 10 and isinstance(r["flags"], list),
          f"{os.path.basename(wavs[0])} pq={r['pq']}")
else:
    print("[skip] no smoke wavs to score")

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}")
sys.exit(1 if fails else 0)
