#!/usr/bin/env python3
"""Hermetic test for §8 — the optimizer + objective against a SYNTHETIC synth (stands in for
the real hosted-synth render, which needs the binary + Serum/Vital). Proves perceptual
matching converges, refine beats the seed, substitute picks the nearest preset, deterministic.

    python3 service/teardown/synthmatch/synthmatch_test.py   (needs numpy/librosa via §6 scorer)
"""
import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(os.path.dirname(_HERE))
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

from teardown.oracle import EmbeddingScorer  # noqa: E402  (the §6 objective)
from teardown.synthmatch import match_patch, substitute  # noqa: E402

SR = 44100
fails: list[str] = []


def check(name, cond, extra=""):
    if cond:
        print(f"  ok   {name}")
    else:
        fails.append(name)
        print(f"  FAIL {name}" + (f"  [{extra}]" if extra else ""))


class ToySynth:
    """params {cutoff, decay} → an additive-saw tone (brightness ← cutoff, env ← decay).
    Stands in for a real hosted-synth render; the engineered embedder is sensitive to both."""

    def render(self, params):
        t = np.arange(SR) / SR  # 1 s
        f0 = 220.0
        cutoff = float(np.clip(params["cutoff"], 0, 1))
        decay = float(np.clip(params["decay"], 0, 1))
        n_harm = max(1, int(1 + cutoff * 40))
        y = np.zeros_like(t)
        for k in range(1, n_harm + 1):
            if k * f0 < 20000:
                y += (1.0 / k) * np.sin(2 * np.pi * k * f0 * t)
        y = (y * np.exp(-t / (0.03 + decay * 0.8))).astype(np.float32)
        m = float(np.max(np.abs(y)))
        return (y / m if m > 0 else y), SR


synth = ToySynth()
scorer = EmbeddingScorer()
TGT = {"cutoff": 0.6, "decay": 0.3}
target = synth.render(TGT)

# seed (box-centre) distance vs optimized distance
seed_y, seed_sr = synth.render({"cutoff": 0.5, "decay": 0.5})
d_seed = scorer.score((seed_y, seed_sr), target)
res = match_patch(target, synth, scorer, ["cutoff", "decay"], [(0, 1), (0, 1)],
                  iters=40, popsize=8, seed=0)
check("optimizer reaches a near-perfect perceptual match", res["distance"] < 0.05, f"d={res['distance']}")
check("refine beats the seed", res["distance"] < d_seed, f"opt={res['distance']} seed={d_seed:.4f}")
check("history is monotonically non-increasing", all(res["history"][i] >= res["history"][i + 1]
                                                     for i in range(len(res["history"]) - 1)))

# batched eval (the live render-in-the-loop path) must match per-individual eval exactly:
# same seed, same ES math, just a whole generation rendered per call.
batch_render = lambda dicts: [synth.render(d) for d in dicts]  # noqa: E731
res_seq = match_patch(target, synth, scorer, ["cutoff", "decay"], [(0, 1), (0, 1)],
                      iters=20, popsize=6, seed=3)
res_batch = match_patch(target, renderer=None, scorer=scorer, param_names=["cutoff", "decay"],
                        bounds=[(0, 1), (0, 1)], iters=20, popsize=6, seed=3,
                        batch_render=batch_render)
check("batched eval == per-individual eval (same seed)",
      res_batch["params"] == res_seq["params"] and res_batch["distance"] == res_seq["distance"],
      f"batch={res_batch['distance']} seq={res_seq['distance']}")

# substitute: nearest preset is the exact one
presets = [{"cutoff": 0.1, "decay": 0.1}, {"cutoff": 0.6, "decay": 0.3}, {"cutoff": 0.95, "decay": 0.9}]
sub = substitute(target, synth, scorer, presets)
check("substitute picks the matching preset", sub["preset_index"] == 1, str(sub))
check("substitute distance is tiny for the exact preset", sub["distance"] < 0.02, f"d={sub['distance']}")

# determinism
runs = {match_patch(target, synth, scorer, ["cutoff", "decay"], [(0, 1), (0, 1)], iters=20, seed=0)["distance"]
        for _ in range(3)}
check("match_patch deterministic x3 (fixed seed)", len(runs) == 1)

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
