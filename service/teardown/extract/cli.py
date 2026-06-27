#!/usr/bin/env python3
"""CLI: separate an audio file → stems + drum slices (§7), optionally §1-matched.

  python3 cli.py --in <wav> --out <dir> [--match-index <index_dir>]

Emits JSON on stdout. Needs demucs (setup-teardown.sh --with-extract).
"""
import json
import os
import sys

_real_stdout = sys.stdout
sys.stdout = sys.stderr  # keep torch/demucs chatter off the JSON channel

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(os.path.dirname(_HERE))
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

from teardown.extract import DemucsSeparator, slice_oneshots  # noqa: E402


def _emit(obj, code=0):
    sys.stdout = _real_stdout
    print(json.dumps(obj, indent=2))
    raise SystemExit(code)


def main(argv=None):
    import argparse
    from pathlib import Path

    import numpy as np
    import soundfile as sf

    ap = argparse.ArgumentParser(description="§7 extraction CLI")
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--match-index", default="")
    ns = ap.parse_args(argv)

    sep = DemucsSeparator()
    if not sep.available:
        _emit({"ok": False, "error": "extract_unavailable (setup-teardown.sh --with-extract)"}, 1)
    if not os.path.exists(ns.inp):
        _emit({"ok": False, "error": f"input not found: {ns.inp}"}, 1)

    try:
        y, sr = sf.read(ns.inp, dtype="float32", always_2d=True)
        y = y.mean(axis=1)
        stems = sep.split(y, sr)
        out = Path(ns.out)
        out.mkdir(parents=True, exist_ok=True)
        stem_rms = {}
        for name, s in stems.items():
            sf.write(str(out / f"{name}.wav"), s, 44100)
            stem_rms[name] = round(float(np.sqrt(np.mean(s.astype(np.float64) ** 2))), 5)
        slices = slice_oneshots(stems["drums"], 44100, out_dir=out / "drum_hits")
        matches = []
        if ns.match_index:
            from teardown.drummatch import DrumMatcher
            dm = DrumMatcher().load(ns.match_index)
            for sl in slices[:8]:
                m = dm.query(sl.samples, k=1)
                matches.append({"t_s": sl.t_s, "role": sl.role_guess,
                                "match": (m[0].path if m else None), "distance": (m[0].distance if m else None)})
        _emit({"ok": True, "stem_rms": stem_rms, "drum_slices": len(slices), "matches": matches,
               "out": str(out)})
    except SystemExit:
        raise
    except Exception as e:
        _emit({"ok": False, "error": f"{type(e).__name__}: {e}"}, 1)


if __name__ == "__main__":
    main()
