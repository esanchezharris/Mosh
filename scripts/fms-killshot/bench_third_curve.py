#!/usr/bin/env python3
"""Third-curve run: the REAL SoulX `pipeline` generator vs the oracle/passthrough brackets,
on a fixed window, scored with the SINGING-CAPABLE forced-alignment word ruler.

Per item, on [t0,t1] (default 0–12 s, the SoulX chunk unit):
  oracle       = the clean vocal slice          (word-recovery ceiling)
  passthrough  = the mumble of that slice        (floor)
  pipeline     = author_score(true words+F0) → local SoulX render   (the real chain)
Scored vs the clean slice: word_align (bench_align, MMS forced alignment of the TRUE words —
Whisper can't read singing), onset F1 (timing), pq (naturalness). Oracle-lyrics + cross-voice
(owner's ref) for now — word/timing/naturalness valid, f0-register is cross-voice.

Usage: bench_third_curve.py --singers ADIZ,JLEE,ZHIY --t0 0 --t1 12 --out DIR
"""
from __future__ import annotations

import argparse
import json
import os
import struct
import sys
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def _slice_wav(src_mono, sr, a, b, dst):
    seg = src_mono[int(a * sr):int(b * sr)]
    w = wave.open(dst, "wb")
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
    w.writeframes(b"".join(struct.pack("<h", int(max(-32767, min(32767, x * 32767)))) for x in seg))
    w.close()


def run_item(item, t0, t1, out_dir, *, seed=0):
    import bench_align
    import bench_naturalness
    import bench_pipeline_render as pr
    import bench_run
    import mumble_probe as mp
    import overlap

    os.makedirs(out_dir, exist_ok=True)
    base = f"{item['id']}_{int(t0)}-{int(t1)}"
    clean_mono, sr = mp._read_mono(item["clean_vocal"])
    clean_slice = os.path.join(out_dir, base + "_clean.wav")
    _slice_wav(clean_mono, sr, t0, t1, clean_slice)

    # pipeline (real SoulX) — returns the true words (real text) used to author
    pipe_wav = os.path.join(out_dir, base + "_pipeline.wav")
    pipe_wav, true_words = pr.pipeline_generate(item, pipe_wav, t0=t0, t1=t1)

    # passthrough = mumble the window at rho=0.5 (subprocess-isolated librosa)
    win_words = [w for w in item["words"] if w["end"] > t0 and w["start"] < t1
                 and w["start"] >= t0 and w["end"] <= t1]
    pass_wav = os.path.join(out_dir, base + "_passthrough.wav")
    try:
        bench_run._subproc_mumble(clean_slice, [dict(w, start=w["start"] - t0, end=w["end"] - t0)
                                                for w in win_words], 0.5, pass_wav, seed=seed)
    except Exception:
        pass_wav = clean_slice   # mumble failed → fall back (rare)

    gens = {"oracle": clean_slice, "passthrough": pass_wav, "pipeline": pipe_wav}
    out = {"item": item["id"], "window": [t0, t1], "true_words": true_words, "gens": {}}
    for name, wav in gens.items():
        g_mono, g_sr = mp._read_mono(wav)
        rep = overlap.analyze(clean_mono[int(t0 * sr):int(t1 * sr)], sr, g_mono, g_sr)
        out["gens"][name] = {
            "word_align": bench_align.word_align_score(wav, true_words),
            "onset_f1": rep.get("onsets", {}).get("f1"),
            "pq": bench_naturalness.pq_score(wav),
            "wav": wav,
        }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--singers", default="ADIZ,JLEE,ZHIY")
    ap.add_argument("--t0", type=float, default=0.0)
    ap.add_argument("--t1", type=float, default=12.0)
    ap.add_argument("--out", default=os.path.expanduser("~/mosh-fms-ksb/bench/third"))
    a = ap.parse_args()

    import bench_dataset as bd
    os.makedirs(a.out, exist_ok=True)
    rows = []
    for s in a.singers.split(","):
        items = bd.nus_items(singers=[s], limit=1)
        if not items:
            continue
        it = items[0]
        print(f"  {it['id']} …", flush=True)
        try:
            rows.append(run_item(it, a.t0, a.t1, a.out))
        except Exception as e:
            print(f"    FAILED: {str(e)[:200]}", flush=True)
    json.dump(rows, open(os.path.join(a.out, "third_curve.json"), "w"), indent=1)

    # aggregate the 3-way means
    agg = {}
    for g in ("oracle", "passthrough", "pipeline"):
        wa = [r["gens"][g]["word_align"]["mean_score"] for r in rows
              if r["gens"].get(g, {}).get("word_align", {}).get("mean_score") is not None]
        pq = [r["gens"][g]["pq"] for r in rows if r["gens"].get(g, {}).get("pq") is not None]
        f1 = [r["gens"][g]["onset_f1"] for r in rows if r["gens"].get(g, {}).get("onset_f1") is not None]
        agg[g] = {"word_align_mean": round(sum(wa) / len(wa), 3) if wa else None,
                  "onset_f1_mean": round(sum(f1) / len(f1), 3) if f1 else None,
                  "pq_mean": round(sum(pq) / len(pq), 3) if pq else None, "n": len(rows)}
    print("\n=== third-curve 3-way (word_align / onset_f1 / pq) ===")
    for g in ("oracle", "pipeline", "passthrough"):
        print(f"  {g:12} {agg[g]}")
    json.dump(agg, open(os.path.join(a.out, "third_curve_agg.json"), "w"), indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
