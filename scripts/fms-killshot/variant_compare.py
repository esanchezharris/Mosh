#!/usr/bin/env python3
"""Compare 3 processing variants of the same vocal take (FMS Phase 0).

Answers: do effects (none / gate / gate+fx) produce dramatically different
timings for Whisper words, forced-alignment, or librosa transients?

  python3 scripts/fms-killshot/variant_compare.py [take_dir]
      default: ~/mosh-fms-ksb/used2
"""
import json
import os
import sys
import statistics

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

import overlap

DIR = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.expanduser("~/mosh-fms-ksb/used2")
TAGS = ["nofx", "gate", "all"]
PAIRS = [("nofx", "gate"), ("nofx", "all"), ("gate", "all")]


def load(tag, suffix):
    p = os.path.join(DIR, f"{tag}-{suffix}.json")
    return json.load(open(p))


def whisper_compare():
    data = {t: load(t, "whisper") for t in TAGS}
    print("\n── Whisper word counts ──")
    for t in TAGS:
        ws = data[t]["words"]
        confs = [w["confidence"] for w in ws]
        print(f"  {t:5s}: {len(ws):3d} words  conf median={statistics.median(confs):.3f}  "
              f"p10={sorted(confs)[len(confs)//10]:.3f}  min={min(confs):.3f}")

    print("\n── Whisper word-text agreement ──")
    for a, b in PAIRS:
        wa = [w["word"].strip().lower() for w in data[a]["words"]]
        wb = [w["word"].strip().lower() for w in data[b]["words"]]
        common = min(len(wa), len(wb))
        matches = sum(1 for i in range(common) if wa[i] == wb[i])
        print(f"  {a} vs {b}: {matches}/{common} words match ({matches/common*100:.0f}%), "
              f"len diff {abs(len(wa)-len(wb))}")
    return data


def aligned_compare():
    data = {}
    for t in TAGS:
        p = os.path.join(DIR, f"{t}-aligned.json")
        if os.path.exists(p):
            data[t] = load(t, "aligned")
        else:
            print(f"\n  (skipping aligned comparison — {t}-aligned.json missing)")
            return None

    print("\n── Forced-align per-word timing differences ──")
    results = {}
    for a, b in PAIRS:
        wa, wb = data[a], data[b]
        common = min(len(wa), len(wb))
        dts = [abs(float(wa[i]["start"]) - float(wb[i]["start"])) * 1000 for i in range(common)]
        med = statistics.median(dts) if dts else 0
        p95 = sorted(dts)[int(len(dts) * 0.95)] if dts else 0
        mx = max(dts) if dts else 0
        results[f"{a}_vs_{b}"] = {"median_ms": round(med, 1), "p95_ms": round(p95, 1), "max_ms": round(mx, 1)}
        print(f"  {a} vs {b}: median {med:.1f}ms  p95 {p95:.1f}ms  max {mx:.1f}ms  (N={common})")
    return results


def librosa_compare():
    data = {t: load(t, "librosa") for t in TAGS}
    print("\n── Librosa transient counts ──")
    for t in TAGS:
        print(f"  {t:5s}: {len(data[t]):3d} transients")

    print("\n── Librosa onset agreement (pairwise F1 @ 50ms) ──")
    results = {}
    for a, b in PAIRS:
        r = overlap.onset_agreement(data[a], data[b], tol_s=0.05)
        results[f"{a}_vs_{b}"] = {k: round(v, 4) if isinstance(v, float) else v for k, v in r.items()}
        print(f"  {a} vs {b}: F1={r['f1']:.3f}  prec={r['precision']:.3f}  "
              f"recall={r['recall']:.3f}  median|Δ|={r['median_abs_dt_ms']:.1f}ms")
    return results


def main():
    print(f"=== FMS Phase 0: Variant Comparison ({DIR}) ===")
    whisper_data = whisper_compare()
    aligned_results = aligned_compare()
    librosa_results = librosa_compare()

    out = {
        "whisper": {t: {"word_count": len(whisper_data[t]["words"]),
                        "conf_median": round(statistics.median([w["confidence"] for w in whisper_data[t]["words"]]), 4)}
                    for t in TAGS},
        "librosa": librosa_results,
    }
    if aligned_results:
        out["aligned"] = aligned_results

    print("\n── Verdict ──")
    if librosa_results:
        f1s = [v["f1"] for v in librosa_results.values()]
        if all(f > 0.90 for f in f1s):
            print("  Librosa: ALL pairs F1 > 0.90 — transient timing is CONSISTENT across variants.")
        else:
            worst = min(librosa_results.items(), key=lambda x: x[1]["f1"])
            print(f"  Librosa: {worst[0]} F1={worst[1]['f1']:.3f} < 0.90 — processing CHANGES transient detection.")
    if aligned_results:
        meds = [v["median_ms"] for v in aligned_results.values()]
        if all(m < 20 for m in meds):
            print("  Aligned: ALL pairs median < 20ms — forced-align timing is STABLE across variants.")
        else:
            worst = max(aligned_results.items(), key=lambda x: x[1]["median_ms"])
            print(f"  Aligned: {worst[0]} median={worst[1]['median_ms']:.1f}ms — effects shift word boundaries.")

    json.dump(out, open(os.path.join(DIR, "variant-compare.json"), "w"), indent=2)
    print(f"\nSaved → {DIR}/variant-compare.json")


if __name__ == "__main__":
    main()
