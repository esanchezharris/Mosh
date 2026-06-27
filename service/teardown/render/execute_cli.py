#!/usr/bin/env python3
"""Thin CLI around §9 execute_recipe — so the service (/teardown/execute) and the agent can
run a Recipe → MoshOps → render without importing the engine. Emits a JSON result.

    python3 execute_cli.py --recipe <recipe.json> [--out <wav>] [--asset-root <dir>]
"""
from __future__ import annotations

import argparse
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(os.path.dirname(_HERE))
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--recipe", required=True, help="path to a §0 Recipe JSON")
    ap.add_argument("--out", default="", help="output wav (default: temp under the session)")
    ap.add_argument("--asset-root", default="", help="base dir for relative midi_ref/sample paths")
    ap.add_argument("--no-synths", action="store_true", help="skip synth load/param resolution")
    ns = ap.parse_args(argv)

    if not os.path.isfile(ns.recipe):
        print(json.dumps({"ok": False, "error": f"recipe not found: {ns.recipe}"}))
        return 1
    try:
        from teardown import recipe as R
        from teardown.render.execute import execute_recipe
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"teardown import failed: {e}"}))
        return 1

    try:
        rec = R.from_json(open(ns.recipe).read())
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"recipe parse failed: {e}"}))
        return 1

    res = execute_recipe(rec, out_wav=ns.out or None,
                         asset_root=ns.asset_root or os.path.dirname(os.path.abspath(ns.recipe)),
                         resolve_synth_patches=not ns.no_synths)
    print(json.dumps({
        "ok": bool(res.ran and res.nonsilent and not res.error),
        "ran": res.ran, "nonsilent": res.nonsilent, "audio_rms": res.audio_rms,
        "out_wav": res.out_wav, "notes_resolved": res.notes_resolved,
        "synths_loaded": res.synths_loaded, "synth_params_set": res.synth_params_set,
        "yield_actual": res.yield_actual,
        "reconstruction_class": rec.reconstruction_class.value,
        "unresolved": res.unresolved[:20], "error": res.error,
        "command_count": len(res.commands),
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
