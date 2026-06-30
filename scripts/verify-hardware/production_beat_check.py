#!/usr/bin/env python3
"""De-risk the production path: REAL sounds + a playable melodic 808.

Two render-to-WAV proofs against the live engine (assign_sample mode:"melodic" landed
in cmdAssignSample):

  A) MELODIC 808 REPITCH — load ONE 808 one-shot as a melodic sampler sound (root = MIDI
     36), trigger MIDI 36 then 48 (an octave up), non-overlapping. The output fundamental
     for note 48 must be ~2× the fundamental for note 36 (ratio test — robust to the
     sample's true native pitch). This proves "regular 808 functionality": pitched by the
     MIDI, no time-stretch. Also checks the note-length GATE (a short note's tail decays).

  B) FULL PRODUCTION BEAT — a real kit (kick/snare/hat/clap from ~/Downloads/musica via
     assign_sample) + the melodic 808 bass (in-key, non-overlapping) + a 4OSC lead, mixed
     and exported. Asserts non-silent + sane duration. This is the artifact to AUDITION.

Run with the teardown venv (numpy + soundfile via kit.py):
    service/teardown/.venv/bin/python scripts/verify-hardware/production_beat_check.py
"""
import os
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(HERE))                              # verify.py helpers
sys.path.insert(0, str(REPO / "service/teardown/probe"))  # kit.py real samples

from verify import ART, Ctx, find_binary, load_wav, mono, run_script, stats, failed_commands  # noqa: E402
import kit  # noqa: E402

# Bass MIDI: melodic-808 root and an octave-up note, well separated in time so each rings
# in isolation before the next note-on (non-overlapping == monophonic for the engine).
ROOT = 36          # C2 — the assign_sample melodic root (sample's native pitch maps here)
OCT = ROOT + 12    # one octave up → output fundamental should double


def _fundamental_hz(sig, sr, lo=30.0, hi=500.0):
    """Dominant spectral peak in [lo,hi] Hz of a mono segment (Hann + zero-pad)."""
    sig = np.asarray(sig, dtype=np.float64)
    sig = sig[np.argmax(np.abs(sig) > 1e-4):] if np.any(np.abs(sig) > 1e-4) else sig
    if sig.size < 2048:
        return 0.0
    w = sig * np.hanning(sig.size)
    n = 1 << int(np.ceil(np.log2(sig.size)) + 1)  # zero-pad ≥2× for resolution
    mag = np.abs(np.fft.rfft(w, n=n))
    freqs = np.fft.rfftfreq(n, 1.0 / sr)
    band = (freqs >= lo) & (freqs <= hi)
    if not band.any():
        return 0.0
    return float(freqs[band][int(np.argmax(mag[band]))])


def check_melodic_808_repitch(ctx):
    name = "Melodic 808 repitch (octave = 2x fundamental)"
    e8 = kit.eight08s()
    if not e8:
        return {"check": name, "pass": False, "detail": {"error": "no 808 one-shots resolved (kit.eight08s empty)"}}
    sample = e8[0]["asset"]
    out = ART / "08a_melodic_808.wav"
    bpm = 120
    # 1 beat = 0.5s @120. Two notes 2 beats apart, each 1.5 beats long (rings, then gated).
    notes = [
        {"pitch": ROOT, "start": 0.0, "length": 1.5, "velocity": 120},
        {"pitch": OCT,  "start": 2.0, "length": 1.5, "velocity": 120},
    ]
    cmds = [
        {"command": "set_tempo", "args": {"bpm": bpm}},
        {"command": "create_track", "args": {"name": "808"}, "capture": {"T": "trackId"}},
        {"command": "assign_sample", "args": {"trackId": "${T}", "file": sample, "note": ROOT,
                                              "name": "808", "mode": "melodic"}},
        {"command": "add_midi_clip", "args": {"trackId": "${T}", "start": 0, "length": 4, "notes": notes}},
        {"command": "export_audio", "args": {"file": str(out)}},
    ]
    results, proc = run_script(ctx.bin, cmds, "verify-melodic-808")
    fails = failed_commands(results)
    if fails or not out.exists():
        return {"check": name, "pass": False,
                "detail": {"failed_commands": fails, "exists": out.exists(), "stderr": proc.stderr[-500:]}}
    m, sr, _ = load_wav(out)
    m = mono(m)
    beat = sr * 60.0 / bpm
    # Note windows: note1 ≈ [0, 1.5 beats], note2 ≈ [2 beats, 3.5 beats].
    w1 = m[int(0.05 * beat): int(1.4 * beat)]
    w2 = m[int(2.05 * beat): int(3.4 * beat)]
    f1 = _fundamental_hz(w1, sr)
    f2 = _fundamental_hz(w2, sr)
    ratio = (f2 / f1) if f1 > 0 else 0.0
    # note-gate sanity: tail AFTER note2's note-off (3.5 beats) should be quieter than the body.
    body_rms = float(np.sqrt(np.mean(w2 ** 2))) if w2.size else 0.0
    tail = m[int(3.6 * beat): int(3.95 * beat)]
    tail_rms = float(np.sqrt(np.mean(tail ** 2))) if tail.size else 0.0
    st = stats(out)
    repitch_ok = 1.8 <= ratio <= 2.2                  # octave up → ~2×
    gated_ok = (tail_rms < 0.6 * body_rms + 1e-6)     # the sample is cut after note-off, not ringing full
    ok = bool(st["rms"] > 0.005 and f1 > 0 and repitch_ok and gated_ok)
    return {"check": name, "pass": ok,
            "detail": {"wav": str(out), "sample": Path(sample).name, "root_note": ROOT, "oct_note": OCT,
                       "f1_hz": round(f1, 2), "f2_hz": round(f2, 2), "ratio": round(ratio, 3),
                       "body_rms": round(body_rms, 5), "tail_rms": round(tail_rms, 5),
                       "repitch_ok": repitch_ok, "gated_ok": gated_ok, **st}}


