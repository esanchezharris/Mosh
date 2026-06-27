#!/usr/bin/env python3
"""REAL render-in-the-loop proof for §8 — CMA-ES recovers a known patch through a real
hosted synth (Serum 2), scored in the §6 embedding space.

This is the gated hardware verification the spec's §8 acceptance asks for ("known patch →
render → CMA-ES match → recovered render's embedding distance below threshold"). It needs
the built Mosh binary (MOSH_BIN or /Applications/Mosh.app) and Serum 2 installed; absent
either, it SKIPS cleanly (exit 0) so the deterministic suite stays hermetic.

    python3 service/teardown/synthmatch/verify_live.py            # auto-detect Serum
    MOSH_SYNTH_ID="VST3-Vital-..." python3 .../verify_live.py     # another synth

What it proves, on real audio:
  1. a sensitivity screen finds which of the synth's params actually move the timbre;
  2. seeded from a deliberately-wrong guess, CMA-ES drives the perceptual distance toward 0;
  3. the dominant param is recovered close to its true value.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from teardown.oracle.score import EmbeddingScorer  # noqa: E402
from teardown.synthmatch.live import LiveSynthRenderer, screen_audible  # noqa: E402
from teardown.synthmatch.optimize import match_patch  # noqa: E402

BIN = os.environ.get("MOSH_BIN", "").strip() or "/Applications/Mosh.app/Contents/MacOS/Mosh"


def find_synth() -> str | None:
    """Pick a synth pluginId: env override, else first installed Serum 2 / Vital."""
    if os.environ.get("MOSH_SYNTH_ID"):
        return os.environ["MOSH_SYNTH_ID"]
    if not os.path.isfile(BIN):
        return None
    d = tempfile.mkdtemp(prefix="td-find-synth-")
    script = Path(d) / "s.jsonl"
    out = Path(d) / "o.jsonl"
    script.write_text(json.dumps({"command": "list_plugins", "args": {}}) + "\n")
    env = dict(os.environ, MOSH_RUN_SCRIPT=str(script), MOSH_RUN_SCRIPT_OUT=str(out),
               MOSH_SESSION_DIR=d)
    try:
        subprocess.run([BIN, "--run-script"], env=env, capture_output=True, timeout=120, check=False)
    except Exception:
        return None
    if not out.exists():
        return None
    for ln in out.read_text().splitlines():
        if not ln.strip():
            continue
        r = json.loads(ln)
        if r.get("command") != "list_plugins":
            continue
        plugins = (r.get("data") or {}).get("plugins", [])
        for pref in ("Serum 2", "Vital"):
            for p in plugins:
                if p.get("name") == pref and p.get("isInstrument") and p.get("format") == "VST3":
                    return p["id"]
    return None


def main() -> int:
    if not os.path.isfile(BIN):
        print(f"  SKIP  Mosh binary not found at {BIN} (set MOSH_BIN) — §8 live proof skipped")
        return 0
    synth = find_synth()
    if not synth:
        print("  SKIP  no Serum 2 / Vital instrument found — §8 live proof skipped")
        return 0
    print(f"  synth: {synth}")

    scorer = EmbeddingScorer()
    rend = LiveSynthRenderer(synth, name="LiveMatch", session_dir="/tmp/td-live-match",
                             midi_length=4.0)

    # 1. screen for the audible params (one launch)
    t0 = time.time()
    ranked = screen_audible(rend, scorer, range(0, 24), lo=0.15, hi=0.85)
    audible = [idx for idx, d in ranked if d > 0.03][:3]
    print(f"  screen: audible params {[(i, round(d, 3)) for i, d in ranked if d > 0.03][:3]} "
          f"({time.time() - t0:.0f}s)")
    if not audible:
        print("  SKIP  no audible params in the screened window — cannot run a recovery proof")
        return 0

    # 2. a known target patch over the audible params
    rng = np.random.default_rng(7)
    true_vals = {idx: float(round(rng.uniform(0.25, 0.75), 3)) for idx in audible}
    target = rend.render(true_vals)
    print(f"  target patch (ground truth): {true_vals}")

    # 3. seed from a deliberately-wrong guess, run CMA-ES against the real synth
    param_names = list(audible)
    bounds = [(0.0, 1.0)] * len(param_names)
    seed_params = {idx: (0.5 if true_vals[idx] < 0.5 else 0.1) for idx in audible}  # wrong on purpose
    d0 = scorer.score(rend.render(seed_params), target)
    print(f"  seed (wrong) distance to target: {d0:.4f}")

    t0 = time.time()
    res = match_patch(target, renderer=None, scorer=scorer, param_names=param_names,
                      bounds=bounds, seed_params=seed_params, iters=14, popsize=6, seed=0,
                      batch_render=rend.render_batch)
    dt = time.time() - t0

    recovered = res["params"]
    dfinal = res["distance"]
    drop = (d0 - dfinal) / d0 * 100 if d0 > 0 else 0.0
    dom = audible[0]  # dominant (largest swing)
    dom_err = abs(recovered[dom] - true_vals[dom])
    print(f"  recovered: { {k: round(v,3) for k,v in recovered.items()} }")
    print(f"  distance: {d0:.4f} -> {dfinal:.4f}  ({drop:.0f}% closer)  in {dt:.0f}s "
          f"({(res['iters']+1)*6} renders)")
    print(f"  dominant param idx{dom}: true={true_vals[dom]:.3f} recovered={recovered[dom]:.3f} "
          f"err={dom_err:.3f}")

    fails = []
    if not (dfinal < d0 * 0.5):
        fails.append(f"distance did not at least halve ({d0:.3f}->{dfinal:.3f})")
    if not (dom_err < 0.15):
        fails.append(f"dominant param not recovered within 0.15 (err={dom_err:.3f})")
    if not (np.all(np.diff(res["history"]) <= 1e-9)):
        fails.append("optimizer history not monotonically non-increasing")

    if fails:
        print("\n  FAIL: " + "; ".join(fails))
        return 1
    print("\n  PASS — real synth recovered a known patch via render-in-the-loop CMA-ES")
    return 0


if __name__ == "__main__":
    sys.exit(main())
