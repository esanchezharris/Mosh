#!/usr/bin/env python3
"""Smoke gate: does the GRPO loop get a REAL, non-degenerate audio-reward gradient — and is it a
MUSICAL gradient or merely a renderability one?

grpo.py zeros a group's advantage when reward std < 1e-6, so a gradient needs within-group reward
variance. But that variance has TWO sources, and they are NOT equivalent:
  • RENDERABILITY variance — rollouts that render (reward>0) vs rollouts that defer/render-fail
    (reward 0). This teaches "emit a renderable program," NOT musical taste.
  • MUSICAL-MARGIN variance — ≥2 SUCCESSFUL (reward>0) rollouts in a group with DIFFERENT rewards.
    This is the edit-quality signal the learned reward exists to provide.
An honest PASS must not mislabel a renderability-only gradient as a musical one.

  verify_audio_gradient.py --log grpo.log --work <grpo --out>/_work/audio [--expect-musical]

Gate (all hard):
  g0  if --expect-musical (or MOSH_RL_REWARD_MODE=musical): the log MUST show the composite reward
      activated ("ACTIVATED composite reward") — else the run scored on FLOOR-only (clean·pq), not the
      learned reward, and we refuse to call it a real-reward gradient.
  g1  reward μ > 0 on ≥1 step.
  g2  signal in ≥2 groups total across steps (not one lucky group).
  g3  non-silent floor: ≥1 rendered WAV rms>1e-3, peak<0.999 (read errors FAIL, not silently skip).
Reported (honest label, NOT auto-pass): MUSICAL-margin groups (≥2 distinct positive rewards). If 0,
the verdict says "renderability-dominated — NOT yet a musical-taste gradient."

Exit 0 = gate PASS, 1 = FAIL, 2 = could not evaluate.
"""
from __future__ import annotations

import argparse
import collections
import glob
import json
import os
import re
import sys

# signed floats (μ can go negative the instant reward shaping adds a penalty/centering term)
STEP_RE = re.compile(r"reward μ=(-?\d+(?:\.\d+)?)\s+def=(-?\d+(?:\.\d+)?)\s+signal=(\d+)/(\d+)")
SCORE_RE = re.compile(r"(\d+)\s+rendered,\s+(\d+)\s+cache-hit,\s+(\d+)\s+render-fail")
ACT_RE = re.compile(r"ACTIVATED composite reward")


def read_rms(path: str):
    """Mono RMS + peak. soundfile (handles 16/24/32-bit + float — the bit depths Mosh exports),
    wave fallback for 8/16-bit. Returns None on a read error (caller treats that as a FAIL, never
    a silent skip)."""
    try:
        import numpy as np
        import soundfile as sf
        y, _ = sf.read(path, dtype="float32", always_2d=True)
        if y.size == 0:
            return 0.0, 0.0
        y = y.mean(axis=1)
        return float(np.sqrt(np.mean(y ** 2))), float(np.max(np.abs(y)))
    except Exception:
        pass
    import wave
    import struct
    try:
        with wave.open(path, "rb") as w:
            n, sw, ch = w.getnframes(), w.getsampwidth(), w.getnchannels()
            raw = w.readframes(n)
        if n == 0:
            return 0.0, 0.0
        if sw != 2:
            return None  # unknown bit depth and soundfile unavailable → cannot judge
        cnt = len(raw) // 2
        vals = struct.unpack("<%dh" % cnt, raw[: cnt * 2])
        if ch > 1:
            vals = vals[::ch]
        if not vals:
            return 0.0, 0.0
        return (sum(v * v for v in vals) / len(vals)) ** 0.5 / 32768.0, max(abs(v) for v in vals) / 32768.0
    except Exception:
        return None


def musical_decomposition(work: str):
    """Group the LAST step's per-rollout rewards (rewards.partial.jsonl, sampleId = step_prompt_group)
    and split within-group variance into musical-margin vs renderability-only. Returns
    (musical_groups, renderability_groups, novar_groups, detail) or None if unavailable."""
    p = os.path.join(work, "rewards.partial.jsonl") if work else ""
    if not p or not os.path.exists(p):
        return None
    try:
        rows = [json.loads(l) for l in open(p) if l.strip()]
    except Exception:
        return None
    # delta-reward subtracts the seed (feedback starts with "delta"/"seed_"), so within-group SPREAD
    # is itself edit-quality — there is no seed-banking floor to discount.
    is_delta = any(str(r.get("feedback", "")).startswith(("delta", "seed_render_fail")) for r in rows)
    groups = collections.defaultdict(list)
    for r in rows:
        parts = str(r.get("sampleId", "")).split("_")
        key = tuple(parts[:2]) if len(parts) >= 2 else (r.get("sampleId"),)
        groups[key].append(round(float(r.get("reward", 0.0)), 4))
    # a MEANINGFUL edit-quality margin, not rounding noise (0.4366 vs 0.437 is NOT a musical signal)
    MUSICAL_MARGIN = 0.02
    musical = renderability = novar = 0
    detail = []
    for k, rewards in sorted(groups.items()):
        all_spread = (max(rewards) - min(rewards)) if rewards else 0.0
        if is_delta:
            # every delta reward is (edit − seed); a within-group spread = the policy's edits differ in quality
            if all_spread > MUSICAL_MARGIN:
                musical += 1; tag = "MUSICAL(delta)"
            else:
                novar += 1; tag = "no-var"
        else:
            pos = [x for x in rewards if x > 0]
            pos_spread = (max(pos) - min(pos)) if len(pos) >= 2 else 0.0
            if pos_spread > MUSICAL_MARGIN:
                musical += 1; tag = "MUSICAL"
            elif all_spread > 1e-6:
                renderability += 1; tag = "renderability-only"
            else:
                novar += 1; tag = "no-var"
        detail.append(f"    {'_'.join(k)}: {sorted(rewards)} → {tag}")
    return musical, renderability, novar, "\n".join(detail)


