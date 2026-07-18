#!/usr/bin/env python3
"""Author a SoulX target score for a NUS item window using the PRODUCT author_score.

Runs under the phonology venv (cmudict/g2p) so (a) NUS words carry REAL text (reverse-CMUdict,
~65% mapped; the teardown venv has no cmudict → phone-labels) and (b) author_score derives
correct ARPAbet phonemes and spreads them over note_type 2/3 notes — hand-rolling NUS phones
sings the wrong words (ruler-proven 0.042 vs clean 0.377); author_score lands them (0.167).

argv:  in.json {"singer","t0","t1","f0":[[t,hz,voiced],...], "words"?}   out_score.json

`words` is optional: own-pairs items carry their own ground-truth words (Whisper on the
finished take — real text with apostrophes), so they are passed inline. Absent, the NUS
lookup-by-singer path runs exactly as before.
Builds ONE line = one slot per word (segments = the word's syllables, so author_score spreads
the phones over notes), pitch from the clean F0. Prints the true words (real text) as JSON on
stdout's last line so the caller can score word-recovery against them.
"""
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

import bench_dataset as bd  # noqa: E402
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
    f0 = [tuple(x) for x in data["f0"]]
    t0, t1 = float(data["t0"]), float(data["t1"])
    if data.get("words") is not None:
        # own-pairs: real ground-truth words travel with the item (may carry apostrophes,
        # which .isalpha() would wrongly reject — normalize curly quotes, keep any word
        # containing a letter). See the apostrophe GOTCHA in the used2 notes.
        src = [dict(w, word=str(w.get("word", "")).replace("’", "'").strip())
               for w in data["words"]]
        words = [w for w in src if w["end"] > t0 and w["start"] < t1
                 and any(c.isalpha() for c in w["word"])]
    else:
        it = bd.nus_items(singers=[data["singer"]], limit=1)[0]
        words = [w for w in it["words"]
                 if w["end"] > t0 and w["start"] < t1 and w["word"].isalpha()]

    slots, texts = [], []
    for w in words:
        s, e = max(t0, float(w["start"])), min(t1, float(w["end"]))
        if e - s < 0.05:
            continue
        n = nsyl(w["word"])
        segs = []
        for j in range(n):
            a, b = s + (e - s) * j / n, s + (e - s) * (j + 1) / n
            p = _pitch(f0, a, b) or _pitch(f0, s, e) or 57
            segs.append({"start": round(a - t0, 4), "end": round(b - t0, 4), "pitch": p})
        slots.append({"start": round(s - t0, 4), "end": round(e - t0, 4),
                      "pitch": segs[0]["pitch"], "segments": segs})
        texts.append(w["word"])

    if not slots:
        print(json.dumps({"ok": False, "error": "no words in window"}))
        sys.exit(1)
    line = {"text": " ".join(texts), "asserted": True, "score": {"slots": slots}}
    res = author_score([line])
    if not res.get("ok"):
        print("author_score rejected:", json.dumps(res)[:300])
        sys.exit(1)
    json.dump(res["score"], open(sys.argv[2], "w"), indent=1)
    clip = res["score"][0] if isinstance(res["score"], list) else res["score"]
    print("events:", len(clip["note_type"].split()))
    print("WORDS " + json.dumps(texts))          # last line: the true words (real text)


if __name__ == "__main__":
    main()
