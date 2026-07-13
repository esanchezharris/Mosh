#!/usr/bin/env python3
"""Grid benchtest — does a SIMPLE auto-detector match the owner's 147-mark truth grid?

The audit question (2026-07-13): the annotator + Basic-Pitch v3/v4 ladder + melisma
detection were built because early auto-grids "were all off". But that predates the
post-render timing-snap + NSF, which forgive grid TIMING error. What actually has to be
right pre-render is the per-phrase syllable COUNT (the LLM writes exactly N syllables per
line). So: measure a few SIMPLE detectors' per-phrase counts + onset P/R/F1 against the
owner's hand-marked truth (ground-truth.json, 147 onsets across 17 phrases), using the raw
streams already captured in evidence.json (env / notes / f0 / words). No audio, no pod.

Verdict feeds the plan: if a simple energy detector's per-phrase COUNTS track truth, the
elaborate grid machinery + the hand annotator can go.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import segment_v2 as sv  # noqa: E402

BH = Path.home() / "mosh-fms-ksb" / "used2" / "asserted-proof" / "back-half"
EVID = BH / "evidence.json"
TRUTH = BH / "ground-truth.json"


def load_truth() -> list:
    """[(phrase_id, [onset_times...]), ...] sorted by first onset."""
    gt = json.loads(TRUTH.read_text())
    phrases = [(pid, sorted(float(t) for t in ts)) for pid, ts in gt["phrases"].items() if ts]
    phrases.sort(key=lambda p: p[1][0])
    return phrases


def phrase_boundaries(phrases: list) -> list:
    """Split points between consecutive phrases (midpoint of the inter-phrase gap)."""
    bounds = []
    for i in range(len(phrases) - 1):
        bounds.append(0.5 * (phrases[i][1][-1] + phrases[i + 1][1][0]))
    return bounds


def assign_counts(onsets: list, phrases: list) -> list:
    """Per-phrase detected-onset counts, binning every onset by the midpoint boundaries."""
    bounds = phrase_boundaries(phrases)
    counts = [0] * len(phrases)
    for t in onsets:
        pi = 0
        while pi < len(bounds) and t > bounds[pi]:
            pi += 1
        counts[pi] += 1
    return counts


def onset_prf(detected: list, truth: list, tol: float) -> tuple:
    """Greedy nearest-match onset P/R/F1 within +/-tol seconds (each matches at most once)."""
    det = sorted(detected)
    tru = sorted(truth)
    used = [False] * len(det)
    tp = 0
    for tt in tru:
        best, bi = tol + 1e-9, -1
        for j, dt in enumerate(det):
            if used[j]:
                continue
            d = abs(dt - tt)
            if d <= tol and d < best:
                best, bi = d, j
        if bi >= 0:
            used[bi] = True
            tp += 1
    fp = len(det) - tp
    fn = len(tru) - tp
    p = tp / (tp + fp) if (tp + fp) else 0.0
    r = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * p * r / (p + r) if (p + r) else 0.0
    return p, r, f1, tp, fp, fn


def report(name: str, onsets: list, phrases: list, truth_flat: list) -> dict:
    det_counts = assign_counts(onsets, phrases)
    tru_counts = [len(ts) for _, ts in phrases]
    exact = sum(1 for d, t in zip(det_counts, tru_counts) if d == t)
    within1 = sum(1 for d, t in zip(det_counts, tru_counts) if abs(d - t) <= 1)
    total_abs = sum(abs(d - t) for d, t in zip(det_counts, tru_counts))
    p80, r80, f80, *_ = onset_prf(onsets, truth_flat, 0.08)
    p120, r120, f120, *_ = onset_prf(onsets, truth_flat, 0.12)
    print(f"\n== {name}: {len(onsets)} onsets (truth {len(truth_flat)})")
    print(f"   per-phrase count: {exact}/{len(phrases)} EXACT, {within1}/{len(phrases)} within 1, "
          f"total |delta| = {total_abs}")
    print(f"   onset F1: {f80:.2f} @80ms (P{p80:.2f}/R{r80:.2f})  |  {f120:.2f} @120ms")
    print(f"   det counts: {det_counts}")
    print(f"   tru counts: {tru_counts}")
    deltas = [d - t for d, t in zip(det_counts, tru_counts)]
    print(f"   deltas    : {deltas}")
    return {"name": name, "onsets": len(onsets), "exact": exact, "within1": within1,
            "totalAbs": total_abs, "f1_80": round(f80, 3), "f1_120": round(f120, 3)}


def main() -> int:
    ev = json.loads(EVID.read_text())
    env, hop = ev["env"], float(ev["hopS"])
    phrases = load_truth()
    truth_flat = [t for _, ts in phrases for t in ts]

    # Detector A — pure energy gate (attacks only): the simplest possible counter.
    attacks, spans = sv.gate_events(env, hop)
    rows = [report("A energy-gate (attacks only)", attacks, phrases, truth_flat)]

    # Detector B — energy gate + dip splits (the re-grid "E": consonant troughs re-articulate
    # a held vowel into 2 syllables). Still energy-only, no pitch/ASR.
    dips = sv.dip_events(env, hop, spans)
    e_onsets = sorted(attacks + dips)
    rows.append(report("B energy gate+dip (E)", e_onsets, phrases, truth_flat))

    # Detector C — E + F0 step splits (a sustained pitch change also = a new syllable).
    steps = sv.pitch_step_events(ev.get("f0"))
    # keep steps that land inside a gate-open span (real voiced energy)
    steps_in = [t for t in steps if any(a <= t <= b for a, b in spans)]
    ef_onsets = sorted(attacks + dips + steps_in)
    rows.append(report("C energy+dip+F0-step", ef_onsets, phrases, truth_flat))

    # Reference — Basic-Pitch note onsets (the old v1 floor), for contrast.
    note_onsets = sorted(float(n["start"]) for n in ev.get("notes", []))
    rows.append(report("ref Basic-Pitch note-onsets (v1)", note_onsets, phrases, truth_flat))

    print("\n== SUMMARY (higher exact + F1, lower total|delta| = better; truth = 147 / 17 phrases)")
    for r in sorted(rows, key=lambda x: (-x["exact"], x["totalAbs"])):
        print(f"   {r['name']:<32} exact {r['exact']:>2}/17  within1 {r['within1']:>2}/17  "
              f"|delta| {r['totalAbs']:>2}  F1@120 {r['f1_120']:.2f}  ({r['onsets']} onsets)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
