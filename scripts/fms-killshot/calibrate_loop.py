#!/usr/bin/env python3
"""Closed-loop calibration on a KNOWN-LYRICS song (the owner's first-principles rig,
2026-07-04): run the whole pipeline on audio whose words are already known; the re-sung
take should align EXACTLY with the original — every divergence is attributable system
error, stage by stage.

FREE stages (this script, no GPU):
  1. extraction vs truth      — do the pipeline's kept words match the known lyrics?
                                 (tier-1 and tier-2 scored separately)
  2. truth-injected score     — known lyrics + the take's skeleton -> target score;
     + score-melody error     — score note_pitch vs the take's own FCPE contour:
                                 was the score even RIGHT about the melody before any
                                 render? (the Basic-Pitch-on-vocals question)
PAID stage (driven separately via remote/remote_sing.sh):
  3. render conformance       — overlap.score_conformance on the render (did the model
                                 sing what it was told?) + end-to-end overlap.

Usage:
  calibrate_loop.py --take pella.wav --truth goingdown-lyrics.txt --bpm 91
                    --t0 0 --t1 22 --out outdir [--no-llm]
"""
from __future__ import annotations

import argparse
import json
import os
import struct
import sys
import tempfile
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

import diagnose                      # noqa: E402
import overlap as ov                 # noqa: E402
from skeleton import core as skcore  # noqa: E402
from skeleton import align as skalign  # noqa: E402
from phonology import core as ph     # noqa: E402


def truth_lines(path: str):
    """Known lyrics -> list of per-line word lists (lead vocal only)."""
    out = []
    for line in open(path):
        s = line.strip()
        if not s or s.startswith("#") or s.startswith("("):
            continue
        out.append([w.strip(".,!?\"") for w in s.split() if w.strip(".,!?\"")])
    return out


