#!/usr/bin/env python3
"""Sketch Phase 0 — beatbox WAV -> 3-class drum hits on a 16th grid.

The narrowest proof of the embodied-capture wedge: a recorded beatbox + a KNOWN
tempo becomes a recognisable drum pattern. This CLI is the deterministic transduction
layer (the native side turns the hits into MoshOps). Runs UNDER the dedicated sketch
venv (~/Library/Mosh/venvs/sketch), invoked by service/server.py's /sketch endpoint as a
subprocess, so librosa's deps (numpy/scipy/numba/soundfile) never touch the service
interpreter.

Pipeline (FIXED params, NO RNG -> byte-identical output for the same WAV + bpm + bars):
  1. onset detection  (librosa.onset.onset_detect, backtracked to the transient)
  2. per-onset 3-class heuristic on a short post-onset window:
       kick  -> low-frequency dominant (energy < ~150 Hz, low spectral centroid)
       hat   -> noisy/high            (high ZCR, high centroid, high flatness)
       snare -> mid-band + noisy      (between the two)
  3. quantise each onset to the nearest 16th on the KNOWN tempo grid
  4. velocity from onset energy (relative to the loudest hit in the take)

Emits ONLY JSON to stdout (all librosa/numba chatter is routed to stderr):
  {"ok": true, "bpm": 90.0, "bars": 1,
   "hits": [{"step": 0, "role": "kick", "velocity": 112}, ...]}

Usage:  beatbox_cli.py <input-wav> <bpm> [bars]
"""
import json
import sys

# librosa / numba emit progress + warnings; capture the REAL stdout up front and route
# every library write to stderr, so stdout carries ONLY our JSON result for the service.
_OUT = sys.stdout
sys.stdout = sys.stderr

# Fixed analysis constants — part of the determinism contract. Do not vary at runtime.
SR = 22050          # resample target (librosa default); fixes the spectral grid
HOP = 512           # onset hop length
WIN_S = 0.06        # post-onset analysis window (~60 ms)
PAD_S = 0.10        # front-pad of silence so the downbeat (a transient at t≈0) is
                    # detectable — librosa's onset envelope needs a rising edge, and
                    # a hit at sample 0 has no pre-context. Times are de-padded after.
ROLE_RANK = {"kick": 0, "snare": 1, "hat": 2}   # stable output ordering


def _emit_fail(msg: str) -> "None":
    _OUT.write(json.dumps({"ok": False, "error": msg}))
    sys.exit(1)


def _classify(low: float, mid: float, cent: float) -> str:
    """3-class vocal-percussion heuristic (Phase 0) keyed on coarse band energy:
       kick  — sub/low-frequency dominant (energy < 150 Hz)
       snare — significant MID-band body (150-2000 Hz), broadband on top
       hat   — neither (little low, little mid): a thin, high, noisy transient
    A trained classifier across the full drum vocab is Phase 1."""
    if low > 0.40 or cent < 400.0:
        return "kick"
    if mid >= 0.20:
        return "snare"
    return "hat"


def main() -> "None":
    if len(sys.argv) < 3:
        _emit_fail("usage: beatbox_cli.py <input-wav> <bpm> [bars]")
    wav_path = sys.argv[1]
    try:
        bpm = float(sys.argv[2])
    except ValueError:
        _emit_fail("bpm must be a number")
    bars = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    bars = 1 if bars < 1 else (2 if bars > 2 else bars)
    if bpm < 20.0 or bpm > 300.0:
        _emit_fail("bpm out of range (20-300; the tempo is known — box to a click)")

    try:
        import numpy as np
        import librosa
    except Exception as e:  # noqa: BLE001 — surface any import failure as JSON
        _emit_fail(f"librosa not importable: {e}")

    try:
        y, sr = librosa.load(wav_path, sr=SR, mono=True)
    except Exception as e:  # noqa: BLE001
        _emit_fail(f"could not read audio: {e}")

    if y.size == 0:
        _OUT.write(json.dumps({"ok": True, "bpm": bpm, "bars": bars, "hits": []}))
        return

    # Front-pad so a transient at t≈0 (the downbeat) has a rising edge to detect; subtract
    # the pad from every onset time before quantising. Analysis windows index the padded
    # signal (the pad is silence, so it never adds spurious onsets or alters features).
    pad = int(PAD_S * sr)
    yp = np.concatenate([np.zeros(pad, dtype=y.dtype), y])

    onset_frames = librosa.onset.onset_detect(y=yp, sr=sr, hop_length=HOP,
                                              backtrack=True, units="frames")
    onset_times = librosa.frames_to_time(onset_frames, sr=sr, hop_length=HOP)

    sec_per_16th = 60.0 / bpm / 4.0
    total_steps = bars * 16
    win = int(WIN_S * sr)

    # Pass 1 — features per onset (single FFT per window keeps it window-size robust and
    # free of librosa's frame-length pitfalls on short segments). `t` is padded time.
    feats = []
    for t in onset_times:
        i0 = int(round(float(t) * sr))
        seg = yp[i0:i0 + win]
        if seg.size < 64:
            continue
        w = seg * np.hanning(seg.size)
        mag = np.abs(np.fft.rfft(w))
        freqs = np.fft.rfftfreq(seg.size, 1.0 / sr)
        total = float(mag.sum()) + 1e-9
        cent = float((freqs * mag).sum() / total)
        low = float(mag[freqs < 150.0].sum() / total)
        mid = float(mag[(freqs >= 150.0) & (freqs < 2000.0)].sum() / total)
        rms = float(np.sqrt(np.mean(seg ** 2)))
        feats.append((float(t) - PAD_S, low, mid, cent, rms))

    if not feats:
        _OUT.write(json.dumps({"ok": True, "bpm": bpm, "bars": bars, "hits": []}))
        return

    max_rms = max(f[4] for f in feats) or 1.0

    # Pass 2 — classify, quantise, score velocity. Dedupe per (step, role): a kick and a
    # hat can share a step (common on the downbeat); two of the SAME role on one step keep
    # the louder. Deterministic throughout.
    best: "dict[tuple[int, str], int]" = {}
    for (t, low, mid, cent, rms) in feats:
        role = _classify(low, mid, cent)
        step = int(round(t / sec_per_16th)) % total_steps
        vel = int(round(40 + 87 * (rms / max_rms)))
        vel = 1 if vel < 1 else (127 if vel > 127 else vel)
        key = (step, role)
        if key not in best or vel > best[key]:
            best[key] = vel

    hits = [{"step": s, "role": r, "velocity": v} for (s, r), v in best.items()]
    hits.sort(key=lambda h: (h["step"], ROLE_RANK.get(h["role"], 9)))
    _OUT.write(json.dumps({"ok": True, "bpm": bpm, "bars": bars, "hits": hits}))


if __name__ == "__main__":
    main()
