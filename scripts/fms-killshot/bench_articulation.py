#!/usr/bin/env python3
"""Diagnose the singer's ACTUAL complaints — "missing consonants and syllables", "timing and
melodic issues" — as specific, per-word / per-note numbers, not an aggregate scalar.

`env_corr` has pointed the wrong way three times in this lane, so this instrument deliberately
never reduces to one number. It reports, for a rendered window:

  words_dropped    — words whose CTC alignment score fell below HIT (bench_align): the model
                     did not articulate them. THIS is "missing consonants and syllables".
  melody           — per-note pitch error vs the COMMANDED note_pitch (overlap.score_conformance
                     fed the render's F0): |Δ semitone| median + % within 0.5/1.0 st. THIS is
                     "melodic issues".
  vowels           — vowel-onset lateness / squeeze vs the mumble (vowel_landmark).
  ood              — how far the AUTHORED score sits from SoulX's shipped training distribution
                     (soulx_example_stats.notes_of/dist): sub-p5-duration fraction, phones- and
                     notes-per-note. A high sub-p5 fraction or syllable-per-note structure is
                     the measured cause of the dropped articulation.

The pure cores are `word_drops`, `ood_stats`, and `articulation_summary` (golden-tested);
the audio/venv bridges (align, F0) are injected so the pure layer runs without models.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(REPO, "service"))

HIT = 0.3            # bench_align's articulation threshold — below this, a word did not land
SOULX_P5_S = 0.15    # SoulX shipped-English 5th-percentile type-2 note duration (mechanism V4a)


# ── pure cores ──────────────────────────────────────────────────────────────────────────
def word_drops(aligned, hit=HIT):
    """[{word,start,end,score}] -> {dropped:[...], kept:[...], drop_frac, n}. A dropped word
    is one the model failed to articulate clearly enough for forced alignment to find it."""
    scored = [a for a in (aligned or []) if "score" in a]
    if not scored:
        return {"dropped": [], "kept": [], "drop_frac": None, "n": 0}
    dropped = [a["word"] for a in scored if float(a["score"]) < hit]
    kept = [a["word"] for a in scored if float(a["score"]) >= hit]
    return {"dropped": dropped, "kept": kept,
            "drop_frac": round(len(dropped) / len(scored), 3), "n": len(scored)}


def ood_stats(clip, p5_s=SOULX_P5_S):
    """How far an authored clip sits from SoulX's training distribution. Reuses the mechanism
    -verify stat cores so the numbers are comparable to `mechanism/v4/example-stats.json`."""
    from soulx_example_stats import corpus_stats, notes_of
    notes = notes_of(clip)
    sung2 = [n for n in notes if n["type"] == 2]
    cs = corpus_stats([clip], "authored")
    sub_p5 = (sum(1 for n in sung2 if n["dur"] < p5_s) / len(sung2)) if sung2 else None
    return {"dur_type2": cs["dur_type2"], "phones_per_note": cs["phones_per_note"],
            "notes_per_word": cs["notes_per_word"],
            "frac_type2_below_soulx_p5": round(sub_p5, 3) if sub_p5 is not None else None,
            "soulx_p5_s": p5_s}


def articulation_summary(drops, melody, ood):
    """Fold the three axes into one report dict (still per-word / per-note underneath — no
    scalar collapse). Pure, so it is golden-testable without audio."""
    return {
        "words": {"dropped": drops.get("dropped", []), "drop_frac": drops.get("drop_frac"),
                  "n": drops.get("n", 0)},
        "melody": {"pitch_abs_median_st": (melody or {}).get("pitch_abs_median_st"),
                   "within_1_st": (melody or {}).get("pitch_within_1_st"),
                   "voiced_events": (melody or {}).get("voiced_events")},
        "ood": {"frac_below_soulx_p5": (ood or {}).get("frac_type2_below_soulx_p5"),
                "note_dur_median": ((ood or {}).get("dur_type2") or {}).get("median"),
                "phones_per_note_median": ((ood or {}).get("phones_per_note") or {}).get("median"),
                "notes_per_word_median": ((ood or {}).get("notes_per_word") or {}).get("median")},
    }


# ── audio bridges (impure; injectable) ──────────────────────────────────────────────────
def _render_f0(wav):
    """Dense pyin F0 for the render (the nsf-venv probe mumble_probe already wraps)."""
    import mumble_probe as mp
    mono, sr = mp._read_mono(wav)
    return [{"t": p["t"], "hz": p["hz"]} for p in mp._pyin(mono, sr) if p["v"] and p["hz"] > 0]


def analyze_render(render_wav, clip, true_words, *, deps=None):
    """Full per-render report. `clip` is the authored SoulX score; `true_words` the words it
    was told to sing. deps injects {align, f0} for hermetic tests."""
    import bench_align
    import overlap
    d = deps or {"align": bench_align.align_words, "f0": _render_f0}
    aligned = d["align"](render_wav, true_words)
    drops = word_drops(aligned)
    f0 = d["f0"](render_wav)
    melody = overlap.score_conformance(clip, f0)   # render F0 vs COMMANDED note_pitch
    ood = ood_stats(clip)
    return {"summary": articulation_summary(drops, melody, ood),
            "words": drops, "melody": melody, "ood": ood}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default=os.path.expanduser("~/mosh-fms-ksb/bench/own-run-legato/own_run.json"))
    ap.add_argument("--arm", default="pipeline+snap")
    ap.add_argument("--out", default=os.path.expanduser("~/mosh-fms-ksb/bench/articulation"))
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    rows = json.load(open(a.run))
    report = []
    print(f"{'song':13} {'drop%':>6} {'droppedWords':32} {'pitchMed':>9} {'w/in1st':>8} "
          f"{'sub-p5':>7} {'phon/note':>9}")
    for r in rows:
        song = r["item"].replace("own-", "")
        arms = r["arms"]
        if a.arm not in arms:
            continue
        wav = arms[a.arm]["wav"]
        base = os.path.basename(arms["reference"]["wav"]).replace("_reference.wav", "")
        sj = os.path.join(os.path.dirname(wav), base + "_pipeline_score.json")
        if not os.path.isfile(sj):
            continue
        clip = json.load(open(sj)); clip = clip[0] if isinstance(clip, list) else clip
        tw = r.get("true_words") or [w["word"] for w in clip["text"].split() if False]  # from run
        tw = _true_words_for(r, clip)
        rep = analyze_render(wav, clip, tw)
        s = rep["summary"]
        report.append({"song": song, **rep})
        dropped = ",".join(s["words"]["dropped"])[:31]
        print(f"{song:13} {(s['words']['drop_frac'] or 0)*100:5.1f}% {dropped:32} "
              f"{str(s['melody']['pitch_abs_median_st']):>9} {str(s['melody']['within_1_st']):>8} "
              f"{(s['ood']['frac_below_soulx_p5'] or 0)*100:6.1f}% {str(s['ood']['phones_per_note_median']):>9}")
    json.dump(report, open(os.path.join(a.out, "articulation.json"), "w"), indent=1, sort_keys=True)
    print(f"\nwrote {os.path.join(a.out, 'articulation.json')}")
    print("SoulX shipped-EN reference: sub-p5 0%, phones/note median 3.0 (whole words), "
          "notes/word median 1.0")
    return 0


def _true_words_for(row, clip):
    """The words this render was told to sing: prefer the run's recorded true_words, else the
    non-rest tokens of the authored clip."""
    if row.get("true_words"):
        return row["true_words"]
    toks = clip["text"].split()
    types = [int(x) for x in clip["note_type"].split()]
    return [t for t, nt in zip(toks, types) if nt == 2 and t not in ("<SP>", "-")]


if __name__ == "__main__":
    sys.exit(main())
