#!/usr/bin/env python3
"""Curated real-sample catalog for the reward-validity probe + 44.1kHz prep.

The probe builds musically-varied loops from REAL source material (so candidates sound
like real music, not 4OSC toys) and asks the owner to rate them blind. This module is the
sample side: a hand-curated set of melodic loops spanning genre/mood/tempo/key (the GOOD
end of the spread needs genuine variety, not one base repeated), plus `prep()` which
resamples any chosen source to 44.1kHz / PCM_16.

WHY prep is mandatory: the headless `Mosh --run-script` render STALLS on a wave clip whose
source sample-rate differs from the engine's 44.1kHz (the background resample/proxy never
completes headless → "export render stalled (a clip's audio source could not be read)").
The bundled drum kit is already 44.1k; Splice loops are commonly 48k. So every imported
source is pre-resampled to a 44.1k/PCM_16 asset under .assets/ (idempotent, content-stable).
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path

import numpy as np
import soundfile as sf

LIB = Path(os.path.expanduser(os.environ.get("MOSH_SAMPLE_LIBRARY", "~/Splice/sounds/packs")))
ASSET_DIR = Path(__file__).resolve().parent / ".assets"
ENGINE_SR = 44100


# Curated melodic loops: (id, rel-path under LIB, bpm, key, genre). Hand-picked for genre/mood
# spread so the "good" end of the rating pack isn't monotone. Verified present 2026-06-29; any
# that go missing are skipped with a warning at prep time (the probe degrades, never crashes).
MELODIC = [
    ("tainy_cm",   "Tainy Sound Supply Vol. 1/TAINY_sample_pack/TAINY_tonal/TAINY_melodic_loops/TAINY_120_melodic_loop_dh_Cmin.wav", 120, "Cm",  "trap"),
    ("glacier_d",  "Glacier Valley/Glacier_Valley_Traktrain_Sample_Pack_repack/loops/TRKTRN_Melody_Loops/TRKTRN_Melody_Loop_80_D_Feelings.wav", 80, "D", "lofi"),
    ("glacier_fs", "Glacier Valley/Glacier_Valley_Traktrain_Sample_Pack_repack/loops/TRKTRN_Melody_Loops/TRKTRN_Melody_Loop_85_F#_Chill.wav", 85, "F#", "lofi"),
    ("icecold_cm", "Ice Cold - Trap & Hip Hop/Origin_Sound_-_Ice_Cold/Music_Loops/Melodics/OS_IC_150_Cm_Pacific_Vintage_Warm_E-Piano_Melody.wav", 150, "Cm", "trap"),
    ("lowkey_bm",  "LOWKEY BEATS/Music_Loops/Melodics/OS_LB_150_Bm_No_Time_Keys_Vox_Melody.wav", 150, "Bm", "trap"),
    ("flint_gm",   "FLINT TYPE BEATS - DETROIT TRAP/Origin_Sound_-_FLINT_TYPE_BEATS/loops/piano_loops/OS_FLINT_99_piano_arp_melody_bussin_Gm.wav", 99, "Gm", "detroit"),
    ("zone6_fm",   "ZONE 6 - ATLANTA TRAP/Origin_Sound_-_ZONE_6_-_ATLANTA_TRAP/loops/synth_loops/OS_ATL_140_synth_melody_racks_Fm.wav", 140, "Fm", "trap"),
    ("oak_bmaj",   "Comfort Collage, an oakscreen moment/Moment_-_Comfort_Collage__an_oakscreen_moment/loops/melody_loops/MO_OAK_85_melody_synth_icicles_Bmajor.wav", 85, "Bmaj", "lofi"),
    ("trapsmp_am", "‘Trap Samples’/Origin_Sound_-_Trap_Samples/Music_Loops/Melodics/OS_TS_130_Am_Brooklyn_Violin.wav", 130, "Am", "trap"),
    ("darklofi_asm","Dark & Lofi Beats/Function_Loops_-_Dark_&_Lofi_Beats/Loops/FL_DLB_Melody_Loops/FL_DLB_94_Synth_Loop_Melody_Gameboy_A#m.wav", 94, "A#m", "lofi"),
    ("lovesick_asm","Lovesick - RnB Soul/Origin_Sound_-_Lovesick/Music_Loops/Melodics/OS_LS_130_A#m_Dive_Synth_Guitar.wav", 130, "A#m", "rnb"),
    ("aukou_bm",   "Aukoustics Evolving Sounds/SO_Aukoustics_Evolving_Sounds/Loops/Songstarters/SO_AU_160_songstarter_guitar_arp_nostalgic_pain_Bmin.wav", 160, "Bmin", "cinematic"),
]

# A deliberately OFF-GENRE loop (for the incoherent anchor): bright brass over trap drums.
OFFGENRE = ("brass_a", "Future Pop Essentials/Freshly_Squeezed_Samples_-_Future_Pop_Essentials/Loops/Melodic_Loops/Cinematic_Melodic_Loops/FSS_FPE_76_brass_synth_loop_evilbrass_A.wav", 76, "A", "brass")


def _abs(rel: str) -> Path:
    return LIB / rel


def prep(rel_path: str) -> tuple[str, float] | None:
    """Resample a source wav to a 44.1k/PCM_16 asset under .assets/. Returns (abs_asset_path,
    duration_seconds) or None if the source is missing. Idempotent (keyed by source path)."""
    src = _abs(rel_path)
    if not src.is_file():
        print(f"  [samples] MISSING: {src}")
        return None
    ASSET_DIR.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha1(str(src).encode()).hexdigest()[:16]
    dst = ASSET_DIR / f"{key}.wav"
    if dst.is_file():
        return str(dst), sf.info(str(dst)).frames / ENGINE_SR
    y, sr = sf.read(str(src), always_2d=True, dtype="float32")
    if sr != ENGINE_SR:
        n = int(round(y.shape[0] * ENGINE_SR / sr))
        xi = np.linspace(0, y.shape[0] - 1, n)
        idx = np.arange(y.shape[0])
        y = np.stack([np.interp(xi, idx, y[:, c]) for c in range(y.shape[1])], axis=1).astype(np.float32)
    sf.write(str(dst), y, ENGINE_SR, subtype="PCM_16")
    return str(dst), y.shape[0] / ENGINE_SR


def catalog() -> list[dict]:
    """Prep every curated melodic loop → list of usable entries with asset paths + durations.
    Missing sources are dropped (warned)."""
    out = []
    for sid, rel, bpm, key, genre in MELODIC:
        p = prep(rel)
        if p:
            out.append({"id": sid, "asset": p[0], "dur": p[1], "bpm": bpm, "key": key, "genre": genre})
    return out


def offgenre_asset() -> dict | None:
    sid, rel, bpm, key, genre = OFFGENRE
    p = prep(rel)
    return {"id": sid, "asset": p[0], "dur": p[1], "bpm": bpm, "key": key, "genre": genre} if p else None


if __name__ == "__main__":
    cat = catalog()
    print(f"prepped {len(cat)}/{len(MELODIC)} melodic loops:")
    for e in cat:
        print(f"  {e['id']:14s} {e['genre']:9s} {e['bpm']:>3}bpm {e['key']:5s} dur={e['dur']:.1f}s")
    og = offgenre_asset()
    print(f"offgenre: {og['id'] if og else 'MISSING'}")
