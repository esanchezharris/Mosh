#!/usr/bin/env python3
"""Voice-to-MIDI (transcribe_clip mono mode) — real pitch/segmentation proof.

Needs no Mosh binary: transcribe_clip's actual work happens entirely in
service/transcribe/transcribe_cli.py (a subprocess under the dedicated transcribe
venv), so this drives that CLI directly with synthesized, ground-truth-known
vocal-like audio and asserts on the returned note list — the same JSON contract
MoshOps::cmdTranscribeClip consumes.

WHY THIS EXISTS: the only prior coverage for transcribe_clip (src/app/SelfTest.cpp,
gated on MOSH_SELFTEST_TRANSCRIBE) feeds it a single flat 220Hz test tone and only
asserts ">=1 note" — a constant tone has no melody, glide, or vibrato, so it could
never have caught a real segmentation bug. It didn't: a 3-second sustained note with
ordinary singing vibrato (5.5Hz, 50 cents) fragmented into 11 spurious same-pitch
notes, every boundary at an exact 0ms gap. Fixed in transcribe_cli.py by merging
adjacent same-pitch notes separated by <=50ms (_merge_vibrato_fragments). This script
is the regression lock for that fix, plus a melody/timing sanity sweep (clean
stepwise notes, a legato glide with no silence or attack between notes, and
rhythmically loose/non-metronomic timing) so a future change to transcribe_cli.py or
its Basic Pitch params gets caught before it reaches a real singer.

Fixtures are synthesized deterministically (additive harmonic tone + soft
attack/release, no RNG) rather than committed as WAV binaries — the generator IS the
spec of what's being tested, and needs no repo storage.

Usage:
    python3 scripts/verify-hardware/voice_to_midi_check.py
Exit code 0 on all checks passing, 1 otherwise. Skips cleanly (exit 0, one-line
notice) if the transcribe venv isn't installed (service/transcribe/setup-transcribe.sh).
"""
import json
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
TRANSCRIBE_DIR = REPO / "service" / "transcribe"
SR = 22050


def _midi_to_hz(m):
    return 440.0 * 2 ** ((m - 69) / 12.0)


def _synth_tone(freq, dur, attack=0.03, release=0.03, harmonics=(1.0, 0.5, 0.25, 0.12, 0.06)):
    """A single tone at a constant Hz with soft attack/release (no percussive
    transient) and a few decaying harmonics — voice-shaped, not a pure sine."""
    n = int(dur * SR)
    phase = 2 * np.pi * freq * np.arange(n) / SR
    sig = sum(amp * np.sin(phase * h) for h, amp in enumerate(harmonics, start=1)) / sum(harmonics)
    env = np.ones(n)
    a, r = int(attack * SR), int(release * SR)
    if a: env[:a] *= np.linspace(0, 1, a)
    if r: env[-r:] *= np.linspace(1, 0, r)
    return sig * env


