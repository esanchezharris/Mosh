#!/usr/bin/env python3
"""CLI for the drum matcher — the subprocess the /teardown/* service endpoints shell to.

  build:  python3 cli.py build --library <root>  --out <index_dir> [--embedder engineered|clap]
  match:  python3 cli.py match --index <index_dir> --audio <wav> [--role r] [--k n]

Emits exactly one JSON object on stdout (all numpy/librosa chatter is forced to stderr),
exit 0 on success / 1 on error. Mirrors transcribe_cli / sketch conventions.
"""
import json
import os
import sys

# Keep stdout clean for the JSON payload; restore only to emit it.
_real_stdout = sys.stdout
sys.stdout = sys.stderr

# Warm librosa's numba import BEFORE service/ goes on sys.path (see drummatch_test.py:
# service/coverage.py shadows numba's optional `coverage` probe). Absent librosa is
# surfaced later as a JSON error by the embedder, not here.
try:
    import librosa.effects  # noqa: F401
except ImportError:
    pass

# Run-as-a-file support: put the `service` dir on the path so the package
# (teardown.drummatch.*) and its `..recipe` relative import resolve.
_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(os.path.dirname(_HERE))
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)


def _emit(obj, code=0):
    sys.stdout = _real_stdout
    print(json.dumps(obj))
    raise SystemExit(code)


def _pick_embedder(name):
    from teardown.drummatch.embed import ClapEmbedder, EngineeredEmbedder

    if name == "clap":
        clap = ClapEmbedder()
        if clap.available:
            return clap, None
        return EngineeredEmbedder(), "clap_unavailable; used engineered baseline"
    return EngineeredEmbedder(), None


def main(argv=None):
    import argparse

    ap = argparse.ArgumentParser(description="drum-sample matcher CLI")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("--library", required=True)
    b.add_argument("--out", required=True)
    b.add_argument("--embedder", default="engineered", choices=["engineered", "clap"])
    q = sub.add_parser("match")
    q.add_argument("--index", required=True)
    q.add_argument("--audio", required=True)
    q.add_argument("--role", default="")
    q.add_argument("--k", type=int, default=5)
    ns = ap.parse_args(argv)

    from teardown.drummatch.index import DrumMatcher, SampleIndex

    try:
        if ns.cmd == "build":
            embedder, note = _pick_embedder(ns.embedder)
            idx = SampleIndex(embedder=embedder)
            stats = idx.build(ns.library)
            idx.save(ns.out)
            _emit({
                "ok": True,
                "note": note,
                "stats": {
                    "indexed": stats.indexed,
                    "skipped": stats.skipped,
                    "embedder_version": stats.embedder_version,
                },
                "skipped_files": stats.skipped_files,
                "out": str(ns.out),
            })
        elif ns.cmd == "match":
            if not os.path.exists(ns.audio):
                _emit({"ok": False, "error": f"audio not found: {ns.audio}"}, 1)
            dm = DrumMatcher().load(ns.index)
            role = ns.role or None
            matches = dm.query(ns.audio, role=role, k=ns.k)
            _emit({
                "ok": True,
                "embedder_version": dm.index.version,
                "matches": [
                    {"path": m.path, "distance": m.distance, "role_guess": m.role_guess, "kind": m.kind}
                    for m in matches
                ],
            })
    except SystemExit:
        raise
    except Exception as e:  # never crash the endpoint; surface as JSON error
        _emit({"ok": False, "error": f"{type(e).__name__}: {e}"}, 1)


if __name__ == "__main__":
    main()
