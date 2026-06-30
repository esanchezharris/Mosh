#!/usr/bin/env python3
"""Gated SA3 candidate generation — generate trap/lofi loops with Stable Audio 3.

Per the v2 plan, SA3 is a gated source: attempt it, but SKIP GRACEFULLY (logged) if the MLX venv /
weights / adapter aren't wired in this worktree, rather than blocking the probe. Returns AUDIO
candidates ({kind:"audio", wav}) or [] if unavailable.
"""
from __future__ import annotations

import os
from pathlib import Path

PROMPTS = [
    "dark trap beat, hard 808, crisp hats, 140 bpm",
    "lofi hip hop, warm keys, dusty drums, 85 bpm",
    "melodic trap, bright bells, rolling hats, 150 bpm",
    "west coast bounce, g-funk lead, 92 bpm",
    "ambient lofi, mellow chords, vinyl crackle, 80 bpm",
    "atlanta trap, aggressive 808 glides, 145 bpm",
]


def available() -> tuple[bool, str]:
    if not Path(os.path.expanduser("~/AI/stable-audio-3")).is_dir():
        return False, "no ~/AI/stable-audio-3 weights dir"
    try:
        import mlx  # noqa: F401
    except Exception:
        return False, "MLX not importable in this venv (SA3 MLX path not wired here)"
    try:
        from teardown.sa3 import engine  # noqa: F401
    except Exception as e:
        return False, f"sa3 engine import failed: {type(e).__name__}"
    return True, "ok"


def build_sa3(n_target: int = 12) -> list[dict]:
    ok, why = available()
    if not ok:
        print(f"  [sa3] SKIPPED (gated): {why}. v2 proceeds with gold/auto/degraded; SA3 is a fast-follow.")
        return []
    # Wired path (not exercised in this worktree): generate via the SA3 engine → 44.1k mono WAVs.
    try:
        from teardown.sa3 import engine
        out, asset = [], Path(__file__).resolve().parent / ".assets" / "sa3"
        asset.mkdir(parents=True, exist_ok=True)
        for i, p in enumerate(PROMPTS[: n_target]):
            wav = str(asset / f"sa3_{i:02d}.wav")
            engine.render(prompt=p, seconds=10, out_wav=wav)  # adapter contract; exact sig may vary
            out.append({"cand_id": f"sa3_{i:02d}", "group": f"sa3_{i:02d}", "label": "sa3",
                        "intent": "sa3", "kind": "audio", "wav": wav, "meta": {"prompt": p}})
        return out
    except Exception as e:
        print(f"  [sa3] generation failed mid-run ({type(e).__name__}: {str(e)[:120]}) → skipping SA3")
        return []


if __name__ == "__main__":
    print("available:", available())
    print("n:", len(build_sa3()))