def _write_wav(path, sig):
    pcm = (np.clip(sig, -1.0, 1.0) * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def _gen_stepwise(path):
    """Clean melody, small silent gaps between notes — the easy baseline case."""
    melody, note_dur, gap = [60, 62, 64, 67, 64], 0.5, 0.08
    sig, gt, t = np.array([]), [], 0.0
    for m in melody:
        tone = _synth_tone(_midi_to_hz(m), note_dur)
        sig = np.concatenate([sig, tone])
        gt.append({"pitch": m, "start": t, "end": t + note_dur})
        t += note_dur + gap
        sig = np.concatenate([sig, np.zeros(int(gap * SR))])
    _write_wav(path, sig)
    return gt


def _gen_legato_glide(path):
    """Continuous portamento between notes: no silence, no clear attack at each note
    change — the failure mode most likely to break an onset-detection model."""
    melody, note_dur, glide_dur = [60, 62, 64, 67, 64], 0.45, 0.08
    n_per, n_glide = int(note_dur * SR), int(glide_dur * SR)
    freqs = [_midi_to_hz(m) for m in melody]
    full, boundaries = np.array([]), []
    for i, hz in enumerate(freqs):
        if i == 0:
            f = np.full(n_per, hz)
        else:
            f = np.concatenate([np.linspace(freqs[i - 1], hz, n_glide), np.full(n_per - n_glide, hz)])
        phase = 2 * np.pi * np.cumsum(f) / SR
        tone = sum(a * np.sin(phase * h) for h, a in enumerate((1.0, 0.5, 0.25, 0.12, 0.06), start=1)) / 1.93
        boundaries.append(len(full) / SR)
        full = np.concatenate([full, tone])
    a, r = int(0.03 * SR), int(0.03 * SR)
    env = np.ones(len(full)); env[:a] *= np.linspace(0, 1, a); env[-r:] *= np.linspace(1, 0, r)
    _write_wav(path, full * env)
    return [{"pitch": m, "start": b, "end": b + note_dur} for m, b in zip(melody, boundaries)]


def _gen_vibrato_sustain(path):
    """A single 3s sustained note with realistic singing vibrato (5.5Hz, 50 cents).
    Ground truth is ONE note — this is the regression lock for _merge_vibrato_fragments."""
    dur, base_m, base_hz = 3.0, 69, _midi_to_hz(69)
    t = np.arange(int(dur * SR)) / SR
    cents = 50 * np.sin(2 * np.pi * 5.5 * t)
    f = base_hz * 2 ** (cents / 1200.0)
    phase = 2 * np.pi * np.cumsum(f) / SR
    sig = sum(a * np.sin(phase * h) for h, a in enumerate((1.0, 0.5, 0.25, 0.12, 0.06), start=1)) / 1.93
    a, r = int(0.15 * SR), int(0.15 * SR)
    env = np.ones(len(sig)); env[:a] *= np.linspace(0, 1, a); env[-r:] *= np.linspace(1, 0, r)
    _write_wav(path, sig * env)
    return [{"pitch": base_m, "start": 0.0, "end": dur}]


def _gen_loose_timing(path):
    """Non-metronomic hummed timing (nothing on a grid) — transcribe_clip must not
    silently quantize; that's quantize_notes' job as a separate, opt-in step."""
    melody = [65, 67, 65, 72, 69]
    durs = [0.63, 0.41, 0.77, 0.35, 0.55]
    gaps = [0.12, 0.05, 0.09, 0.03]
    sig, gt, t = np.array([]), [], 0.0
    for i, (m, d) in enumerate(zip(melody, durs)):
        tone = _synth_tone(_midi_to_hz(m), d, attack=0.04, release=0.04)
        sig = np.concatenate([sig, tone])
        gt.append({"pitch": m, "start": t, "end": t + d})
        t += d
        if i < len(gaps):
            sig = np.concatenate([sig, np.zeros(int(gaps[i] * SR))])
            t += gaps[i]
    _write_wav(path, sig)
    return gt


CASES = {
    "stepwise":     _gen_stepwise,
    "legato_glide": _gen_legato_glide,
    "vibrato":      _gen_vibrato_sustain,
    "loose_timing": _gen_loose_timing,
}


def _basic_pitch_py():
    env_file = TRANSCRIBE_DIR / ".transcribe.env"
    if not env_file.exists():
        return None
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line.startswith("export BASIC_PITCH_PY="):
            py = line.split("=", 1)[1].strip().strip('"')
            return py if Path(py).exists() else None
    return None


def _run_transcribe(py, wav_path):
    proc = subprocess.run([py, str(TRANSCRIBE_DIR / "transcribe_cli.py"), str(wav_path), "mono"],
                           capture_output=True, text=True, timeout=60)
    return json.loads(proc.stdout), proc.stderr


def row(name, passed, detail):
    return {"name": name, "pass": passed, "detail": detail}


def main():
    py = _basic_pitch_py()
    if py is None:
        print("SKIP: transcribe venv not installed (run service/transcribe/setup-transcribe.sh)")
        return 0

    results = []
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        for case, gen in CASES.items():
            wav_path = tmp / f"{case}.wav"
            gt = gen(wav_path)
            out, stderr = _run_transcribe(py, wav_path)
            if not out.get("ok"):
                results.append(row(case, False, {"error": out.get("error"), "stderr": stderr[-400:]}))
                continue
            notes = out["notes"]
            got_pitches = [n["pitch"] for n in notes]
            gt_pitches = [n["pitch"] for n in gt]
            pitches_match = got_pitches == gt_pitches
            if case == "vibrato":
                # The regression lock: a vibrato sustain must NOT re-fragment. Allow
                # <=2 (a clean split at the exact center is harmless) but reject the
                # 11-piece fragmentation this check exists to catch.
                ok = pitches_match and len(notes) <= 2
                detail = {"got_pitches": got_pitches, "gt_pitches": gt_pitches, "note_count": len(notes)}
            else:
                # Onset timing has a small, consistent model latency (~10-50ms); a
                # generous 150ms tolerance separates that from a real timing bug.
                timing_ok = all(abs(n["start"] - g["start"]) < 0.15 for n, g in zip(notes, gt))
                ok = pitches_match and timing_ok
                detail = {"got_pitches": got_pitches, "gt_pitches": gt_pitches,
                          "starts": [round(n["start"], 3) for n in notes]}
            results.append(row(case, ok, detail))

    all_ok = all(r["pass"] for r in results)
    for r in results:
        mark = "PASS" if r["pass"] else "FAIL"
        print(f"[{mark}] {r['name']}: {json.dumps(r['detail'])}")
    print("voice_to_midi_check:", "ALL PASS" if all_ok else "FAILED")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
