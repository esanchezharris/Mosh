#!/usr/bin/env python3
"""Stage 4 — run the REAL pipeline on the owner's REAL mumbles, in his own voice, and score
it against the finished takes and the human band.

This is the measurement the whole benchmark exists for, with every confound the NUS lane
carried finally removed:
  * the input is a REAL mumble (real rough-draft prosody), not a synthetic degradation;
  * the reference is a REAL finished vocal of the same song on the same session clock;
  * the render uses the owner's OWN enrolled voice, so it is in-voice — f0 and register are
    finally comparable rather than cross-voice.

Arms per window: `mumble` (the floor — hand the draft back unchanged) and `pipeline`
(author_score on the true words + the MUMBLE's F0 → local SoulX). Scored with the
singing-capable forced-align word ruler (read against the ~0.36 human ceiling), onset F1,
and pq.

ANTI-ECHO: every arm is scored against BOTH the reference and its own INPUT. A system that
merely hands back its input scores well on distance-to-reference while correlating ~1.0 with
the mumble — the trap that killed the ACE cover lane. Either number alone is fakeable; the
pair is not.

Run:  bench_own_run.py [--t0 0 --t1 12] [--songs LookinBack]
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


def slice_wav(src_mono, sr, a, b, dst):
    seg = src_mono[int(a * sr):int(b * sr)]
    w = wave.open(dst, "wb")
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(sr)
    w.writeframes(b"".join(struct.pack("<h", int(max(-32767, min(32767, x * 32767)))) for x in seg))
    w.close()
    return dst


def _snap_arm(pipe_wav, ref_wav, out_dir, base):
    """The PRODUCT's phrase-level timing snap (`soulx.perform.snap_render_to_take`), which
    the shipping sing adapter applies after rendering. Without this arm the run measures a
    raw render rather than the product chain — a control worth having, since timing is where
    the pipeline is weakest. Per-word snap is deliberately absent (removed in V3: it raised
    the alignment metric while damaging the sound). Returns None if anything is missing."""
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(HERE)), "service"))
    try:
        import numpy as np
        import soundfile as sf
        from skeleton.core import read_pcm_mono
        from soulx.perform import resample_hq, snap_render_to_take
        score_json = os.path.join(out_dir, os.path.splitext(os.path.basename(pipe_wav))[0] + "_score.json")
        if not os.path.isfile(score_json):
            return None
        clip = json.load(open(score_json))
        clip = clip[0] if isinstance(clip, list) else clip
        take, sr = read_pcm_mono(ref_wav)
        ren, sr_r = read_pcm_mono(pipe_wav)
        ren = resample_hq(list(ren), sr_r, sr) if sr_r != sr else list(ren)
        out = os.path.join(out_dir, base + "_pipeline_snap.wav")
        sf.write(out, np.asarray(snap_render_to_take(list(take), ren, sr, clip), dtype=np.float32),
                 sr, subtype="PCM_16")
        return out
    except Exception:
        return None


def _dynamics_arm(src_wav, ref_wav, out_dir, base, mode):
    """Apply a dynamics probe to an already-timing-snapped render. LAB ONLY — see
    bench_dynamics_probe. Returns None if anything is missing."""
    try:
        import numpy as np
        import soundfile as sf
        from skeleton.core import read_pcm_mono
        import bench_dynamics_probe as dp
        score_json = os.path.join(out_dir, base + "_pipeline_score.json")
        clip = json.load(open(score_json)) if os.path.isfile(score_json) else None
        clip = (clip[0] if isinstance(clip, list) else clip) if clip else None
        take, sr = read_pcm_mono(ref_wav)
        ren, sr_r = read_pcm_mono(src_wav)
        if sr_r != sr:
            return None
        if mode == "frame":
            outv = dp.transfer_envelope_frame(list(take), list(ren), sr)
        else:
            if not clip:
                return None
            outv = dp.transfer_envelope_note(list(take), list(ren), sr, clip)
        out = os.path.join(out_dir, f"{base}_dyn_{mode}.wav")
        sf.write(out, np.asarray(outv, dtype=np.float32), sr, subtype="PCM_16")
        return out
    except Exception:
        return None


def wav_duration_s(path):
    with wave.open(path, "rb") as w:
        return w.getnframes() / float(w.getframerate())


def run_item(item, t0, t1, out_dir, *, durations="verbatim", convention="syllable",
             note_floor_s=0.0, melody="mumble", skip_dyn=False, author_extra=None,
             chunk_s=None):
    import bench_align
    import bench_human_baseline as hb
    import bench_naturalness
    import bench_pipeline_render as pr
    import mumble_probe as mp
    import overlap

    os.makedirs(out_dir, exist_ok=True)
    base = f"{item['song']}_{int(t0)}-{int(t1)}"

    fin, sr = mp._read_mono(item["clean_vocal"])
    mum, sr_m = mp._read_mono(item["mumble_vocal"])
    ref_slice = slice_wav(fin, sr, t0, t1, os.path.join(out_dir, base + "_reference.wav"))
    mum_slice = slice_wav(mum, sr_m, t0, t1, os.path.join(out_dir, base + "_mumble.wav"))

    # THE REAL PIPELINE — F0 from the MUMBLE (never the finished take), owner's own voice.
    pipe = os.path.join(out_dir, base + "_pipeline.wav")
    f0_from = "clean_vocal" if melody == "finished" else "mumble_vocal"
    pipe, true_words = pr.pipeline_generate(item, pipe, t0=t0, t1=t1, f0_from=f0_from,
                                            durations=durations, convention=convention,
                                            note_floor_s=note_floor_s, author_extra=author_extra,
                                            chunk_s=chunk_s)
    snapped = _snap_arm(pipe, ref_slice, out_dir, base)

    ref_mono = fin[int(t0 * sr):int(t1 * sr)]
    out = {"item": item["id"], "window": [t0, t1], "n_true_words": len(true_words),
           "durations": durations, "melody": melody, "arms": {}}
    arms = [("reference", ref_slice), ("mumble", mum_slice), ("pipeline", pipe)]
    if snapped:
        arms.append(("pipeline+snap", snapped))
        # L3/L4 — dynamics probes, applied on TOP of the snapped arm (timing first, then
        # loudness). Lab-only: `frame` is the ear-rejected implementation, kept purely as a
        # measuring stick; `note` is the Phase-2 hypothesis. Skippable for iterate rounds.
        if not skip_dyn:
            for mode in ("frame", "note"):
                d = _dynamics_arm(snapped, ref_slice, out_dir, base, mode)
                if d:
                    arms.append((f"snap+dyn:{mode}", d))
    for name, wav in arms:
        g, g_sr = mp._read_mono(wav)
        rep = overlap.analyze(ref_mono, sr, g, g_sr)
        out["arms"][name] = {
            "word_align": bench_align.word_align_score(wav, true_words),
            "onset_f1": (rep.get("onsets") or {}).get("f1"),
            "pq": bench_naturalness.pq_score(wav),
            "corr_to_reference": hb.energy_corr(ref_slice, wav),
            "corr_to_input": hb.energy_corr(mum_slice, wav),   # anti-echo
            "wav": wav,
        }
    return out


def _fmt(v, w=7, p=3):
    return f"{v:{w}.{p}f}" if isinstance(v, (int, float)) else f"{'·':>{w}}"


# The human-to-human band, measured in the human-baseline verdict: two genuine takes of the
# same song correlate 0.40–0.44. The target is TWO-SIDED. Landing inside is success; landing
# ABOVE means the envelope was painted on rather than transferred, which is the "I can hear
# the volume automation" failure — and treating it as failure is what stops this metric being
# optimized into the V3 trap (a number improving while the sound degrades).
BAND_LO, BAND_HI, OVERSHOOT = 0.40, 0.44, 0.90


def _band_verdict(corr):
    if not isinstance(corr, (int, float)):
        return ""
    if corr > OVERSHOOT:
        return "OVERSHOOT — painted, not transferred (FAIL)"
    if corr >= BAND_LO:
        return "IN BAND ✓" if corr <= BAND_HI else "above band (near-copy?)"
    return f"below band (gap {BAND_LO - corr:+.3f})"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--t0", type=float, default=0.0)
    ap.add_argument("--t1", type=float, default=12.0)
    ap.add_argument("--songs")
    ap.add_argument("--fixed-window", action="store_true",
                    help="ignore per-song phrase windows and use --t0/--t1")
    ap.add_argument("--full-span", action="store_true",
                    help="render the ENTIRE paired span (word-campaign vehicle): t0=0, "
                         "t1=the finished take's duration; the authored score is chunked "
                         "≤12 s at melisma-safe breaks and reassembled on the span clock")
    ap.add_argument("--durations", default="verbatim",
                    help="verbatim (shipped default) | derived (B1-lite)")
    ap.add_argument("--convention", default="syllable",
                    help="syllable (shipped) | soulx (whole-word notes, melody-driven melisma)")
    ap.add_argument("--note-floor-s", type=float, default=0.0,
                    help="minimum sung-note duration (SoulX p5 ~0.15); 0 = off")
    ap.add_argument("--soulx", action="store_true",
                    help="shortcut: --convention soulx --durations derived --note-floor-s 0.15")
    ap.add_argument("--melody", default="mumble", choices=["mumble", "finished"],
                    help="melody/F0 source. 'finished' = the ORACLE arm: sing the finished "
                         "take's own melody (development ceiling — deliberate, labeled use "
                         "of the ground truth; the product benchmark arm stays 'mumble')")
    ap.add_argument("--skip-dyn", action="store_true",
                    help="skip the (refuted) dynamics probe arms — faster iterate rounds")
    ap.add_argument("--sustain-chain-s", type=float, default=0.0,
                    help="split sung notes longer than this into same-pitch continuation "
                         "chains (the V4b melisma 'keep singing' command); 0 = off")
    ap.add_argument("--syl-budget-s", type=float, default=0.0,
                    help="lyric-enforced per-syllable time floor: a word gets at least "
                         "nsyl x this, claiming its quiet tail from the following gap "
                         "(same phrase only); 0 = off")
    ap.add_argument("--stress-redeal", type=float, default=0.0,
                    help="L1 word-campaign lever: when a word's 1:1 F0 segments hold a "
                         "sub-floor sliver (< this many seconds), re-deal the word's span "
                         "by syllable stress (the pinata stress-inversion fix); 0 = off")
    ap.add_argument("--key-snap", action="store_true",
                    help="snap commanded pitches to the song key from <song>.meta.json "
                         "(score-side autotune; no-op for songs without meta)")
    ap.add_argument("--swap-word", action="append", default=[],
                    help="DIAGNOSTIC lyric substitution 'from=to' (repeatable). Applied "
                         "to the in-memory payload words only — the installed words.json "
                         "is never touched; timing/phrase fields ride along unchanged. "
                         "Match is casefolded + diacritic-folded.")
    ap.add_argument("--out", default=os.path.expanduser("~/mosh-fms-ksb/bench/own-run"))
    a = ap.parse_args()

    conv = "soulx" if a.soulx else a.convention
    dur_mode = "derived" if a.soulx else a.durations
    floor = 0.15 if a.soulx else a.note_floor_s

    import bench_own_pairs as op
    items = op.own_pairs_items(songs=a.songs.split(",") if a.songs else None)
    os.makedirs(a.out, exist_ok=True)

    def _fold(w):
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(HERE)), "service"))
        from phonology.core import fold_diacritics
        return fold_diacritics(str(w)).casefold()

    swaps = {}
    for spec in a.swap_word:
        src, _, dst = spec.partition("=")
        if not dst:
            raise SystemExit(f"--swap-word needs 'from=to', got {spec!r}")
        swaps[_fold(src)] = dst
    if swaps:
        print(f"  DIAGNOSTIC (not blind): word swap {swaps} — payload-only, "
              f"installed words.json untouched", flush=True)

    rows = []
    for it in items:
        # Per-song PHRASE-ALIGNED window when bench_lyrics installed one. A fixed stopwatch
        # cut truncates mid-phrase ("Helena Bonham-", "got a good one and I-"), corrupting
        # both the render and the scoring at the boundary; ending on a real breath does not.
        t0, t1 = a.t0, a.t1
        wj = os.path.join(os.path.dirname(it["clean_vocal"]), f"{it['song']}.window.json")
        if a.full_span:
            t0, t1 = 0.0, wav_duration_s(it["clean_vocal"])
        elif not a.fixed_window and os.path.isfile(wj):
            w = json.load(open(wj))
            t0, t1 = float(w["t0"]), float(w["t1"])
        # owner-supplied ground truth (key/bpm) — always recorded for diagnostics,
        # only ACTS on the score when --key-snap is passed
        mj = os.path.join(os.path.dirname(it["clean_vocal"]), f"{it['song']}.meta.json")
        meta = json.load(open(mj)) if os.path.isfile(mj) else {}
        if swaps:
            it = dict(it, words=[dict(w, word=swaps.get(_fold(w.get("word", "")),
                                                        w.get("word", "")))
                                 for w in it["words"]])
        print(f"  {it['id']} [{t0:.2f}-{t1:.2f}s] …", flush=True)
        try:
            extra = {}
            if a.sustain_chain_s > 0:
                extra["sustainChainS"] = a.sustain_chain_s
            if a.syl_budget_s > 0:
                extra["sylBudgetS"] = a.syl_budget_s
            if a.stress_redeal > 0:
                extra["stressRedeal"] = a.stress_redeal
            if a.key_snap and meta.get("key"):
                extra["key"] = meta["key"]
            row = run_item(it, t0, t1, a.out, durations=dur_mode,
                           convention=conv, note_floor_s=floor,
                           melody=a.melody, skip_dyn=a.skip_dyn,
                           author_extra=extra or None,
                           chunk_s=12.0 if a.full_span else None)
            if meta:
                row["meta"] = meta
            if swaps:
                row["swapWord"] = dict(swaps)
            rows.append(row)
        except Exception as e:
            print(f"    FAILED: {str(e)[:220]}", flush=True)
    json.dump(rows, open(os.path.join(a.out, "own_run.json"), "w"), indent=1, sort_keys=True)

    print(f"\n=== in-voice run on REAL mumbles ({a.t0:.0f}-{a.t1:.0f}s, conv={conv} dur={dur_mode} floor={floor} melody={a.melody}) ===")
    print(f"  {'song':16} {'arm':14} {'wordAlign':>10} {'hit':>6} {'onsetF1':>8} "
          f"{'→reference':>11} {'→input':>8} {'pq':>7}")
    for r in rows:
        for arm in ("reference", "mumble", "pipeline", "pipeline+snap", "snap+dyn:frame", "snap+dyn:note"):
            d = r["arms"].get(arm)
            if not d:
                continue
            wa = d.get("word_align") or {}
            print(f"  {r['item']:16} {arm:14} {_fmt(wa.get('mean_score'),10)} {_fmt(wa.get('hit_frac'),6,2)} "
                  f"{_fmt(d.get('onset_f1'),8)} {_fmt(d.get('corr_to_reference'),11)} "
                  f"{_fmt(d.get('corr_to_input'),8)} {_fmt(d.get('pq'),7,2)}")

    import bench_metrics as bm
    print("\n=== means (word recovery is read against the ~0.36 human ceiling) ===")
    for arm in ("reference", "mumble", "pipeline", "pipeline+snap", "snap+dyn:frame", "snap+dyn:note"):
        got = [r["arms"][arm] for r in rows if arm in r["arms"]]
        if not got:
            continue
        wa = bm.human_band([(g.get("word_align") or {}).get("mean_score") for g in got])
        ci = bm.human_band([g.get("corr_to_input") for g in got])
        cr = bm.human_band([g.get("corr_to_reference") for g in got])
        print(f"  {arm:14} wordAlign={_fmt(wa['mean'])}  →reference={_fmt(cr['mean'])}"
              f"  →input={_fmt(ci['mean'])}   "
              f"{'(identity)' if arm == 'reference' else _band_verdict(cr['mean'])}")
    print(f"\n  band = the human-to-human range {BAND_LO}-{BAND_HI}; OVERSHOOT (>{OVERSHOOT}) is a"
          f" FAILURE\n  (envelope painted on rather than transferred — the 'volume automation' percept)")
    print(f"\nwrote {os.path.join(a.out, 'own_run.json')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
