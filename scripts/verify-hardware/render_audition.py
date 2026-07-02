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


_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
_MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
_N = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def render_gate_standalone(wav: str, want_key: str) -> tuple[int, float]:
    """(key rank of want_key among 24 Krumhansl matches, clipped-sample fraction) —
    module-level so the beat factory can import it."""
    import numpy as np
    import soundfile as sf
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


def sub_gate(wav: str) -> tuple[bool, dict]:
    """808-register gate (2026-07 audition: the owner rated ALL SIX v1 beats "808 too high").
    PASS requires ALL THREE — one shared measurement (teardown.render.balance.band_metrics,
    Welch 65536-pt Hann 50%):
      1. dominant 20–300 Hz spectral peak in [32, 73] Hz (an 808 fundamental, C1–D2);
      2. E(25–80) / E(25–250) ≥ 0.62 — sub-dominated low end. (v2 calibration: the first
         20–60 Hz band was KEY-DEPENDENT — D-minor 808 roots live at 63–73 Hz and were
         punished while correct. 25–80 covers the C1–D#2 fundamentals. Recalibrated:
         all six v1 known-bad files still FAIL at 0.62 [max 0.599]; the four
         owner-preferred round-4 beats pass at 0.678–0.903.)
      3. 20–300 Hz spectral centroid ≤ 90 Hz (backstop vs a lone kick thump).
    Returns (ok, metrics)."""
    from teardown.render.balance import band_metrics
    m = band_metrics(wav)
    ok = (32.0 <= m["peakHz"] <= 73.0) and m["subRatio"] >= 0.62 and m["lowCentroid"] <= 90.0
    return ok, {"peakHz": m["peakHz"], "subRatio": round(m["subRatio"], 3),
                "lowCentroid": m["lowCentroid"]}


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
    render_gate = render_gate_standalone
    lines = ["# Restart audition set — recombined from the seed recipe library",
             "# (real motifs recombined + transposed + 808 bound to chords; bootstrap corpus)\n"]
    n_ok = 0
    for i, (req, seed) in enumerate(BEATS):
        name = f"{i+1:02d}_{req['mood']}_{int(req['tempo'])}_{req['key'].replace(' ', '').replace('#','s')}.wav"
        wav = os.path.join(out_dir, name)
        best = None  # (rank, sub_bad, clip, seed, prov, res, sub_m)
        last_rendered = None  # which seed's audio is currently in the wav file
        for attempt in range(4):
            try_seed = seed + attempt * 13
            last_rendered = try_seed
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
        # the wav holds the LAST attempt's audio — re-render whenever the best seed isn't
        # the last one rendered (v4 03/05 shipped files that didn't match their reported
        # gate metrics: best was the ORIGINAL seed but retries overwrote the wav)
        if used_seed != last_rendered:
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
