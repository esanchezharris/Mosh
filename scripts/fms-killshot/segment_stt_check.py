#!/usr/bin/env python3
"""Segmented STT verification (owner's method, 2026-07-05).

Whole-clip Whisper gives unreliable word timestamps on singing, so it can't tell WHICH word
is wrong. Instead: split the render at the SCORE's phrase boundaries (the rests), transcribe
each segment on its OWN, and diff the heard words against the words the score told SoulX to
sing. Localizes exactly which phrase has a garbled/dropped word, a doubled note, or a timing
slip — far more temporally accurate than one pass over the whole clip.

Pure core (phrases_from_score / word_diff) is hermetic + has an embedded --selftest. The STT
pass loads Whisper ONCE (runs under the whisper venv) and transcribes each segment.

Usage: segment_stt_check.py --render sung.wav --score target_score.json [--model small] [--pad 0.2]
       segment_stt_check.py --selftest
"""
from __future__ import annotations

import argparse
import array
import json
import os
import sys
import tempfile
import wave
from collections import Counter


def phrases_from_score(clip: dict):
    """Score clip → [{words, start, end}] phrases, split at type-1 rests. `words` are the
    type-2 onsets (distinct sung words); continuations stay inside the phrase's span."""
    txt = clip["text"].split()
    typ = clip["note_type"].split()
    dur = [float(x) for x in clip["duration"].split()]
    phrases, cur, cur_start, t = [], [], None, 0.0
    for tk, ty, d in zip(txt, typ, dur):
        if ty == "1":                          # rest → close the current phrase
            if cur:
                phrases.append({"words": cur, "start": cur_start, "end": t})
                cur, cur_start = [], None
        else:
            if cur_start is None:
                cur_start = t
            if ty == "2":                      # word onset (continuations are the same word)
                cur.append(tk)
        t += d
    if cur:
        phrases.append({"words": cur, "start": cur_start, "end": t})
    return phrases


def _norm(w: str) -> str:
    return "".join(c for c in w.lower() if c.isalpha())


def word_diff(expected, heard):
    """Bag-compare expected vs heard words → missing / extra (doubled shows as extra)."""
    e = [_norm(w) for w in expected if _norm(w)]
    h = [_norm(w) for w in heard if _norm(w)]
    ce, ch = Counter(e), Counter(h)
    missing = sorted((ce - ch).elements())
    extra = sorted((ch - ce).elements())
    return {"expected": e, "heard": h, "missing": missing, "extra": extra,
            "match": not missing and not extra, "n_exp": len(e), "n_heard": len(h)}


def _read(path: str):
    with wave.open(path, "rb") as w:
        sr, ch = w.getframerate(), w.getnchannels()
        a = array.array("h")
        a.frombytes(w.readframes(w.getnframes()))
    if ch == 2:
        a = a[0::2]
    return a, sr


def _write_seg(a, sr, start, end, path):
    i0, i1 = max(0, int(start * sr)), min(len(a), int(end * sr))
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(a[i0:i1].tobytes())


def check_render(render_path: str, score_path: str, model_name: str = "small", pad: float = 0.2):
    import whisper                                    # noqa: F401 (whisper venv)
    clip = json.load(open(score_path))[0]
    phrases = phrases_from_score(clip)
    a, sr = _read(render_path)
    model = whisper.load_model(model_name)
    rows = []
    with tempfile.TemporaryDirectory() as td:
        for i, ph in enumerate(phrases):
            seg = os.path.join(td, f"seg{i}.wav")
            _write_seg(a, sr, max(0.0, ph["start"] - pad), ph["end"] + pad, seg)
            res = model.transcribe(seg, word_timestamps=False, language="en", fp16=False)
            heard = str(res.get("text", "")).split()
            d = word_diff(ph["words"], heard)
            rows.append({"phrase": i, "window": [round(ph["start"], 2), round(ph["end"], 2)], **d})
    return rows


def selftest() -> int:
    fails = []

    def check(name, ok, detail=""):
        print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
        if not ok:
            fails.append(name)

    clip = {"text": "<SP> down down but <SP> gonna up again",
            "note_type": "1 2 2 2 1 2 2 2",
            "duration": "0.5 0.4 0.4 0.3 0.6 0.3 0.3 0.4"}
    ph = phrases_from_score(clip)
    check("splits into 2 phrases at the rests", len(ph) == 2, str(ph))
    check("phrase 0 = the 3 words after the first rest",
          ph[0]["words"] == ["down", "down", "but"] and abs(ph[0]["start"] - 0.5) < 1e-6, str(ph[0]))
    check("phrase 1 window starts after its leading rest",
          ph[1]["words"] == ["gonna", "up", "again"], str(ph[1]))
    # a continuation (type 3) does NOT add a new word
    clip2 = {"text": "down down", "note_type": "2 3", "duration": "0.4 0.4"}
    check("a melisma continuation is not a second word", phrases_from_score(clip2)[0]["words"] == ["down"])

    check("word_diff: exact match", word_diff(["down", "up"], ["Down!", "up"])["match"])
    check("word_diff: a DROPPED word shows as missing",
          word_diff(["gonna", "getta", "up", "again"], ["gonna", "up"])["missing"] == ["again", "getta"])
    dbl = word_diff(["down", "down", "down"], ["down", "down", "down", "down"])
    check("word_diff: a DOUBLED note shows as extra", dbl["extra"] == ["down"], str(dbl))
    check("word_diff is deterministic", word_diff(["a", "b"], ["b", "a"]) == word_diff(["a", "b"], ["b", "a"]))

    print(f"\n{'OK' if not fails else 'FAILED'}: {len(fails)} failure(s)")
    return len(fails)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--render")
    ap.add_argument("--score")
    ap.add_argument("--model", default="small")
    ap.add_argument("--pad", type=float, default=0.2)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        return selftest()
    if not (args.render and args.score):
        ap.error("need --render and --score (or --selftest)")
    rows = check_render(args.render, args.score, args.model, args.pad)
    print(f"{'phrase':>6} {'window':>14}  expected → heard   (flags)")
    bad = 0
    for r in rows:
        flags = []
        if r["missing"]:
            flags.append(f"DROPPED {r['missing']}")
        if r["extra"]:
            flags.append(f"EXTRA {r['extra']}")
        if flags:
            bad += 1
        mark = "  ⚠ " + "; ".join(flags) if flags else "  ok"
        print(f"{r['phrase']:>6} {str(r['window']):>14}  {' '.join(r['expected'])!r} → {' '.join(r['heard'])!r}{mark}")
    print(f"\n{len(rows)-bad}/{len(rows)} phrases clean; {bad} with word errors")
    return 0


if __name__ == "__main__":
    sys.exit(main())