def main() -> int:
    ap = argparse.ArgumentParser(description="GRPO audio-gradient smoke gate (musical vs renderability honest)")
    ap.add_argument("--log", required=True)
    ap.add_argument("--work", default="", help="audio work dir (<grpo --out>/_work/audio)")
    ap.add_argument("--expect-musical", action="store_true",
                    help="require the composite reward to have activated (default also on if MOSH_RL_REWARD_MODE=musical)")
    a = ap.parse_args()
    expect_musical = a.expect_musical or os.environ.get("MOSH_RL_REWARD_MODE") == "musical"

    text = open(a.log, errors="replace").read() if os.path.exists(a.log) else ""
    steps = [(float(m[0]), float(m[1]), int(m[2]), int(m[3])) for m in STEP_RE.findall(text)]
    scores = [(int(m[0]), int(m[1]), int(m[2])) for m in SCORE_RE.findall(text)]
    activated = bool(ACT_RE.search(text))

    if not steps:
        print("  ✖ no step lines parsed from the log — grpo did not complete a step", file=sys.stderr)
        return 2

    max_mu = max(s[0] for s in steps)
    signal_groups_total = sum(s[2] for s in steps)
    rendered = sum(s[0] for s in scores)
    cache_hits = sum(s[1] for s in scores)
    fails = sum(s[2] for s in scores)

    # floor (hard): ≥1 non-silent WAV; a read error is a FAIL, not a skip
    floor_ok, floor_detail = None, "no work dir given"
    if a.work and os.path.isdir(a.work):
        wavs = sorted(glob.glob(os.path.join(a.work, "*.wav")))
        reads = [(os.path.basename(p), read_rms(p)) for p in wavs]
        errors = [n for n, r in reads if r is None]
        good = [(n, r[0], r[1]) for n, r in reads if r is not None and r[0] > 1e-3 and r[1] < 0.999]
        if errors:
            floor_ok, floor_detail = False, f"{len(errors)}/{len(wavs)} WAVs UNREADABLE (cannot judge floor)"
        else:
            floor_ok = len(good) > 0
            floor_detail = f"{len(good)}/{len(wavs)} non-silent" + (f" (e.g. {good[0][0]} rms={good[0][1]:.4f})" if good else "")

    decomp = musical_decomposition(a.work)

    print("── GRPO audio-gradient smoke gate ──")
    print(f"  reward = {'composite (REAL, activated)' if activated else 'FLOOR-ONLY (composite head NOT activated)'}"
          + (f"   [--expect-musical: {'satisfied' if activated else 'VIOLATED'}]" if expect_musical else ""))
    print(f"  steps: {len(steps)}  | per-step (μ, def, signal/G):")
    for i, (mu, df, sig, g) in enumerate(steps, 1):
        print(f"    step {i}: μ={mu:.3f} def={df:.2f} signal={sig}/{g}")
    print(f"  signal groups (total across steps): {signal_groups_total}")
    print(f"  renders: {rendered} rendered, {cache_hits} cache-hit, {fails} render-fail")
    print(f"  floor: {floor_detail}")
    if decomp is not None:
        m, rr, nv, det = decomp
        print(f"  within-group variance decomposition (last step):  MUSICAL={m}  renderability-only={rr}  no-var={nv}")
        print(det)

    # ── gate (all hard) ──────────────────────────────────────────────────────────────────
    g0 = (not expect_musical) or activated
    g1 = max_mu > 0.0
    g2 = signal_groups_total >= 2
    g3 = floor_ok is True
    print("\n  GATE:")
    if expect_musical:
        print(f"    [{'PASS' if g0 else 'FAIL'}] (0) composite reward activated (--expect-musical)")
    print(f"    [{'PASS' if g1 else 'FAIL'}] (1) reward μ > 0            (max μ = {max_mu:.3f})")
    print(f"    [{'PASS' if g2 else 'FAIL'}] (2) signal in ≥2 groups     (total = {signal_groups_total})")
    print(f"    [{'PASS' if g3 else 'FAIL'}] (3) non-silent floor        ({floor_detail})")
    gate = g0 and g1 and g2 and g3

    # honest LABEL of what the gradient actually is (not an auto-pass term)
    musical_label = ""
    if decomp is not None:
        m = decomp[0]
        if m >= 1:
            musical_label = f" — includes a MUSICAL-margin signal in {m} group(s)"
        else:
            musical_label = " — ⚠ RENDERABILITY-DOMINATED: every successful render scored ~equal; the " \
                            "variance is emit-vs-fail, NOT edit quality. This is NOT yet a musical-taste gradient."
    print(f"\n  → GATE {'PASS' if gate else 'FAIL'} — non-degenerate gradient{musical_label}")
    return 0 if gate else 1


if __name__ == "__main__":
    raise SystemExit(main())
