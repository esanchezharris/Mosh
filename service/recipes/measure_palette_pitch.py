#!/usr/bin/env python3
"""Pitch-truth pass over the palette: measure each pitched one-shot's REAL fundamental
from audio and correct the manifest's root_note (+ a human-readable note+octave label).

Why: heard pitch = sample's true pitch + (MIDI note − sampler root). The 2026-07 owner
audition showed root_note labels can be octaves off (beat-01 pad: labeled MIDI 36,
measured C4/60 — +24 st), which defeats every downstream register decision. The owner's
own diagnosis: "we clearly need to label our individual 808s with their note and octave."

    service/teardown/.venv/bin/python service/recipes/measure_palette_pitch.py           # dry-run report
    service/teardown/.venv/bin/python service/recipes/measure_palette_pitch.py --write   # backup + correct

Method per file: autocorrelation f0 over the post-attack body (50–550 ms), cross-checked
against the low-band spectral peak. Agreement (≤1.5 st) → measured, high confidence.
Spectral peak at an integer harmonic of the autocorr f0 → autocorr wins (the peak is a
harmonic), medium confidence. Anything else → UNMEASURABLE: the old root_note is kept and
the entry is tagged root_source:"inferred" so binding can prefer pitch-verified samples.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import time

PITCHED_ROLES = {"808", "bass", "melodic", "pad", "lead", "pluck"}
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def note_label(m: int) -> str:
    return f"{NOTE_NAMES[m % 12]}{m // 12 - 1}"


def measure_f0(path: str, fmax: float = 400.0):
    """(midi_float, confidence, detail) from audio; (None, 'unmeasurable', detail) on failure.
    fmax: top of the f0 search band — 400 Hz suits 808/bass; melodic one-shots can sit at
    C5+, where a 400 Hz cap pulls both methods onto subharmonics (adversarial-verification
    finding, 2026-07: a ~523 Hz sample measured C3 at 'medium' confidence)."""
    import numpy as np
    import soundfile as sf
    try:
        x, sr = sf.read(path)
    except Exception as e:  # unreadable file — report, never crash the pass
        return None, "unmeasurable", f"read-error {e}"
    if getattr(x, "ndim", 1) > 1:
        x = x.mean(axis=1)
    a = int(0.05 * sr)
    seg = x[a: min(len(x), a + int(0.5 * sr))]
    if len(seg) < sr // 10 or float(np.abs(seg).max()) < 1e-4:
        # very short one-shot: fall back to the whole file
        seg = x[: int(0.6 * sr)]
        if len(seg) < sr // 20 or float(np.abs(seg).max()) < 1e-4:
            return None, "unmeasurable", "too short/quiet"
    seg = seg - seg.mean()

    def midi(f):
        return 69 + 12 * np.log2(f / 440.0)

    # autocorrelation f0, 15–400 Hz
    n = 1 << int(np.ceil(np.log2(2 * len(seg))))
    X = np.fft.rfft(seg, n)
    ac = np.fft.irfft(X * np.conj(X))[: len(seg)]
    ac /= ac[0] + 1e-20
    lo, hi = int(sr / fmax), min(int(sr / 15), len(ac) - 1)
    if hi <= lo:
        return None, "unmeasurable", "too short for 15Hz lag"
    lag = lo + int(np.argmax(ac[lo:hi]))
    f_ac = sr / lag
    peak_strength = float(ac[lag])

    # spectral peak, same band
    w = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
    fr = np.fft.rfftfreq(len(seg), 1 / sr)
    m = (fr > 15) & (fr < fmax)
    f_sp = float(fr[m][int(np.argmax(w[m]))])

    m_ac, m_sp = midi(f_ac), midi(f_sp)
    detail = f"ac {f_ac:.1f}Hz({note_label(round(m_ac))}) sp {f_sp:.1f}Hz({note_label(round(m_sp))}) acpk {peak_strength:.2f}"
    if peak_strength < 0.25:
        return None, "unmeasurable", detail + " weak-periodicity"
    if abs(m_ac - m_sp) <= 1.5:
        return float(m_ac), "high", detail
    ratio = f_sp / f_ac
    if any(abs(ratio - k) < 0.07 * k for k in (2, 3, 4, 5, 6)):
        # Adversarial-verification guard (2026-07): autocorr can lock a SUBHARMONIC of a
        # weak-fundamental sample and this branch then "confirms" it (the spectral peak
        # really is an integer multiple — of the wrong f0). Require direct spectral
        # energy AT the candidate f0 before trusting it.
        near = (fr >= f_ac * 0.97) & (fr <= f_ac * 1.03)
        direct = float(w[near].max()) if near.any() else 0.0
        if direct < 0.02 * float(w[m].max()):
            return None, "unmeasurable", detail + " no-direct-energy-at-candidate"
        return float(m_ac), "medium", detail + " (spectral peak = harmonic)"
    return None, "unmeasurable", detail + " method-disagreement"


def main(argv=None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    write = "--write" in argv
    args = [a for a in argv if not a.startswith("--")]
    manifest = args[0] if args else os.path.expanduser("~/Library/Mosh/palette-v1/manifest.json")
    if not os.path.isfile(manifest):
        print(f"no manifest at {manifest}")
        return 1
    doc = json.load(open(manifest))
    items = doc["items"] if isinstance(doc, dict) and "items" in doc else doc

    stats = {"measured": 0, "unmeasurable": 0, "skipped": 0, "changed": 0, "octave_err": 0}
    errs = []
    for it in items:
        role = (it.get("role_guess") or it.get("role") or "").lower()
        path = it.get("path")
        if role not in PITCHED_ROLES or not path or not os.path.isfile(path):
            stats["skipped"] += 1
            continue
        bass_like = role in ("808", "bass")
        m, conf, detail = measure_f0(path, fmax=400.0 if bass_like else 1000.0)
        # Adversarial-verification guard: for the melodic family, only HIGH-confidence
        # (both methods agree) measurements may overwrite a label — 'medium' there is
        # exactly where subharmonic traps live. 808/bass keeps medium (spectral peak at
        # an integer harmonic of the autocorr f0 is the physically right call for bass).
        if m is not None and conf == "medium" and not bass_like:
            m, detail = None, detail + " demoted(medium+melodic)"
        if m is None:
            it["root_source"] = "inferred"
            it["root_measure_note"] = detail[:120]
            stats["unmeasurable"] += 1
            continue
        new_root = int(round(m))
        old = it.get("root_note")
        it["root_source"] = "measured"
        it["root_confidence"] = conf
        it["root_label"] = note_label(new_root)
        if old is not None and int(old) != new_root:
            it["root_note_inferred"] = int(old)   # audit trail: what the label used to claim
            err = new_root - int(old)
            errs.append(err)
            stats["changed"] += 1
            if abs(err) >= 11:
                stats["octave_err"] += 1
        it["root_note"] = new_root
        stats["measured"] += 1

    print(f"measured {stats['measured']}  unmeasurable {stats['unmeasurable']}  "
          f"skipped(non-pitched/missing) {stats['skipped']}")
    print(f"labels CHANGED {stats['changed']}  (octave-class errors ≥11 st: {stats['octave_err']})")
    if errs:
        from collections import Counter
        hist = Counter(errs)
        print("error histogram (measured − old, st): "
              + "  ".join(f"{k:+d}×{v}" for k, v in sorted(hist.items())))
    if write:
        backup = manifest.replace(".json", f".pre-pitch-{time.strftime('%Y%m%d')}.json")
        if not os.path.exists(backup):
            shutil.copy2(manifest, backup)
        with open(manifest, "w") as f:
            json.dump(doc, f)
        print(f"WROTE {manifest}  (backup: {backup})")
    else:
        print("dry-run — pass --write to apply")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
