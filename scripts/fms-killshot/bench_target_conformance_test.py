#!/usr/bin/env python3
"""Goldens for the target-conformance instrument (pure cores + injected known cases).

Run:  python3 scripts/fms-killshot/bench_target_conformance_test.py   (exit 0 = all pass)
"""
import hashlib
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bench_target_conformance as tc  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12.0)


def f0(spans):
    """[(dur_s, midi|None)] -> [{"t","hz"}] at 10 ms (None = unvoiced gap, no frames)."""
    out, t = [], 0.0
    for dur, m in spans:
        n = int(dur / 0.01)
        for _ in range(n):
            if m is not None:
                out.append({"t": round(t, 4), "hz": hz(m)})
            t += 0.01
    return out


# ── events_with_text ────────────────────────────────────────────────────────────────────
CLIP = {"duration": "0.20 0.50 0.50", "text": "<SP> we been", "phoneme": "<SP> en_W-IY1 en_B-IH1-N",
        "note_pitch": "0 60 64", "note_type": "1 2 2", "time": [0, 1200],
        "index": "t", "language": "English"}
ev = tc.events_with_text(CLIP)
check("events: rests excluded, text carried",
      [e["text"] for e in ev] == ["we", "been"], str(ev))
check("events: absolute starts from the duration chain",
      [e["start"] for e in ev] == [0.2, 0.7], str([e["start"] for e in ev]))

# ── note_deltas: KNOWN CASES (the plan's validation requirements) ───────────────────────
# take sings C4 then E4; render sings the SAME → deltas ~0 (finished-vs-itself ≈ perfect)
TAKE = f0([(0.2, None), (0.5, 60), (0.5, 64)])
SAME = f0([(0.2, None), (0.5, 60), (0.5, 64)])
nd = tc.note_deltas(ev, TAKE, SAME)
check("KNOWN CASE identical: deltas ~0 on every note",
      all(n["d_st"] is not None and abs(n["d_st"]) < 0.05 for n in nd),
      str([n["d_st"] for n in nd]))

# render transposes note 2 up a whole tone → reads as +2 st on that note only
TRANS = f0([(0.2, None), (0.5, 60), (0.5, 66)])
nd = tc.note_deltas(ev, TAKE, TRANS)
check("KNOWN CASE transposed: the transposed note reads as its transposition (+2 st)",
      abs(nd[1]["d_st"] - 2.0) < 0.05 and abs(nd[0]["d_st"]) < 0.05,
      str([n["d_st"] for n in nd]))
check("note names are readable", nd[1]["take_note"] == "E4" and nd[1]["render_note"] == "F#4",
      f"{nd[1]['take_note']} → {nd[1]['render_note']}")
check("d_cmd_st measures obedience to the SCORE separately",
      abs(nd[1]["d_cmd_st"] - 2.0) < 0.05, str(nd[1]["d_cmd_st"]))

# render silent where the take sings → None delta, counted (silence is a finding)
SIL = f0([(0.2, None), (0.5, 60), (0.5, None)])
nd = tc.note_deltas(ev, TAKE, SIL)
check("render-silent note keeps take info and a None delta",
      nd[1]["d_st"] is None and nd[1]["take_note"] == "E4", str(nd[1]))
s = tc.summarize(nd, [], {"drop_frac": 0.2, "dropped": ["x"]})
check("summary counts render-silent-where-take-sings",
      s["notes"]["render_silent_where_take_sings"] == 1, str(s["notes"]))

# ── word_lags ───────────────────────────────────────────────────────────────────────────
TW = [{"word": "we", "start": 0.20, "score": 0.5}, {"word": "been", "start": 0.70, "score": 0.5}]
RW = [{"word": "we", "start": 0.26, "score": 0.5}, {"word": "been", "start": 0.68, "score": 0.5}]
lg = tc.word_lags(TW, RW)
check("word_lags: per-word render-minus-take onset lag in ms",
      lg[0]["lag_ms"] == 60.0 and lg[1]["lag_ms"] == -20.0, str(lg))
check("word_lags: an unalignable word reports None, not a fake zero",
      tc.word_lags(TW, [dict(RW[0], score=0.01), RW[1]])[0]["lag_ms"] is None)
check("word_lags: identical alignment = all zeros (finished-vs-itself)",
      all(l["lag_ms"] == 0.0 for l in tc.word_lags(TW, TW)))

# ── summarize headline numbers ──────────────────────────────────────────────────────────
s = tc.summarize(tc.note_deltas(ev, TAKE, TRANS), lg, {"drop_frac": 0.25, "dropped": ["been"]})
check("summary: rhythm median from the lag table", s["rhythm"]["abs_median_ms"] == 60.0
      or s["rhythm"]["abs_median_ms"] == 20.0, str(s["rhythm"]))
check("summary keeps the dropped-word names", s["words"]["dropped"] == ["been"])

# ── injected end-to-end (no audio) ──────────────────────────────────────────────────────
deps = {"f0": lambda w: TAKE if "ref" in w else TRANS,
        "align": lambda w, words: TW if "ref" in w else RW}
rep = tc.conformance("render.wav", "ref.wav", CLIP, ["we", "been"], deps=deps)
check("conformance end-to-end: transposition + lags + summary all present",
      abs(rep["notes"][1]["d_st"] - 2.0) < 0.05 and rep["rhythm"][0]["lag_ms"] == 60.0
      and rep["summary"]["notes"]["n"] == 2)

det = {hashlib.sha256(json.dumps(tc.conformance("render.wav", "ref.wav", CLIP, ["we", "been"],
                                                deps=deps), sort_keys=True).encode()).hexdigest()
       for _ in range(3)}
check("conformance deterministic (3x)", len(det) == 1)

print("\n" + ("ALL PASS" if not fails else "FAILURES: " + ", ".join(fails)))
sys.exit(1 if fails else 0)