def check_full_production_beat(ctx):
    name = "Full production beat (real kit + melodic 808 + lead)"
    kits = kit.load_kits()
    e8 = kit.eight08s()
    if not kits or not e8:
        return {"check": name, "pass": False,
                "detail": {"error": "no real kit or 808 resolved", "kits": len(kits), "e8": len(e8)}}
    k = kits[0]
    sample = e8[0]["asset"]
    out = ART / "08b_production_beat.wav"
    bars, bpm = 2, 140
    beats = bars * 4
    # Drums: kick on 1 & 3, snare on 2 & 4, hats in 8ths, a clap doubling the snare.
    drum_notes = []
    for b in range(beats):
        if b % 2 == 0:
            drum_notes.append({"pitch": kit.KICK_N, "start": b, "length": 0.5, "velocity": 122})
        else:
            drum_notes.append({"pitch": kit.SNARE_N, "start": b, "length": 0.5, "velocity": 110})
            drum_notes.append({"pitch": kit.CLAP_N, "start": b, "length": 0.5, "velocity": 95})
        for h in (0.0, 0.5):
            drum_notes.append({"pitch": kit.HAT_N, "start": b + h, "length": 0.25,
                               "velocity": 96 if h == 0.0 else 70})
    # 808 bass: a simple in-key line (C minor-ish), NON-OVERLAPPING (each note ends before
    # the next begins) so the monophonic 808 never overlaps itself.
    bass_pitches = [ROOT, ROOT, ROOT + 3, ROOT - 2, ROOT, ROOT + 7, ROOT + 3, ROOT]
    bass_notes = [{"pitch": p, "start": i, "length": 0.9, "velocity": 116} for i, p in enumerate(bass_pitches[:beats])]
    # Lead: a short 4OSC motif up an octave (the default melodic instrument).
    lead_pitches = [72, 75, 79, 75, 77, 75, 72, 70]
    lead_notes = [{"pitch": p, "start": i + 0.5, "length": 0.4, "velocity": 88} for i, p in enumerate(lead_pitches[:beats])]

    cmds = [{"command": "set_tempo", "args": {"bpm": bpm}},
            {"command": "create_track", "args": {"name": "Drums", "type": "drum"}, "capture": {"D": "trackId"}}]
    cmds += kit.kit_assign_fragment("${D}", k)
    cmds += [
        {"command": "add_midi_clip", "args": {"trackId": "${D}", "start": 0, "length": beats, "notes": drum_notes}},
        {"command": "create_track", "args": {"name": "808"}, "capture": {"B": "trackId"}},
        {"command": "assign_sample", "args": {"trackId": "${B}", "file": sample, "note": ROOT, "name": "808", "mode": "melodic"}},
        {"command": "add_midi_clip", "args": {"trackId": "${B}", "start": 0, "length": beats, "notes": bass_notes}},
        {"command": "set_track_volume", "args": {"trackId": "${B}", "value": 0.9}},
        {"command": "create_track", "args": {"name": "Lead"}, "capture": {"L": "trackId"}},
        {"command": "add_midi_clip", "args": {"trackId": "${L}", "start": 0, "length": beats, "notes": lead_notes}},
        {"command": "set_track_volume", "args": {"trackId": "${L}", "value": 0.5}},
        {"command": "export_audio", "args": {"file": str(out)}},
    ]
    results, proc = run_script(ctx.bin, cmds, "verify-production-beat", timeout=240)
    fails = failed_commands(results)
    if fails or not out.exists():
        return {"check": name, "pass": False,
                "detail": {"failed_commands": fails, "exists": out.exists(), "stderr": proc.stderr[-700:]}}
    st = stats(out)
    ok = bool(st["peak"] > 0.05 and st["rms"] > 0.01 and st["duration_s"] > 1.0)
    return {"check": name, "pass": ok,
            "detail": {"wav": str(out), "kit": k["id"], "808": Path(sample).name, "bpm": bpm, **st}}


def main():
    import argparse, json
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin")
    a = ap.parse_args()
    ART.mkdir(exist_ok=True)
    ctx = Ctx(find_binary(a.bin))
    print(f"binary: {ctx.bin}\nartifacts: {ART}\n")
    rows = [check_melodic_808_repitch(ctx), check_full_production_beat(ctx)]
    for r in rows:
        print(f"  [{'PASS' if r['pass'] else 'FAIL'}] {r['check']}")
        print(f"         {json.dumps(r['detail'])}")
    npass = sum(1 for r in rows if r["pass"])
    print(f"\n{npass}/{len(rows)} production checks passed")
    return 0 if npass == len(rows) else 1


if __name__ == "__main__":
    sys.exit(main())
