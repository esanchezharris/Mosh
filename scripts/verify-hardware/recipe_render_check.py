#!/usr/bin/env python3
"""§0.2 render proof — compile a Recipe (real model) through MoshOps and PROVE the audio.

The restart's core claim is that recipes get a real *musical body* and the 808 is a
pitched, MIDI-triggered, **sustained** voice — not a hi-hat-like even grid. This renders
two things through the real engine and asserts on the WAV:

  1. A full trap beat (real kick/snare/hat one-shots + a melodic 808 + a 4OSC lead) → NON-SILENT.
  2. The 808 phrase ALONE → its low band (<120 Hz) holds: the longest contiguous sustained
     run is well above a stab (≥0.35 s), which a straight-eighths "808-as-hi-hat" cannot reach.

Sample paths + the 808 root come from the (gitignored, owner-private) palette manifest, so
this SKIPs cleanly where the palette or the built binary is absent.

    MOSH_BIN=build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh \
        service/teardown/.venv/bin/python scripts/verify-hardware/recipe_render_check.py
(exit 0 = pass / clean skip; 1 = a real failure)
"""
from __future__ import annotations

import json
import os
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SERVICE = os.path.join(REPO, "service")
if SERVICE not in sys.path:
    sys.path.insert(0, SERVICE)

MANIFEST = os.path.join(SERVICE, "palette", "palette", "manifest.json")
DEFAULT_BIN = os.path.join(REPO, "build-macos-arm64", "Mosh_artefacts", "Debug",
                           "Mosh.app", "Contents", "MacOS", "Mosh")


def _skip(msg: str) -> None:
    print(f"SKIP: {msg}")
    sys.exit(0)


def _binary() -> str:
    b = os.environ.get("MOSH_BIN", "").strip() or DEFAULT_BIN
    if not os.path.isfile(b):
        _skip(f"no Mosh binary at {b!r} (set MOSH_BIN to the debug build)")
    return b


def _palette():
    if not os.path.isfile(MANIFEST):
        _skip(f"no palette manifest at {MANIFEST} (owner-private, gitignored)")
    items = json.load(open(MANIFEST))
    items = items["items"] if isinstance(items, dict) and "items" in items else items
    by_role: dict[str, dict] = {}
    for it in items:
        role = (it.get("role_guess") or it.get("role") or "").lower()
        path = it.get("path")
        if role and role not in by_role and path and os.path.isfile(path):
            by_role[role] = it
    return by_role


