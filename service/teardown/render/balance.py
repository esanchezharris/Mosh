"""Auto mix-balance: measure the rendered mix, and when the low end is out of band,
solo the 808, compute per-role dB offsets, and re-render — deterministic, ≤3 passes.

Why: the 2026-07 owner auditions kept shipping beats whose 808 was in the right OCTAVE
but buried (v3/v4 beats 03+05: mix sub share 2–27% vs the 50–80% a trap mix carries) —
a class that is fully measurable, so it must never reach the owner's ears. The compiler's
flat HEADROOM_TRIM_DB is the static first pass; this is the adaptive second pass, played
through the same one-mutation-path seam (`set_track_volume` / `set_track_mute` commands
appended before export via execute_recipe(pre_export_commands=…)).

Target profile (calibrated on the beats the owner preferred in rounds 3–4, all of which
sit in this band): mix E(20–60)/E(20–250) in [0.50, 0.80].
"""
from __future__ import annotations

import math
from typing import Optional

HEADROOM_TRIM_DB = -4.5          # must mirror compile.py's static trim (offsets are absolute)
NORMALIZE_PEAK_DB = -1.0         # shipped files are peak-normalized to this (factory-only)
MIX_RMS_FLOOR_DB = -20.0         # RAW-render floor: pack-001 beat 01 ("808 inaudible") sat
# at −23.5 dB while every other pack beat was ≥ −15.4 — a mix this quiet has already lost
# its low end to masking and no relative sub ratio can see that.
BASS_AUDIBILITY_MAX_GAP_DB = 12.0  # advisory (pack-002 calibrates): mix RMS − 808-stem RMS
# "Sub" = 25–80 Hz: the fundamentals of the C1–D#2 808 window (32.7–77.8 Hz). The first
# calibration used 20–60 Hz, which punished CORRECT 808s in higher-rooted keys (D minor
# roots live at 63–73 Hz) — key-dependent metric, caught by the balance proof.
SUB_BAND = (25.0, 80.0)
LOW_BAND = (25.0, 250.0)
# controller targets sit INSIDE the gate band (gate lo = 0.62) so convergence lands
# with margin, not on the line (smoke: a candidate stalled at 0.618 vs the 0.62 bar)
SUB_LO_TARGET, SUB_HI_TARGET = 0.66, 0.85
MAX_ITERS = 4
MAX_808_BOOST_DB = 9.0           # never turn a bass into a limiter test
MELODIC_DUCK_STEP_DB = -1.5      # pads/leads step down while the sub is starved
BASS_ROLES = ("808", "bass")
MELODIC_ROLES = ("pad", "lead", "pluck")


