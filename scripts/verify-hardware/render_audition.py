#!/usr/bin/env python3
"""Render an audition set from the §0.5 generator → WAVs the owner can LISTEN to.

Produces a handful of recombined beats (varied moods/seeds), renders each through the real
engine, and writes them + a README (provenance per beat) to an output dir. This is the
informal ear-check that precedes the formal Gate A/C.

    MOSH_BIN=build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh \
        service/teardown/.venv/bin/python scripts/verify-hardware/render_audition.py [OUT_DIR]
"""
from __future__ import annotations

import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SERVICE = os.path.join(REPO, "service")
if SERVICE not in sys.path:
    sys.path.insert(0, SERVICE)

DEFAULT_BIN = os.path.join(REPO, "build-macos-arm64", "Mosh_artefacts", "Debug",
                           "Mosh.app", "Contents", "MacOS", "Mosh")

BEATS = [
    ({"mood": "dark", "tempo": 140, "key": "F minor"}, 3),
    ({"mood": "dark", "tempo": 140, "key": "F minor"}, 11),
    ({"mood": "emotional", "tempo": 146, "key": "C# minor"}, 5),
    ({"mood": "emotional", "tempo": 150, "key": "G minor"}, 21),
    ({"mood": "aggressive", "tempo": 150, "key": "D minor"}, 9),
    ({"mood": "chill", "tempo": 132, "key": "A minor"}, 4),
]


def sub_gate(wav: str) -> tuple[bool, dict]:
    """808-register gate (2026-07 audition: the owner rated ALL SIX beats "808 too high" —
    medians MIDI 54.5–65 instead of the 24–38 sub window; dominant low peaks 97–220 Hz).
    PASS requires ALL THREE, calibrated so the whole known-bad v1 set FAILS:
      1. dominant 20–300 Hz spectral peak in [32, 73] Hz (an 808 fundamental, C1–D2);
      2. E(20–60) / E(20–250) ≥ 0.50 — sub-dominated low end, brightness-independent;
      3. 20–300 Hz spectral centroid ≤ 90 Hz (backstop: a lone kick thump can't mask
         a still-high bass line).
    Fixed measurement recipe so thresholds transfer: mono mixdown, Welch PSD,
    65536-pt Hann, 50% overlap. Returns (ok, metrics)."""
    import numpy as np
    import soundfile as sf
    x, sr = sf.read(wav)
    if getattr(x, "ndim", 1) > 1:
        x = x.mean(axis=1)
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

    ratio = band(20, 60) / (band(20, 250) + 1e-20)
    low = (freqs >= 20) & (freqs <= 300)
    peak_hz = float(freqs[low][int(np.argmax(psd[low]))])
    centroid = float((freqs[low] * psd[low]).sum() / (psd[low].sum() + 1e-20))
    ok = (32.0 <= peak_hz <= 73.0) and ratio >= 0.50 and centroid <= 90.0
    return ok, {"peakHz": round(peak_hz, 1), "subRatio": round(ratio, 3),
                "lowCentroid": round(centroid, 1)}


