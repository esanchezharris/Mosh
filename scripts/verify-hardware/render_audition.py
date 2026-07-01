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
    lines = ["# Restart audition set — recombined from the seed recipe library",
             "# (real motifs recombined + transposed + 808 bound to chords; bootstrap corpus)\n"]
    n_ok = 0
    for i, (req, seed) in enumerate(BEATS):
        rec, prov = G.generate(req, seed=seed, palette=palette)
        name = f"{i+1:02d}_{req['mood']}_{int(req['tempo'])}_{req['key'].replace(' ', '').replace('#','s')}.wav"
        wav = os.path.join(out_dir, name)
        res = execute_recipe(rec, bin_path=binp, out_wav=wav,
                             session_dir=os.path.join(out_dir, f".s{i}"), timeout_s=180,
                             write_back=False, resolve_synth_patches=False)
        status = "OK " if res.nonsilent and res.error is None else "BAD"
        n_ok += 1 if status == "OK " else 0
        src = " + ".join(f"{k}:{v}" for k, v in prov.sources.items())
        print(f"  {status} {name}  rms={res.audio_rms:.4f}  [{src}]")
        lines.append(f"- **{name}** — {req['mood']} {int(req['tempo'])}bpm {req['key']}  \n"
                     f"  sources: {prov.sources}  transpose: {prov.transpose}")
    with open(os.path.join(out_dir, "README.md"), "w") as f:
        f.write("\n".join(lines) + "\n")
    print(f"\n{n_ok}/{len(BEATS)} rendered → {out_dir}")
    return 0 if n_ok == len(BEATS) else 1


if __name__ == "__main__":
    raise SystemExit(main())
