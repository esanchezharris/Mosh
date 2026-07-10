#!/usr/bin/env python3
"""EXPERIMENT (not committed): render his real-words-anchored lyric, lined up to his take.

Owner asked to judge by EAR: re-sing the words, overlay on the raw take, hear what lines up.
Pipeline (runs under the SoulX bridge venv — RMVPE f0 + torch):
  1. RMVPE F0 of the take (per-word pitch).
  2. Interleave his FILLED lyric (sheet-realwords.json) with the FORCED-ALIGNED real-word
     timing (aligned-realwords.json): real words at their aligned spans; fill words distributed
     evenly in the gap between the bracketing real words. Per-word syllable slots pitched from F0.
  3. Voicing-clamp (resing_score) so nothing sings in his silence, author ONE score.
  4. Author a CLEAN ≤9s voice prompt from THIS take (author_prompt), render score-mode.
Outputs to <out>/: target_score.json, prompt.*, render/generated.wav.
"""
import json
import os
import subprocess
import sys
import re

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

import hybrid_render_run as hr           # extract_f0_hz (RMVPE)
import resing_score as rs
from skeleton import align, core as skcore
from soulx import score as sx
from phonology import core as ph

OUT = "/Users/emiliosanchez-harris/mosh-fms-ksb/resing-dominio"
TAKE = "/Users/emiliosanchez-harris/mosh-fms-ksb/resing-dominio/listen/take-134-section-0-63s.wav"
SHEET134 = "/Users/emiliosanchez-harris/mosh-fms-ksb/resynth-v0/sheet.json"   # take's decoded sheet (for the prompt)
BRIDGE = hr.BRIDGE
VENV_PY = hr.VENV_PY
MODEL = hr.MODEL
PHONESET = hr.PHONESET
pron = ph.Pronouncer()


def clean(w):
    return re.sub(r"[^a-z']", "", w.lower())


def syl(w):
    c = clean(w)
    return max(1, pron.syllables(c) or 1) if c else 1


def main():
    os.makedirs(OUT, exist_ok=True)
    aligned = json.load(open(os.path.join(OUT, "aligned-realwords.json")))
    filled = json.load(open(os.path.join(OUT, "sheet-realwords.json")))

    print("1) RMVPE F0 of the take …", flush=True)
    f0hz = hr.extract_f0_hz(TAKE)                       # Hz per 20ms
    f0 = [{"t": i * 0.02, "hz": v} for i, v in enumerate(f0hz)]
    print(f"   {len(f0)} f0 frames ({len(f0)*0.02:.1f}s)")

    print("2) interleave real (aligned) + fills, build per-word slots …", flush=True)
    # flat word sequence from his filled lyric, greedy-matched to the aligned real words
    seq = []                                            # (word, aligned|None)
    ptr = 0
    for line in filled["lines"]:
        txt = (line.get("text") or line.get("seedText") or "")
        for w in txt.split():
            cw = clean(w)
            if not cw:
                continue
            if ptr < len(aligned) and cw == clean(aligned[ptr]["word"]):
                seq.append((w, aligned[ptr]))
                ptr += 1
            else:
                seq.append((w, None))
    matched = sum(1 for _, a in seq if a)
    print(f"   {len(seq)} words, {matched} matched to aligned real words (of {len(aligned)})")

    # assign times to fills: even split of the gap between bracketing real words
    times = [None] * len(seq)
    for i, (w, a) in enumerate(seq):
        if a:
            times[i] = (float(a["start"]), float(a["end"]))
    i = 0
    while i < len(seq):
        if times[i] is not None:
            i += 1
            continue
        j = i
        while j < len(seq) and times[j] is None:
            j += 1
        # gap run seq[i:j] between prev real end and next real start
        lo = times[i - 1][1] if i > 0 and times[i - 1] else (times[i][0] if i < len(seq) and times[i] else 0.0)
        hi = times[j][0] if j < len(seq) and times[j] else (lo + 0.4 * (j - i))
        if hi <= lo:
            hi = lo + 0.25 * (j - i)
        step = (hi - lo) / (j - i)
        for k in range(i, j):
            times[k] = (lo + (k - i) * step, lo + (k - i + 1) * step)
        i = j

    # per-word syllable slots pitched from F0
    slots, words = [], []
    for (w, a), (s, e) in zip(seq, times):
        e = max(e, s + 0.06)
        slots.extend(align.slots_for_word(s, e, syl(w), f0=f0))
        words.append(w)
    lineScore = {"v": 1, "algo": "align", "bar": 0, "bpm": 134.0, "timeSig": [4, 4],
                 "grid": "1/16", "clamped": False, "slots": slots}
    sheet = {"lines": [{"text": " ".join(words), "origin": "generated"}], "lineScores": [lineScore]}

    print("3) voicing-clamp + author ONE score …", flush=True)
    pcm = skcore.read_pcm_mono(TAKE)
    env = skcore.energy_envelope(pcm[0], pcm[1])
    res = rs.author_resing_score(sheet, env=env, hop_s=0.01, name="resing134")
    if not res.get("ok"):
        print("FATAL score:", res.get("error")); return 1
    json.dump(res["score"], open(os.path.join(OUT, "target_score.json"), "w"))
    print(f"   {res['events']} events, {res['words']} words, {res['rests']} rests, "
          f"{res.get('slotsDropped',0)} dropped; clip {res['score'][0]['time']}")

    print("4) author a clean ≤9s voice prompt from THIS take …", flush=True)
    slice9 = os.path.join(OUT, "prompt-slice.wav")
    hr.slice_wav(TAKE, slice9, 0.0, 9.0, sr_out=44100)
    pj, pw = os.path.join(OUT, "prompt.json"), os.path.join(OUT, "prompt.wav")
    r = subprocess.run([VENV_PY, os.path.join(HERE, "author_prompt.py"),
                        "--sheet", SHEET134, "--slice", slice9, "--t-start", "0", "--dur", "9",
                        "--out-json", pj, "--out-wav", pw], cwd=BRIDGE,
                       env=dict(os.environ, PYTHONPATH=BRIDGE, PYTORCH_ENABLE_MPS_FALLBACK="1"))
    if r.returncode != 0:
        print("FATAL prompt author"); return 1

    print("5) render score-mode in his voice …", flush=True)
    rdir = os.path.join(OUT, "render")
    os.makedirs(rdir, exist_ok=True)
    r = subprocess.run([VENV_PY, os.path.join(BRIDGE, "scripts/inference_mlx_bridge.py"),
                        "--model", MODEL, "--component", "svs", "--control", "score", "--device", "mps",
                        "--prompt_wav_path", pw, "--prompt_metadata_path", pj,
                        "--target_metadata_path", os.path.join(OUT, "target_score.json"),
                        "--phoneset_path", PHONESET, "--n_steps", "32", "--cfg", "3",
                        "--pitch_shift", "0", "--save_dir", rdir], cwd=BRIDGE,
                       env=dict(os.environ, PYTHONPATH=BRIDGE, PYTORCH_ENABLE_MPS_FALLBACK="1"))
    if r.returncode != 0:
        print("FATAL render"); return 1
    print(f"done -> {rdir}/generated.wav")
    return 0


if __name__ == "__main__":
    sys.exit(main())