def main() -> int:
    from recipes import generate as G
    from teardown.render.execute import execute_recipe

    binp = os.environ.get("MOSH_BIN", "").strip() or DEFAULT_BIN
    if not os.path.isfile(binp):
        print(f"SKIP: no Mosh binary at {binp!r}")
        return 0
    palette = G.load_palette()
    if not palette:
        print("SKIP: no palette manifest (owner-private)")
        return 0

    out_dir = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else "~/mosh-beats/restart")
    os.makedirs(out_dir, exist_ok=True)

    # ── render gate (2026-07 out-of-key audit): a beat only ships to the owner's ears if
    # the RENDERED AUDIO passes sharp checks — requested key within the top-3 Krumhansl
    # matches AND <0.5% clipped samples. MIDI-space gates all passed while renders were
    # audibly wrong; this gate listens. On failure we re-seed (recipe key metadata can be
    # wrong upstream) and keep the best attempt.
    import numpy as np
    import soundfile as sf
    _MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
    _MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
    _N = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

    def render_gate(wav: str, want_key: str) -> tuple[int, float]:
        """(key rank of want_key among 24, clipped-sample fraction)."""
        x, sr = sf.read(wav)
        if getattr(x, "ndim", 1) > 1:
            x = x.mean(axis=1)
        clip = float((abs(x) >= 0.999).mean())
        X = np.abs(np.fft.rfft(x))
        freqs = np.fft.rfftfreq(len(x), 1 / sr)
        chroma = np.zeros(12)
        band = (freqs > 55) & (freqs < 2000)
        for f, e in zip(freqs[band], (X[band] ** 2)):
            chroma[int(round(12 * np.log2(f / 440.0) + 69)) % 12] += e
        chroma /= chroma.sum() + 1e-20
        def corr(profile, rot):
            pr = np.array(profile[-rot:] + profile[:-rot])
            return float(np.corrcoef(pr, chroma)[0, 1])
        scored = sorted([(corr(_MIN, r), f"{_N[r]} minor") for r in range(12)]
                        + [(corr(_MAJ, r), f"{_N[r]} major") for r in range(12)], reverse=True)
        rank = next(i for i, (_, k) in enumerate(scored) if k == want_key)
        return rank, clip
    lines = ["# Restart audition set — recombined from the seed recipe library",
             "# (real motifs recombined + transposed + 808 bound to chords; bootstrap corpus)\n"]
    n_ok = 0
    for i, (req, seed) in enumerate(BEATS):
        name = f"{i+1:02d}_{req['mood']}_{int(req['tempo'])}_{req['key'].replace(' ', '').replace('#','s')}.wav"
        wav = os.path.join(out_dir, name)
        best = None  # (rank, sub_bad, clip, seed, prov, res, sub_m)
        for attempt in range(4):
            try_seed = seed + attempt * 13
            rec, prov = G.generate(req, seed=try_seed, palette=palette)
            res = execute_recipe(rec, bin_path=binp, out_wav=wav,
                                 session_dir=os.path.join(out_dir, f".s{i}"), timeout_s=180,
                                 write_back=False, resolve_synth_patches=False)
            if not (res.nonsilent and res.error is None):
                continue
            rank, clip = render_gate(wav, req["key"])
            sub_ok, sub_m = sub_gate(wav)
            key3 = (rank, 0 if sub_ok else 1, clip)
            if best is None or key3 < (best[0], best[1], best[2]):
                best = (rank, key3[1], clip, try_seed, prov, res, sub_m)
            if rank <= 2 and clip < 0.005 and sub_ok:
                break
            print(f"  gate: {name} seed={try_seed} keyRank={rank} clip={clip:.1%} "
                  f"sub={'ok' if sub_ok else sub_m} — retrying")
        if best is None:
            print(f"  BAD {name} (no render survived)")
            continue
        rank, sub_bad, clip, used_seed, prov, res, sub_m = best
        if rank > 2 or clip >= 0.005 or sub_bad:
            # keep the best attempt but say so loudly — never silently ship a failed gate
            print(f"  ⚠ {name} ships BELOW the render gate (keyRank={rank}, clip={clip:.1%}, "
                  f"sub={sub_m})")
        if used_seed != seed:
            rec, prov = G.generate(req, seed=used_seed, palette=palette)
            res = execute_recipe(rec, bin_path=binp, out_wav=wav,
                                 session_dir=os.path.join(out_dir, f".s{i}"), timeout_s=180,
                                 write_back=False, resolve_synth_patches=False)
        status = "OK "
        n_ok += 1
        src = " + ".join(f"{k}:{v}" for k, v in prov.sources.items())
        print(f"  {status} {name}  rms={res.audio_rms:.4f}  sub={sub_m}  [{src}]")
        lines.append(f"- **{name}** — {req['mood']} {int(req['tempo'])}bpm {req['key']}  \n"
                     f"  sources: {prov.sources}  transpose: {prov.transpose}  \n"
                     f"  gate: keyRank={rank} clip={clip:.2%} sub={'PASS' if not sub_bad else 'FAIL'} {sub_m}")
    with open(os.path.join(out_dir, "README.md"), "w") as f:
        f.write("\n".join(lines) + "\n")
    print(f"\n{n_ok}/{len(BEATS)} rendered → {out_dir}")
    return 0 if n_ok == len(BEATS) else 1


if __name__ == "__main__":
    raise SystemExit(main())
