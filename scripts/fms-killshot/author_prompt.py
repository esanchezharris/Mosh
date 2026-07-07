#!/usr/bin/env python3
"""Author a clean SVS prompt (voice enrollment) from a decoded sheet + a clean voice slice.

Replaces the stale/contaminated own-10s prompt with a self-derived one, entirely on the Mac
(no GPU preprocess). The SVS prompt metadata is the exact shape own-10s.json had — index /
language / time / duration / text / phoneme / note_pitch / note_type / f0 — which is exactly
soulx.score.author_score's clip PLUS the RMVPE f0 (50fps) melody-mode also reads.

  bridge-venv-python author_prompt.py --sheet <decoded sheet.json> --slice <clean.wav> \
      --t-start T0 --dur D --out-json prompt.json --out-wav prompt.wav

Runs under the SoulX bridge venv (RMVPE f0 + g2p phonemes via phonology.core).
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

import hybrid_render_run as hr  # window_sheet + extract_f0_hz  # noqa: E402
from soulx import score as sx  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sheet", required=True, help="decoded sheet.json of the voice take")
    ap.add_argument("--slice", required=True, help="the clean voice slice wav (== [t-start, t-start+dur])")
    ap.add_argument("--t-start", type=float, required=True)
    ap.add_argument("--dur", type=float, required=True)
    ap.add_argument("--out-json", required=True)
    ap.add_argument("--out-wav", required=True)
    ap.add_argument("--fps", type=int, default=50)
    a = ap.parse_args()

    sheet = hr.window_sheet(json.load(open(a.sheet)), a.t_start, a.t_start + a.dur)
    by = {l["index"]: sc for l, sc in zip(sheet["lines"], sheet["lineScores"])}
    lines = [{"text": (l.get("text") or l.get("seedText") or "").replace("_", "").strip() or "la",
              "score": by.get(l["index"])}
             for l in sheet["lines"] if by.get(l["index"])]
    if not lines:
        print("FATAL: no scored lines in the window", file=sys.stderr)
        return 1
    r = sx.author_score(lines, name="prompt")
    if not r.get("ok"):
        print(f"FATAL author: {r.get('error')}", file=sys.stderr)
        return 1
    clip = r["score"][0]

    print("extracting RMVPE f0 for the prompt slice …", flush=True)
    f0 = hr.extract_f0_hz(os.path.abspath(a.slice))
    n = round(clip["time"][1] / 1000 * a.fps)
    f0 = [float(x) for x in f0[:n]] + [0.0] * max(0, n - len(f0))
    clip["f0"] = " ".join(f"{x:.1f}" for x in f0)

    json.dump([clip], open(a.out_json, "w"))
    shutil.copyfile(a.slice, a.out_wav)
    words = clip["text"].split()
    print(f"prompt -> {a.out_json}  ({r['events']} events, {r['words']} words, {n} f0 frames)")
    print(f"   text: {' '.join(w for w in words if w != '<SP>')[:80]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
