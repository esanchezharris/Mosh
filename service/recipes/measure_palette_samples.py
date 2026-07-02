#!/usr/bin/env python3
"""Sample-truth pass over the palette: measure per-one-shot loudness, decay, and sub
character, and flag open hi-hats — the metadata the binding filters need.

Why (2026-07 pack-001 audition): beat 04 was killed for open hi-hats played as densely
as closed ones (owner's rule: open hats ≤ ~1 per 4 beats); beat 05 for a kick whose sub
tail stacked with the 808 ("multiple 808s"); beat 14's snare was too quiet. Roles don't
distinguish open/closed hats and sample NAMES certify open only (84 open-named vs 4
closed-named of 357 hats), so measured decay is the primary discriminator — the dry-run
prints the named-open vs named-closed decay histogram to calibrate the threshold.

    service/teardown/.venv/bin/python service/recipes/measure_palette_samples.py           # dry-run
    service/teardown/.venv/bin/python service/recipes/measure_palette_samples.py --write   # backup + write

Fields written per item (version-stamped sample_measure_ver:1):
  rmsDb, peakDb      — overall level (drum-pool loudness floor)
  decayMs            — broadband envelope time from peak to −20 dB
  subShare           — E(25–80 Hz) / E(25–250 Hz)
  subTailMs          — 25–80 Hz band envelope time from band peak to −20 dB
  openHat            — hats only: whole-token name match ("open"/"oh"/"openhat") on src

CAVEAT (by design): metadata is measured at natural pitch but samples render repitched
(sampler root vs MIDI note) ⇒ these are POOL-FILTER preferences, never per-sample gates.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
import time

OPEN_TOKENS = {"open", "oh", "openhat"}
CLOSED_TOKENS = {"closed", "closedhat"}
DECAY_DROP_DB = 20.0
ENV_WIN_S = 0.010


def is_open_hat_name(src: str) -> bool:
    """Whole-token match on the ORIGINAL filename (manifest src — palette paths are
    content-hash renamed). 'open hhhh.wav'/'regular oh.wav' → True;
    'hate.wav'/'high hat.wav'/'chop.wav' → False."""
    tokens = re.split(r"[^a-z0-9]+", os.path.basename(src or "").lower())
    return any(t in OPEN_TOKENS for t in tokens)


def is_closed_hat_name(src: str) -> bool:
    tokens = re.split(r"[^a-z0-9]+", os.path.basename(src or "").lower())
    return any(t in CLOSED_TOKENS for t in tokens)


def _envelope_decay_ms(x, sr) -> float:
    """Time from the envelope peak until it stays ≥20 dB below peak (ms). Envelope =
    RMS over 10 ms hops; a sample that never decays inside the file reports its
    remaining length (honest ceiling, not a guess)."""
    import numpy as np
    win = max(1, int(ENV_WIN_S * sr))
    n = len(x) // win
    if n < 1:
        return 0.0
    env = np.sqrt(np.mean(x[: n * win].reshape(n, win) ** 2, axis=1))
    peak_i = int(np.argmax(env))
    peak = float(env[peak_i])
    if peak <= 1e-9:
        return 0.0
    floor = peak * (10.0 ** (-DECAY_DROP_DB / 20.0))
    below = np.nonzero(env[peak_i:] <= floor)[0]
    hops = float(below[0]) if below.size else float(n - peak_i)
    return hops * ENV_WIN_S * 1000.0


def measure_sample(path: str):
    """dict of measured fields, or (None, reason) on unreadable/silent audio."""
    import numpy as np
    import soundfile as sf
    try:
        x, sr = sf.read(path)
    except Exception as e:  # noqa: BLE001 — report, never crash the pass
        return None, f"read-error {e}"
    if getattr(x, "ndim", 1) > 1:
        x = x.mean(axis=1)
    x = np.asarray(x, dtype=np.float64)
    if len(x) < sr // 100:
        return None, "too short"
    peak = float(np.abs(x).max())
    if peak < 1e-6:
        return None, "silent"
    rms = float(np.sqrt(np.mean(x ** 2)))

    # spectral shares from a plain periodogram (one-shots are short; Welch is overkill)
    spec = np.abs(np.fft.rfft(x)) ** 2
    freqs = np.fft.rfftfreq(len(x), 1.0 / sr)
    sub = float(spec[(freqs >= 25) & (freqs < 80)].sum())
    low = float(spec[(freqs >= 25) & (freqs < 250)].sum())
    total = float(spec[freqs >= 20].sum())
    # sub/low is noise when the sample has no low end at all (e.g. a hat): floor to 0
    # unless the low band carries at least 1% of total energy.
    sub_share = sub / low if low > 0 and total > 0 and low / total >= 0.01 else 0.0

    # sub-band tail: mask the spectrum to 25–80 Hz and measure the band envelope decay
    fx = np.fft.rfft(x)
    fx[(freqs < 25) | (freqs >= 80)] = 0.0
    band = np.fft.irfft(fx, n=len(x))

    return {"rmsDb": round(20.0 * (np.log10(rms) if rms > 0 else -6.0), 2),
            "peakDb": round(20.0 * np.log10(peak), 2),
            "decayMs": round(_envelope_decay_ms(x, sr), 1),
            "subShare": round(sub_share, 4),
            "subTailMs": round(_envelope_decay_ms(band, sr), 1),
            "sample_measure_ver": 1}, None


def main(argv=None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    write = "--write" in argv
    args = [a for a in argv if not a.startswith("--")]
    manifest = args[0] if args else os.environ.get(
        "MOSH_PALETTE_MANIFEST",
        os.path.expanduser("~/Library/Mosh/palette-v1/manifest.json"))
    if not os.path.isfile(manifest):
        print(f"no manifest at {manifest}")
        return 1
    doc = json.load(open(manifest))
    items = doc["items"] if isinstance(doc, dict) and "items" in doc else doc

    stats = {"measured": 0, "unmeasurable": 0, "missing": 0}
    open_decays, closed_decays, other_hat_decays = [], [], []
    for it in items:
        path = it.get("path")
        if not path or not os.path.isfile(path):
            stats["missing"] += 1
            continue
        m, reason = measure_sample(path)
        if m is None:
            it["sample_measure_note"] = reason[:120]
            stats["unmeasurable"] += 1
            continue
        it.update(m)
        role = (it.get("role_guess") or it.get("role") or "").lower()
        if role == "hat":
            it["openHat"] = is_open_hat_name(it.get("src") or "")
            if it["openHat"]:
                open_decays.append(m["decayMs"])
            elif is_closed_hat_name(it.get("src") or ""):
                closed_decays.append(m["decayMs"])
            else:
                other_hat_decays.append(m["decayMs"])
        stats["measured"] += 1

    print(f"measured {stats['measured']}  unmeasurable {stats['unmeasurable']}  "
          f"missing {stats['missing']}")

    def _hist(name, vals):
        if not vals:
            print(f"  {name}: none")
            return
        vals = sorted(vals)
        med = vals[len(vals) // 2]
        buckets = [0] * 6  # <150, <300, <450, <600, <900, ≥900 ms
        edges = [150, 300, 450, 600, 900]
        for v in vals:
            for i, e in enumerate(edges):
                if v < e:
                    buckets[i] += 1
                    break
            else:
                buckets[5] += 1
        lab = ["<150", "150-300", "300-450", "450-600", "600-900", "≥900"]
        print(f"  {name} (n={len(vals)}, median {med:.0f} ms): "
              + "  ".join(f"{l}:{b}" for l, b in zip(lab, buckets)))

    print("hat decay calibration (the open-hat binding threshold comes from HERE):")
    _hist("named-OPEN hats", open_decays)
    _hist("named-CLOSED hats", closed_decays)
    _hist("unnamed hats", other_hat_decays)

    if write:
        backup = manifest.replace(".json", f".pre-samples-{time.strftime('%Y%m%d')}.json")
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
