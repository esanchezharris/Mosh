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


def _med(xs):
    s = sorted(xs)
    return s[len(s) // 2] if s else 0.0


def word_segments(f0, s, e, t0, *, min_step_st=1.5, min_hold_s=0.12, max_segs=None,
                  default_pitch=57):
    """SoulX-convention segmentation of ONE word's span into notes.

    SoulX's shipped scores ride a whole WORD on one note ("beautiful" = 8 phonemes / 1 note);
    the previous bench author forced `nsyl(word)` equal syllable notes, which is out of
    distribution (mechanism-verify V4a) and drops consonants. This returns ONE segment
    (whole word, one note) UNLESS the take's own F0 genuinely steps within the word — then it
    splits at the step, a real melisma, which is the V4b-proven note_type=3 mechanism.

    A step is a sustained (>= min_hold_s) pitch change of >= min_step_st semitones from the
    current segment's median. `max_segs` (the syllable count) caps how finely a word may
    split — keeping only the largest steps — so ornament noise can never exceed the word's
    syllables. Times returned on the t0-relative clock. Pure."""
    pts = [(t, 69.0 + 12.0 * math.log2(h / 440.0))
           for (t, h, v) in f0 if s <= t < e and v and h > 0]
    if not pts:
        return [{"start": round(s - t0, 4), "end": round(e - t0, 4), "pitch": default_pitch}]

    times = [p[0] for p in pts]
    midis = [p[1] for p in pts]
    # collect candidate cut points: (frame index, jump size) where a new level sustains
    cuts = []
    seg_start = 0
    i = 1
    while i < len(pts):
        cur = _med(midis[seg_start:i])
        if abs(midis[i] - cur) >= min_step_st:
            j = i
            while j < len(pts) and times[j] - times[i] < min_hold_s:
                j += 1
            if abs(_med(midis[i:max(j, i + 1)]) - cur) >= min_step_st:
                cuts.append((i, abs(_med(midis[i:max(j, i + 1)]) - cur)))
                seg_start = i
        i += 1

    if max_segs is not None and len(cuts) > max_segs - 1:
        keep = sorted(sorted(cuts, key=lambda c: -c[1])[:max(0, max_segs - 1)])
        cuts = keep
    bounds = [0] + [c[0] for c in cuts] + [len(pts)]

    out = []
    for k in range(len(bounds) - 1):
        a, b = bounds[k], bounds[k + 1]
        seg_s = s if k == 0 else times[a]
        seg_e = e if k == len(bounds) - 2 else times[bounds[k + 1]]
        out.append({"start": round(seg_s - t0, 4), "end": round(seg_e - t0, 4),
                    "pitch": int(round(_med(midis[a:b]) or default_pitch))})
    return out


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

    convention = str(data.get("convention") or "syllable")
    slots, texts = [], []
    for w in words:
        s, e = max(t0, float(w["start"])), min(t1, float(w["end"]))
        if e - s < 0.05:
            continue
        if convention == "soulx":
            # whole word on one note unless the take's F0 genuinely steps (a real melisma),
            # capped at the word's syllable count
            segs = word_segments(f0, s, e, t0, max_segs=nsyl(w["word"]))
        else:
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
    res = author_score([line], durations=str(data.get("durations") or "verbatim"),
                       note_floor_s=float(data.get("noteFloorS") or 0.0))
    if not res.get("ok"):
        print("author_score rejected:", json.dumps(res)[:300])
        sys.exit(1)
    json.dump(res["score"], open(sys.argv[2], "w"), indent=1)
    clip = res["score"][0] if isinstance(res["score"], list) else res["score"]
    print("events:", len(clip["note_type"].split()))
    print("WORDS " + json.dumps(texts))          # last line: the true words (real text)


if __name__ == "__main__":
    main()
