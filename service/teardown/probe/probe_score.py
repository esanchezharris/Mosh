#!/usr/bin/env python3
"""Render a candidate program through the real engine and score it with the ACTIVATED §12
composite reward, returning the components SEPARATELY ({pq, clean, pull, composite}).

This is the decomposition scorer the plan calls for: unlike the GRPO `score_audio_cli` (which
emits only the gated scalar `reward`), the probe must see pull/pq/clean apart so we can ask
which term tracks the owner's ears. Reuses `teardown.oracle.Oracle` (→ `Mosh --run-script`),
`make_reward()` (the validated composite head), and the SAME `loudness_normalize` the reward
applies internally — so the WAV handed to the owner is exactly what the reward judged.

Importable: `make_engine()` → (oracle, reward); `render_and_score(oracle, reward, program)` →
dict (with the rendered float32 mono array under "y" for the pack writer to normalize+write).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import numpy as np

SE = Path(__file__).resolve().parents[3]  # …/worktrees/<wt>
if str(SE / "service") not in sys.path:
    sys.path.insert(0, str(SE / "service"))

os.environ.setdefault("MOSH_BIN", "/Applications/Mosh.app/Contents/MacOS/Mosh")


def make_engine(range_s: float = 10.0, timeout_s: int = 180):
    from teardown.oracle.render import Oracle
    from teardown.flywheel.grpo_bridge import make_reward
    reward, info = make_reward()
    if not info.get("has_pull"):
        raise SystemExit(f"[probe] composite head unavailable ({info}) — the probe requires the "
                         f"REAL pull. Install the MuQ venv + composite_reward.pt. Aborting.")
    oracle = Oracle(scorer=object(), range_s=range_s, timeout_s=timeout_s)
    if not oracle.available():
        raise SystemExit(f"[probe] Mosh binary not found at {oracle.bin} (set MOSH_BIN). Aborting.")
    return oracle, reward, info


def render_and_score(oracle, reward, program: list, session: str = "probe") -> dict:
    """Render → score → return {ok, pq, clean, pull, composite, rms, peak, y, sr} or {ok:False,error}."""
    os.environ["MOSH_SELFTEST_SESSION"] = session
    try:
        y, sr = oracle.render([dict(c) for c in program])
    except Exception as e:  # render stalled / source unreadable / binary error
        return {"ok": False, "error": f"render_fail: {str(e)[:160]}"}
    y = np.asarray(y, dtype=np.float32)
    scores = reward.score_audio(y, sr)
    comp = reward.composite(scores)
    return {
        "ok": True, "y": y, "sr": sr,
        "pq": round(float(scores.get("pq", 0.0)), 4),
        "clean": round(float(scores.get("clean", 1.0)), 4),
        "pull": round(float(scores["pull"]), 6) if "pull" in scores else None,
        "composite": round(float(comp), 6),
        "rms": round(float(np.sqrt((y ** 2).mean())), 5),
        "peak": round(float(np.abs(y).max()), 5),
    }


def normalize_for_listening(reward, y: np.ndarray, sr: int) -> np.ndarray:
    """Loudness-normalize EXACTLY as the reward does internally (same target RMS + peak ceiling),
    so the owner rates the same signal the reward scored — loudness can't bias either."""
    from teardown.oracle.score import loudness_normalize
    return loudness_normalize(np.asarray(y, dtype=np.float32), sr, reward.target_rms_dbfs)


if __name__ == "__main__":
    # smoke: score a single known-good tight loop and print the decomposition
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from samples import catalog
    from variator import build_candidates
    oracle, reward, info = make_engine()
    print("reward:", info)
    cands = build_candidates(catalog(), None)
    tight = next(c for c in cands if c["label"] == "tight")
    r = render_and_score(oracle, reward, tight["program"], session="probe_smoke")
    print(tight["cand_id"], {k: v for k, v in r.items() if k != "y"})
    if r["ok"]:
        r2 = render_and_score(oracle, reward, tight["program"], session="probe_smoke2")
        same = all(abs(r[k] - r2[k]) < 1e-9 for k in ("pq", "clean", "pull", "composite"))
        print("re-render+score identical:", same)