def slice_excerpt(src: str, t0: float, t1: float, dst: str) -> str:
    r = skcore.read_pcm_mono(src)
    if not r:
        raise SystemExit(f"take not stdlib-readable: {src}")
    mono, sr = r
    seg = mono[int(t0 * sr): int(t1 * sr)]
    with wave.open(dst, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(b"".join(struct.pack("<h", max(-32767, min(32767, int(v * 32767))))
                               for v in seg))
    return dst


def truth_words(path: str):
    """Known lyrics -> ordered word list (lead vocal only: comments and parenthesised
    response lines dropped), with syllable counts."""
    pr = ph.Pronouncer()
    words = []
    for line in open(path):
        s = line.strip()
        if not s or s.startswith("#") or s.startswith("("):
            continue
        for w in s.split():
            c = "".join(ch for ch in w.lower() if ch.isalpha() or ch == "'")
            if c:
                words.append({"word": w.strip(".,!?\""), "syl": max(1, pr.syllables(c) or 1)})
    return words


def inject_truth(spec: dict, truth):
    """Assign the known lyrics to lines by singing order: each line consumes truth words
    until its syllable budget (slot count) is met. Deterministic greedy; leftover slots
    at the end sing 'la' (flagged). Returns (lines_for_score, assignment_table)."""
    ti = 0
    table = []
    lines = []
    for ln, sc in zip(spec["lines"], spec.get("lineScores") or []):
        slots = len(sc["slots"])
        got, syl = [], 0
        while ti < len(truth) and syl < slots:
            got.append(truth[ti]["word"])
            syl += truth[ti]["syl"]
            ti += 1
        text = " ".join(got) if got else "la"
        lines.append({"text": text, "score": sc})
        table.append({"bar": sc["bar"], "slots": slots, "text": text, "sylAssigned": syl})
    return lines, table, ti


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--take", required=True)
    ap.add_argument("--truth", required=True)
    ap.add_argument("--bpm", type=float, required=True)
    ap.add_argument("--t0", type=float, default=0.0)
    ap.add_argument("--t1", type=float, default=22.0)
    ap.add_argument("--grid", default="1/16")
    ap.add_argument("--out", required=True)
    ap.add_argument("--no-llm", action="store_true")
    ap.add_argument("--align", action="store_true",
                    help="also forced-align the known words to the take and emit "
                         "target_score_aligned.json (the over-segmentation root fix)")
    ap.add_argument("--min-syl-dur", type=float, default=0.14,
                    help="minimum singable seconds/syllable; 0 = LOCK onsets exactly to the "
                         "take (no redistribution), 0.14 = stretch crammed words to be singable")
    ap.add_argument("--whisper-model", default="small")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    bp_py = diagnose._venv_python("transcribe/.transcribe.env", "BASIC_PITCH_PY")
    sk_py = diagnose._venv_python("skeleton/.skeleton.env", "SKELETON_PY")
    wh_py = diagnose._venv_python("whisper/.whisper.env", "WHISPER_PY")
    if not bp_py:
        print("FATAL: Basic Pitch venv missing", file=sys.stderr)
        return 2

    excerpt = os.path.join(args.out, "excerpt.wav")
    slice_excerpt(args.take, args.t0, args.t1, excerpt)
    truth = truth_words(args.truth)
    print(f"excerpt {args.t0}-{args.t1}s -> {excerpt}; truth pool {len(truth)} words")

    print("models: basic pitch / FCPE / whisper …", flush=True)
    notes = diagnose._run_json(bp_py, os.path.join(REPO, "service/transcribe/transcribe_cli.py"),
                               excerpt, "mono").get("notes") or []
    f0 = None
    if sk_py:
        r = diagnose._run_json(sk_py, os.path.join(REPO, "service/skeleton/skeleton_cli.py"), excerpt)
        f0 = r.get("f0") if r.get("ok") else None
    pcm = skcore.read_pcm_mono(excerpt)
    env = skcore.energy_envelope(pcm[0], pcm[1]) if pcm else None
    words = None
    if wh_py:
        res = diagnose._run_json(wh_py, os.path.join(REPO, "service/whisper/whisper_cli.py"),
                                 excerpt, args.whisper_model)
        if res.get("ok"):
            pr = ph.Pronouncer()
            words = []
            for w in res.get("words", []):
                c = str(w.get("word", "")).strip(" .,!?'\"-").lower()
                if any(ch.isalpha() for ch in c):
                    words.append({"word": str(w.get("word", "")).strip(),
                                  "start": float(w["start"]), "end": float(w["end"]),
                                  "confidence": float(w.get("confidence", 0) or 0),
                                  "syl": pr.syllables(c) or 1})
    print(f"  notes={len(notes)} f0={'yes' if f0 else 'NO'} words={len(words or [])}")

    report = {"v": 1, "take": os.path.abspath(args.take),
              "excerpt": [args.t0, args.t1], "bpm": args.bpm}
    truth_flat = [t["word"] for t in truth]

    # ── skeleton + truth injection FIRST (its `consumed` bounds the truth pool to the
    #    words the excerpt actually contains — scoring extraction against the whole
    #    song's vocabulary would depress the number artificially) ────────────────────────
    spec = skcore.build_skeleton_spec(notes, f0=f0, bpm=args.bpm, grid=args.grid,
                                      env=env, words=words)   # v3/v4 skeleton, wordless
    if not spec.get("ok"):
        print(f"FATAL: {spec.get('error')}", file=sys.stderr)
        return 1
    lines, table, consumed = inject_truth(spec, truth)
    truth_excerpt = truth_flat[:consumed]

    # ── row 1: extraction vs truth (tier 1 and tier 2) ─────────────────────────────────
    for label, use_llm in (("t1", False),) + ((("t2", True),) if not args.no_llm else ()):
        spec_x = skcore.build_skeleton_spec(notes, f0=f0, bpm=args.bpm, grid=args.grid,
                                            env=env, words=words,
                                            extract_lyrics=True, extract_use_llm=use_llm)
        kept = [w["word"] for hb in (spec_x.get("lineHeard") or []) if hb
                for w in hb["words"] if w["kept"]]
        report[f"extraction_{label}"] = {**ov.word_match(truth_excerpt, kept),
                                         "stats": spec_x.get("skeleton", {}).get("extraction")}
        print(f"extraction {label}: kept={len(kept)} vs excerpt truth ({len(truth_excerpt)} words) -> "
              f"{report[f'extraction_{label}']['bag_coverage']} bag / "
              f"{report[f'extraction_{label}']['seq_ratio']} seq")
    from soulx import score as sx
    r = sx.author_score(lines, name="calibrate")
    if not r.get("ok"):
        print(f"FATAL: {r.get('error')}", file=sys.stderr)
        return 1
    clip = r["score"][0]
    json.dump(r["score"], open(os.path.join(args.out, "target_score.json"), "w"), indent=1)
    # NO onset sub-metric on the take row: slot timing IS take-derived by construction,
    # and legato vocals keep the energy gate open (~6 onsets in 22s — measured), so a
    # word-starts-vs-gate-onsets F1 conflates gate sensitivity with alignment. Pitch is
    # the honest content here; onset agreement belongs to the RENDER row.
    conf = ov.score_conformance(clip, f0 or [])
    report["truth_assignment"] = table
    report["truth_words_consumed"] = [consumed, len(truth)]
    report["score_vs_take"] = conf
    print("\ntruth-injected lines:")
    for row in table:
        print(f"  bar {row['bar']:>2} ({row['slots']} slots): {row['text']}")
    print(f"\nSCORE vs TAKE (was the score right about the melody?):")
    print(f"  pitch |Δ| median {conf['pitch_abs_median_st']} st | within 0.5st {conf['pitch_within_half_st']} | "
          f"within 1st {conf['pitch_within_1_st']} (over {conf['voiced_events']} voiced events)")

    # ── the free input-side lever: RE-PITCH the score from the take's own F0 ──────────
    # (segment-median F0 -> note_pitch; auto-tune-lite without any DSP). If this closes
    # the melody row, the product fix is per-segment F0 pitch in the score author.
    if f0:
        import math as _m
        f0_pts = sorted(({"t": float(p["t"]), "hz": float(p.get("hz", 0) or 0)}
                         for p in f0 if float(p.get("hz", 0) or 0) > 0), key=lambda p: p["t"])
        durs = [float(d) for d in clip["duration"].split()]
        pitches = [int(p) for p in clip["note_pitch"].split()]
        types = [int(t) for t in clip["note_type"].split()]
        new_p, t = [], 0.0
        repitched = 0
        for d, p, nt in zip(durs, pitches, types):
            if nt in (2, 3):
                hz = [q["hz"] for q in f0_pts if t <= q["t"] < t + d]
                if hz:
                    hz.sort()
                    q = int(round(69 + 12 * _m.log2(hz[len(hz) // 2] / 440.0)))
                    if q != p:
                        repitched += 1
                    p = q
            new_p.append(p)
            t += d
        clip_re = dict(clip, note_pitch=" ".join(str(p) for p in new_p))
        conf_re = ov.score_conformance(clip_re, f0)
        report["score_vs_take_repitched"] = {**conf_re, "events_repitched": repitched}
        json.dump([clip_re], open(os.path.join(args.out, "target_score_repitched.json"), "w"), indent=1)
        print(f"\nREPITCHED score (segment-median F0 -> note_pitch; {repitched} events changed):")
        print(f"  pitch |Δ| median {conf_re['pitch_abs_median_st']} st | within 0.5st "
              f"{conf_re['pitch_within_half_st']} | within 1st {conf_re['pitch_within_1_st']}")

    # ── the ROOT input-side fix: FORCED-ALIGN the known words to the take ──────────────
    # Instead of draping truth words over the blind (over-segmented) skeleton slots, align
    # each known word to its own audio span (MMS_FA), then emit exactly its syllable count
    # of slots. A held note becomes ONE slot -> ONE clean onset, killing the "down down"
    # re-articulation at the source. Writes target_score_aligned.json for the render.
    if args.align and skalign.available():
        tl = truth_lines(args.truth)
        flat, line_counts, used = [], [], 0
        for lw in tl:                                    # take whole lines until the excerpt's word budget
            if used >= consumed:
                break
            take = lw[:max(0, consumed - used)]
            if take:
                flat += take
                line_counts.append(len(take))
                used += len(take)
        aligned = skalign.align_words(excerpt, flat)
        if aligned:
            alines = skalign.lines_from_aligned(aligned, line_counts, f0=f0, bpm=args.bpm,
                                                grid=args.grid, take_env=env, env_hop_s=0.01,
                                                min_syl_dur=args.min_syl_dur)
            ra = sx.author_score(alines, name="calibrate")
            if ra.get("ok"):
                clip_a = ra["score"][0]
                json.dump(ra["score"], open(os.path.join(args.out, "target_score_aligned.json"), "w"), indent=1)
                conf_a = ov.score_conformance(clip_a, f0 or [])
                report["aligned"] = {"words_aligned": len(aligned), "events": ra["events"],
                                     "word_events": ra["words"], "score_vs_take": conf_a,
                                     "spans": [{"w": a["word"], "s": round(a["start"], 2),
                                                "e": round(a["end"], 2)} for a in aligned]}
                print(f"\nALIGNED score ({len(aligned)} words forced-aligned to the take):")
                print(f"  events={ra['events']} word_events={ra['words']} "
                      f"pitch |Δ| median {conf_a['pitch_abs_median_st']}st | "
                      f"within 0.5st {conf_a['pitch_within_half_st']}")
                print(f"  -> {args.out}/target_score_aligned.json")
        else:
            print("\nALIGNED: forced alignment returned nothing (skipped)")
    elif args.align:
        print("\nALIGNED: forced-alignment stack unavailable (torch/torchaudio/uroman) — skipped")

    json.dump(report, open(os.path.join(args.out, "calibration-report.json"), "w"), indent=1)
    print(f"\nreport -> {args.out}/calibration-report.json")
    print(f"score  -> {args.out}/target_score.json  (render via remote/remote_sing.sh, "
          f"then overlap.score_conformance on the render = the model row)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