def band_metrics(wav: str) -> dict:
    """Mix metrics: {rmsDb, peakHz, subRatio, lowCentroid} — same Welch recipe as the
    render gate (65536-pt Hann, 50% overlap) so numbers are comparable across tools."""
    import numpy as np
    import soundfile as sf
    x, sr = sf.read(wav)
    if getattr(x, "ndim", 1) > 1:
        x = x.mean(axis=1)
    rms = float(np.sqrt(np.mean(np.asarray(x, dtype=np.float64) ** 2))) if len(x) else 0.0
    rms_db = 20.0 * math.log10(max(rms, 1e-9))
    clip_frac = float((np.abs(x) >= 0.999).mean()) if len(x) else 0.0
    n = 65536
    while n > 2048 and n > len(x):
        n //= 2
    win = np.hanning(n)
    psd = np.zeros(n // 2 + 1)
    count = 0
    for start in range(0, len(x) - n + 1, n // 2):
        psd += np.abs(np.fft.rfft(x[start:start + n] * win)) ** 2
        count += 1
    if count == 0:
        seg = np.zeros(n)
        seg[: len(x)] = x
        psd, count = np.abs(np.fft.rfft(seg * win)) ** 2, 1
    psd /= count
    freqs = np.fft.rfftfreq(n, 1 / sr)

    def band(lo, hi):
        m = (freqs >= lo) & (freqs < hi)
        return float(psd[m].sum())

    ratio = band(*SUB_BAND) / (band(*LOW_BAND) + 1e-20)
    low = (freqs >= 20) & (freqs <= 300)
    peak_hz = float(freqs[low][int(np.argmax(psd[low]))]) if low.any() else 0.0
    centroid = float((freqs[low] * psd[low]).sum() / (psd[low].sum() + 1e-20))
    return {"rmsDb": round(rms_db, 2), "peakHz": round(peak_hz, 1),
            "subRatio": round(ratio, 4), "lowCentroid": round(centroid, 1),
            "clipFrac": round(clip_frac, 5)}


def normalize_wav(wav: str, peak_db: float = NORMALIZE_PEAK_DB) -> float:
    """Peak-normalize a WAV in place; returns the applied gain in dB (0.0 = no-op).

    FACTORY-ONLY by design: never call this from execute_recipe — the golden-audio
    verify.py PCM baselines hash execute_recipe's output. Ordering is load-bearing at
    the call site: measure clipFrac on the RAW render FIRST (after normalizing to
    −1 dBFS, |x| ≥ 0.999 is unreachable and the clip gate goes permanently blind)."""
    import numpy as np
    import soundfile as sf
    info = sf.info(wav)
    x, sr = sf.read(wav, dtype="float64")
    peak = float(np.abs(x).max()) if getattr(x, "size", 0) else 0.0
    if peak <= 1e-9:
        return 0.0
    gain = (10.0 ** (peak_db / 20.0)) / peak
    sf.write(wav, x * gain, sr, subtype=info.subtype)
    return round(20.0 * math.log10(gain), 2)


def clip_guard_offsets(prev: Optional[dict], roles: list) -> Optional[dict]:
    """Pure clip guard: trade melodic level for headroom, NEVER the bass or drums.

    The old inline guard cut EVERY track −3 dB (including the 808 it had just boosted)
    with no floor — pack-001 beat 01 is four straight guard cuts: mix RMS collapsed to
    −23.5 dB with the relative balance unchanged ("808 inaudible... no drums").
    Returns the next ABSOLUTE offsets map, or None when every melodic role is already
    at the floor (out of moves — stop iterating)."""
    offs = dict(prev or {})
    moved = False
    for i, r in enumerate(roles):
        if r in MELODIC_ROLES:
            cur = offs.get(i, HEADROOM_TRIM_DB)
            nxt = max(-18.0, cur - 3.0)
            if nxt != cur:
                offs[i] = nxt
                moved = True
    return offs if moved else None


def stem_rms_adjusted(solo_rms_db: float, final_808_offset_db: float) -> float:
    """The 808-solo stem renders at DEFAULT trims while the final mix carries the
    balanced offsets — per-track gain is linear and the stem holds only the 808 track,
    so the correction is exact: stem RMS + (final offset − HEADROOM_TRIM_DB)."""
    return solo_rms_db + (final_808_offset_db - HEADROOM_TRIM_DB)


def compute_offsets(mix: dict, bass_solo: Optional[dict], roles: list,
                    prev: Optional[dict] = None) -> Optional[dict]:
    """Pure controller: current mix metrics (+ optional 808-solo metrics) → per-element
    ABSOLUTE dB map {index: db} for set_track_volume, or None when in band (converged).
    `roles` is the element-role list in track order; `prev` is the last offsets map."""
    offs = dict(prev or {})

    def cur(i):
        return offs.get(i, HEADROOM_TRIM_DB)

    s = mix.get("subRatio", 0.0)
    if SUB_LO_TARGET <= s <= SUB_HI_TARGET:
        return None
    bass_idx = [i for i, r in enumerate(roles) if r in BASS_ROLES]
    mel_idx = [i for i, r in enumerate(roles) if r in MELODIC_ROLES]
    if not bass_idx:
        return None  # nothing to balance against
    if s < SUB_LO_TARGET:
        # starved sub: raise the 808 (bounded), duck the melodic layers a step.
        # A silent/near-silent solo stem means gain won't help (source issue) — still
        # try one bounded boost, but the cap keeps us honest.
        deficit = SUB_LO_TARGET - s
        step = 3.0 if deficit < 0.25 else 6.0
        # deficit-proportional duck (mirrors the 3/6 bass asymmetry): at pack-001 pad
        # densities (55 notes/bar) a flat −1.5/iter can never win inside MAX_ITERS
        duck = MELODIC_DUCK_STEP_DB if deficit < 0.25 else 3.0 * MELODIC_DUCK_STEP_DB
        for i in bass_idx:
            offs[i] = min(HEADROOM_TRIM_DB + MAX_808_BOOST_DB, cur(i) + step)
        for i in mel_idx:
            offs[i] = max(-18.0, cur(i) + duck)
    else:
        # sub-drowned: bring the 808 down a step
        for i in bass_idx:
            offs[i] = max(-18.0, cur(i) - 3.0)
    if prev is not None and offs == prev:
        return None  # clamped out of moves — stop iterating
    return offs


def _volume_cmds(offsets: dict) -> list:
    return [{"command": "set_track_volume", "args": {"trackId": f"${{T{i}}}", "db": round(db, 2)}}
            for i, db in sorted(offsets.items())]


def _solo_cmds(keep_index: int, n_elements: int) -> list:
    return [{"command": "set_track_mute", "args": {"trackId": f"${{T{j}}}", "mute": True}}
            for j in range(n_elements) if j != keep_index]


def balance_render(recipe, bin_path: str, out_wav: str, session_dir: str,
                   timeout_s: int = 180) -> dict:
    """Render `recipe`; if the mix's sub balance is out of band, iterate volume offsets
    (≤MAX_ITERS re-renders) until in band or moves are exhausted. Returns
    {metrics, offsets, iters, res, soloSub} — `res` is the LAST ExecuteResult."""
    from teardown.render.execute import execute_recipe

    roles = [e.role.value for e in recipe.elements]
    offsets: Optional[dict] = {}
    res = execute_recipe(recipe, bin_path=bin_path, out_wav=out_wav, session_dir=session_dir,
                         timeout_s=timeout_s, write_back=False, resolve_synth_patches=False)
    metrics = band_metrics(out_wav) if res.nonsilent else {"subRatio": 0.0}
    # 808-solo stem rendered UNCONDITIONALLY (not lazily inside the loop): a candidate
    # that converges on the first check would otherwise carry no stem — and pack-001
    # beat 01 shows the audibility blind spot lives exactly there. One extra render per
    # candidate buys complete calibration data for the audibility advisory.
    solo_metrics = None
    bass_idx = next((i for i, r in enumerate(roles) if r in BASS_ROLES), None)
    if bass_idx is not None and res.nonsilent:
        solo_wav = out_wav.replace(".wav", ".808solo.wav")
        execute_recipe(recipe, bin_path=bin_path, out_wav=solo_wav,
                       session_dir=session_dir + ".solo", timeout_s=timeout_s,
                       write_back=False, resolve_synth_patches=False,
                       pre_export_commands=_solo_cmds(bass_idx, len(roles)))
        try:
            solo_metrics = band_metrics(solo_wav)
        except Exception:
            solo_metrics = None
    iters = 0
    prev: Optional[dict] = None
    while iters < MAX_ITERS:
        if metrics.get("clipFrac", 0.0) >= 0.005 and prev:
            # the boost bought sub at the cost of clipping — trade back MELODIC level
            # only (the old all-track cut canceled the 808 boost it was protecting)
            nxt = clip_guard_offsets(prev, roles)
        else:
            nxt = compute_offsets(metrics, solo_metrics, roles, prev)
        if nxt is None:
            break
        prev = nxt
        iters += 1
        res = execute_recipe(recipe, bin_path=bin_path, out_wav=out_wav, session_dir=session_dir,
                             timeout_s=timeout_s, write_back=False, resolve_synth_patches=False,
                             pre_export_commands=_volume_cmds(nxt))
        metrics = band_metrics(out_wav) if res.nonsilent else {"subRatio": 0.0}
    final_bass_off = (prev or {}).get(bass_idx, HEADROOM_TRIM_DB) if bass_idx is not None else None
    solo_rms = (solo_metrics or {}).get("rmsDb")
    return {"metrics": metrics, "offsets": prev or {}, "iters": iters,
            "res": res, "soloSub": (solo_metrics or {}).get("subRatio"),
            "soloRmsDb": solo_rms,
            # exact gain correction: the stem rendered at default trims, the mix ships
            # with the balanced offset — see stem_rms_adjusted()
            "soloRmsAdjDb": (round(stem_rms_adjusted(solo_rms, final_bass_off), 2)
                             if solo_rms is not None and final_bass_off is not None else None)}
