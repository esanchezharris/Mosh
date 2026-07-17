#!/usr/bin/env python3
"""Forced-alignment word-recovery ruler — a SINGING-CAPABLE replacement for Whisper's
`word_match` on sung content.

Whisper cannot transcribe slow sustained singing (found 1 word in a clean edelweiss slice),
so its bag/seq word_match is a broken ruler for the benchmark's word axis. MMS forced
alignment instead aligns the KNOWN words to the audio and returns a per-word acoustic score
— it works on singing. Validated: JLEE clean aligns 0.377 (62% words >0.3) vs mumbled 0.163
(15%), a clean 2.3× separation.

`word_align_score(wav, words)` converts the wav to stdlib-readable PCM16, runs align_probe
(skeleton venv / MMS_FA), and aggregates mean score + hit-fraction. Pure aggregation
(`aggregate_alignment`) is golden-tested; the alignment itself is impure (venv/model).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SKELETON_PY = os.path.expanduser(
    os.environ.get("SKELETON_PY", "~/Library/Mosh/venvs/skeleton/bin/python3"))
HIT = 0.3   # per-word alignment score above which a word counts as "recovered"


def aggregate_alignment(per_word, hit=HIT):
    """[{word,start,end,score}] → {mean_score, hit_frac, n}. Pure."""
    s = [float(w["score"]) for w in per_word if "score" in w]
    if not s:
        return {"mean_score": None, "hit_frac": None, "n": 0}
    return {"mean_score": round(sum(s) / len(s), 3),
            "hit_frac": round(sum(1 for x in s if x > hit) / len(s), 3),
            "n": len(s)}


def _to_pcm16(src):
    """align_probe reads stdlib PCM16; SoulX/mumble wavs are often float — convert."""
    import numpy as np
    import soundfile as sf
    y, sr = sf.read(src)
    if getattr(y, "ndim", 1) > 1:
        y = y.mean(axis=1)
    fd, tmp = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    sf.write(tmp, np.asarray(y, dtype=np.float32), sr, subtype="PCM_16")
    return tmp


def align_words(wav, words):
    """Run align_probe (MMS_FA, skeleton venv) → [{word,start,end,score}] or []."""
    if not os.path.isfile(SKELETON_PY):
        return []
    fd, wf = tempfile.mkstemp(suffix=".json")
    os.close(fd)
    pcm = None
    try:
        with open(wf, "w") as f:
            json.dump([w for w in words if w and w.strip()], f)
        pcm = _to_pcm16(wav)
        r = subprocess.run([SKELETON_PY, os.path.join(HERE, "align_probe.py"), pcm, wf],
                           capture_output=True, text=True, timeout=300)
        out = json.loads(r.stdout or "{}")
        return out.get("words", []) if out.get("ok") else []
    except Exception:
        return []
    finally:
        os.remove(wf)
        if pcm and os.path.isfile(pcm):
            os.remove(pcm)


def word_align_score(wav, words):
    """Singing-capable word-recovery score for `wav` given the KNOWN `words`."""
    return aggregate_alignment(align_words(wav, words))


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("wav")
    ap.add_argument("words_json", help="JSON list of the known words")
    a = ap.parse_args()
    words = json.load(open(a.words_json))
    print(json.dumps(word_align_score(a.wav, words), indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
