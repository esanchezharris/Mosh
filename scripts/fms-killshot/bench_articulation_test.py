#!/usr/bin/env python3
"""Goldens for the articulation instrument: pure cores + known-case validation of the
audio-fed path (via injected deps, no models).

Run:  python3 scripts/fms-killshot/bench_articulation_test.py   (exit 0 = all pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bench_articulation as ba  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


# ── word_drops ──────────────────────────────────────────────────────────────────────────
AL = [{"word": "we", "score": 0.71}, {"word": "been", "score": 0.62},
      {"word": "smashing", "score": 0.08}, {"word": "piñata", "score": 0.55},
      {"word": "the", "score": 0.12}]
d = ba.word_drops(AL)
check("word_drops lists the words the model failed to articulate",
      d["dropped"] == ["smashing", "the"], str(d["dropped"]))
check("word_drops keeps the articulated ones", d["kept"] == ["we", "been", "piñata"])
check("word_drops fraction", d["drop_frac"] == 0.4)
check("word_drops on nothing is honest, not zero",
      ba.word_drops([]) == {"dropped": [], "kept": [], "drop_frac": None, "n": 0})
check("word_drops threshold is the alignment HIT (0.3)",
      ba.word_drops([{"word": "x", "score": 0.30}])["dropped"] == [])   # 0.30 is a keep (>=)

# ── ood_stats: a syllable-per-note score with sub-p5 notes reads as OOD ──────────────────
# Two words. "smash" one note 0.30s (in-dist). "piñata" split into 3 tiny 0.06s syllable
# notes (type 2/3/3) — the syllable-per-note + sub-p5 pattern V4a flagged.
OOD_CLIP = {"index": "t_0_480", "language": "English", "time": [0, 480],
            "duration": "0.30 0.06 0.06 0.06", "text": "smash piñata - -",
            "phoneme": "en_S-M-AE1-SH en_P en_AH1 en_T-AH0", "note_pitch": "60 62 62 62",
            "note_type": "2 2 3 3"}
o = ba.ood_stats(OOD_CLIP)
check("ood: the three 0.06s notes count as below SoulX's p5 (0.15s)",
      o["frac_type2_below_soulx_p5"] == 0.5, str(o["frac_type2_below_soulx_p5"]))
check("ood exposes the phones-per-note distribution", o["phones_per_note"]["n"] == 4)
check("ood carries the SoulX p5 reference", o["soulx_p5_s"] == 0.15)

# a whole-word-per-note, in-distribution clip should NOT read as sub-p5
GOOD_CLIP = {"index": "t_0_600", "language": "English", "time": [0, 600],
             "duration": "0.30 0.30", "text": "smash piñata",
             "phoneme": "en_S-M-AE1-SH en_P-AH0-N-AA1-T-AH0", "note_pitch": "60 62",
             "note_type": "2 2"}
check("ood: an in-distribution whole-word score has NO sub-p5 notes",
      ba.ood_stats(GOOD_CLIP)["frac_type2_below_soulx_p5"] == 0.0)

# ── articulation_summary keeps per-word/per-note detail (no scalar collapse) ─────────────
summ = ba.articulation_summary(d, {"pitch_abs_median_st": 1.4, "pitch_within_1_st": 0.42,
                                   "voiced_events": 10}, o)
check("summary surfaces the dropped words by name", summ["words"]["dropped"] == ["smashing", "the"])
check("summary surfaces the melody error", summ["melody"]["pitch_abs_median_st"] == 1.4)
check("summary surfaces the OOD sub-p5 fraction", summ["ood"]["frac_below_soulx_p5"] == 0.5)

# ── KNOWN-CASE validation of analyze_render via injected deps (plan requirement) ────────
# Fake align: "smashing" scores low (dropped). Fake F0: sing note 2 (pitch 60=C4, 261.6Hz)
# a whole tone SHARP so score_conformance must report a real pitch error.
import math  # noqa: E402


def _fake_align(_wav, _words):
    return AL


def _fake_f0(_wav):
    # note "smash" spans 0.0-0.30 at commanded MIDI 60; render it at MIDI 62 (+2 st)
    hz = 440.0 * 2 ** ((62 - 69) / 12.0)
    return [{"t": t / 100.0, "hz": hz} for t in range(0, 30)]


rep = ba.analyze_render("x.wav", OOD_CLIP, ["smash", "piñata"],
                        deps={"align": _fake_align, "f0": _fake_f0})
check("KNOWN CASE: a deliberately dropped word shows up as dropped",
      "smashing" in rep["summary"]["words"]["dropped"])
check("KNOWN CASE: a note sung a whole tone off shows a ~2 semitone pitch error",
      rep["melody"]["pitch_abs_median_st"] is not None
      and abs(rep["melody"]["pitch_abs_median_st"] - 2.0) < 0.15,
      str(rep["melody"]["pitch_abs_median_st"]))
check("KNOWN CASE: the OOD read is carried through", rep["ood"]["frac_type2_below_soulx_p5"] == 0.5)

# determinism
import hashlib  # noqa: E402
import json  # noqa: E402
det = {hashlib.sha256(json.dumps(ba.articulation_summary(d, None, o), sort_keys=True).encode()).hexdigest()
       for _ in range(3)}
check("summary deterministic (3x)", len(det) == 1)

print("\n" + ("ALL PASS" if not fails else "FAILURES: " + ", ".join(fails)))
sys.exit(1 if fails else 0)
