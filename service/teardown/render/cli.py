#!/usr/bin/env python3
"""CLI: a §0 Recipe JSON → the §9 MoshOps command list (data-only; no engine).

  python3 cli.py --recipe <recipe.json>   → prints { commands, unresolved }
"""
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(os.path.dirname(_HERE))
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

from teardown.recipe import from_json  # noqa: E402
from teardown.render.compile import compile_recipe  # noqa: E402


def main(argv=None) -> int:
    import argparse

    ap = argparse.ArgumentParser(description="§9 Recipe → MoshOps command list")
    ap.add_argument("--recipe", required=True, help="path to a recipe.json")
    ns = ap.parse_args(argv)
    with open(ns.recipe) as f:
        rec = from_json(f.read())
    print(json.dumps(compile_recipe(rec).to_dict(), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