def main() -> int:
    import numpy as np
    import soundfile as sf

    from teardown import recipe as R
    from teardown.render.execute import execute_recipe

    binp = _binary()
    pal = _palette()
    need = ["kick", "snare", "hat", "808"]
    missing = [r for r in need if r not in pal]
    if missing:
        _skip(f"palette missing roles {missing}")

    ne = R.NoteEvent
    KEY = "F minor"
    TEMPO = 140

    # ── a real, sparse, SUSTAINED, syncopated 808 line (F minor) — never straight eighths.
    # durations 0.5–2.0 beats; onsets off the pure 8th grid; pitches move (root-following feel).
    bass_notes = [
        ne(pitch=29, start_beats=0.0, duration_beats=1.5, velocity=112),  # F1, held
        ne(pitch=29, start_beats=2.5, duration_beats=0.5, velocity=96),   # pickup
        ne(pitch=32, start_beats=3.0, duration_beats=1.0, velocity=104),  # Ab1
        ne(pitch=27, start_beats=4.5, duration_beats=1.5, velocity=108),  # Eb1, held
        ne(pitch=25, start_beats=6.0, duration_beats=2.0, velocity=110),  # Db1, long
    ]

    def bass_element():
        return R.Element(element_id="b808", role="808", label="808 bass",
                         sample_match=R.SampleMatch(status="matched",
                                                    matched_path=pal["808"]["path"], distance=0.05),
                         midi=R.Midi(status="extracted", notes=bass_notes),
                         bass=R.Bass(sustain_ratio=0.8, root_follows=True))

    def drum(role, label, pitch, onsets, vel=104, dur=0.25):
        return R.Element(element_id=role, role=role, label=label,
                         sample_match=R.SampleMatch(status="matched",
                                                    matched_path=pal[role]["path"], distance=0.05),
                         midi=R.Midi(status="extracted",
                                     notes=[ne(pitch=pitch, start_beats=s, duration_beats=dur, velocity=vel)
                                            for s in onsets]))

    full = R.Recipe(
        meta=R.Meta(tempo_bpm=R.MetaField(value=TEMPO), key=R.MetaField(value=KEY),
                    time_signature=R.MetaField(value="4/4")),
        elements=[
            drum("kick", "Kick", 36, [0.0, 1.5, 4.0, 6.5], vel=118),
            drum("snare", "Snare", 38, [1.0, 3.0, 5.0, 7.0], vel=110),
            drum("hat", "Hat", 42, [i * 0.5 for i in range(16)], vel=78, dur=0.2),
            bass_element(),
            # a simple lead with NO sample/synth → 4OSC default (exercises the melodic-no-sample path)
            R.Element(element_id="lead", role="lead", label="Lead",
                      midi=R.Midi(status="extracted", notes=[
                          ne(pitch=65, start_beats=0.0, duration_beats=1.0, velocity=88),
                          ne(pitch=68, start_beats=2.0, duration_beats=1.0, velocity=84),
                          ne(pitch=63, start_beats=4.0, duration_beats=2.0, velocity=86)])),
        ],
    )
    bass_only = R.Recipe(meta=full.meta, elements=[bass_element()])

    fails: list[str] = []

    def check(name, cond, extra=""):
        print(("  ok   " if cond else "  FAIL ") + name + ("" if cond or not extra else f"  [{extra}]"))
        if not cond:
            fails.append(name)

    with tempfile.TemporaryDirectory(prefix="recipe-render-") as td:
        full_wav = os.path.join(td, "full.wav")
        bass_wav = os.path.join(td, "bass.wav")

        rfull = execute_recipe(full, bin_path=binp, out_wav=full_wav,
                               session_dir=os.path.join(td, "s1"), timeout_s=180,
                               write_back=False, resolve_synth_patches=False)
        check("full beat rendered (binary ran)", rfull.ran, rfull.error or "")
        check("full beat is NON-SILENT", rfull.nonsilent, f"rms={rfull.audio_rms:.5f}")
        check("full beat had no failed commands", rfull.error is None, rfull.error or "")

        rbass = execute_recipe(bass_only, bin_path=binp, out_wav=bass_wav,
                               session_dir=os.path.join(td, "s2"), timeout_s=180,
                               write_back=False, resolve_synth_patches=False)
        check("808-only rendered NON-SILENT", rbass.nonsilent, f"rms={rbass.audio_rms:.5f}")

        # ── the "is it a real 808, not a hi-hat" test: sustained low-frequency energy ──
        if os.path.isfile(bass_wav) and os.path.getsize(bass_wav) > 0:
            data, sr = sf.read(bass_wav, dtype="float32", always_2d=True)
            y = data.mean(axis=1).astype(np.float64)
            # crude low-pass (<~120 Hz) via a moving average ~ sr/240 wide, then envelope
            win = max(1, sr // 240)
            kernel = np.ones(win) / win
            low = np.convolve(y, kernel, mode="same")
            env = np.abs(low)
            # smooth the envelope (20 ms) so we measure sustain, not sample-level wiggle
            ew = max(1, sr // 50)
            env = np.convolve(env, np.ones(ew) / ew, mode="same")
            peak = float(env.max()) if env.size else 0.0
            thr = 0.2 * peak
            # longest contiguous run above threshold, in seconds
            best = cur = 0
            for v in env:
                cur = cur + 1 if v > thr else 0
                best = max(best, cur)
            sustain_s = best / sr
            duty = float((env > thr).mean())
            print(f"  .. 808 low-band: peak={peak:.4f} longest_sustain={sustain_s:.3f}s duty={duty:.2f}")
            check("808 SUSTAINS (longest low-band run ≥ 0.35s — not a hi-hat stab)", sustain_s >= 0.35,
                  f"{sustain_s:.3f}s")
            check("808 holds a meaningful duty cycle (≥0.30 of the clip)", duty >= 0.30, f"{duty:.2f}")
        else:
            check("808 render produced a WAV", False, "no bass wav")

    print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
    return len(fails)


if __name__ == "__main__":
    raise SystemExit(main())
