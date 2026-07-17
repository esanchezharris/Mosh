#!/usr/bin/env python3
"""Author a SoulX target score from REAL words + F0 using the PRODUCT author_score.

Runs under the phonology venv (cmudict/g2p) so author_score derives correct ARPAbet
phonemes from the word text — the hand-rolled NUS-phone syllabification sang the wrong
words; author_score is the proven path (it authored the clean-English control renders).

argv:  in.json {"words":[{word,start,end}], "f0":[[t,hz,voiced], ...]}   out_score.json
Builds ONE line = one slot per word, each slot's segments = the word's syllables (so
author_score spreads the phones over note_type 2+3 notes), pitch from the clean F0.
"""
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))

from soulx.score import author_score  # noqa: E402
import phonology.core as ph  # noqa: E402

_pron = ph.Pronouncer()


def nsyl(word):
    try:
        return max(1, _pron.syllables(word) or 1)
    except Exception:
        return max(1, sum(word.lower().count(v) for v in "aeiou") or 1)


def _midi(hz):
    return int(round(69 + 12 * math.log2(hz / 440.0))) if hz and hz > 0 else 0


def _pitch(f0, a, b):
    hz = sorted(h for t, h, v in f0 if a <= t < b and v and h > 0)
    return _midi(hz[len(hz) // 2]) if hz else 0


def main():
    data = json.load(open(sys.argv[1]))
    words, f0 = data["words"], [tuple(x) for x in data["f0"]]
    slots = []
    for w in words:
        s, e = float(w["start"]), float(w["end"])
        n = nsyl(w["word"])
        segs = []
        for j in range(n):
            a, b = s + (e - s) * j / n, s + (e - s) * (j + 1) / n
            p = _pitch(f0, a, b) or _pitch(f0, s, e) or 57
            segs.append({"start": round(a, 4), "end": round(b, 4), "pitch": p})
        slots.append({"start": round(s, 4), "end": round(e, 4),
                      "pitch": segs[0]["pitch"], "segments": segs})
    line = {"text": " ".join(w["word"] for w in words), "asserted": True,
            "score": {"slots": slots}}
    res = author_score([line])
    if not res.get("ok"):
        print("author_score rejected:", json.dumps(res)[:300])
        sys.exit(1)
    json.dump(res["score"], open(sys.argv[2], "w"), indent=1)
    clip = res["score"][0] if isinstance(res["score"], list) else res["score"]
    print("ok — events:", len(clip["note_type"].split()), "| text:", clip["text"][:100])


if __name__ == "__main__":
    main()
