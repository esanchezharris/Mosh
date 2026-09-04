#!/usr/bin/env python3
"""Recipe generation CLI — runs the pydantic-backed §0.5 generator (recipes/generate.py,
which imports teardown/recipe.py -> pydantic, plus teardown/render/compile.py) either
in-process (server.py calls build_payload() directly when its own interpreter has pydantic)
or under the dedicated teardown venv (~/Library/Mosh/venvs/teardown) as a subprocess when it
doesn't — mirrors phonology_cli.py's dispatch shape for /get_rhymes.

Stdin carries the FULLY-RESOLVED request as one JSON object:
    {"request": {...}, "seed": int, "libraryDir": "<abs path>", "paletteManifest": "<abs path or "">"}
Path resolution (relative-path guessing, "does this dir exist") happens in server.py BEFORE
this runs — this file trusts its input verbatim, so it behaves identically whether called as
a function in-process or as a subprocess under a different cwd/interpreter.

Stdout carries ONLY the JSON result envelope — library import chatter (the palette
"MISSING on disk" warning, etc.) is routed to stderr so it never corrupts the JSON (mirrors
phonology_cli.py:16-17 / transcribe_cli.py's stdout hijack).

Usage:  generate_cli.py < request.json > result.json
        echo '{"request":{"mood":"dark","tempo":140},"seed":3,"libraryDir":"...",
               "paletteManifest":""}' | generate_cli.py
"""
from __future__ import annotations

import json
import os
import sys
from dataclasses import asdict

# Keep stdout clean for the JSON result; route any library chatter to stderr.
_OUT = sys.stdout
sys.stdout = sys.stderr

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
if SERVICE not in sys.path:
    sys.path.insert(0, SERVICE)


def build_payload(resolved: dict) -> dict:
    """resolved = {"request": dict, "seed": int, "libraryDir": <abs path>, "paletteManifest":
    <abs path> | ""}. Imports the pydantic-backed stack lazily (module scope must stay
    importable even when pydantic is absent, so this function can be *referenced* — e.g. for
    monkeypatching in tests — without pydantic ever loading). Raises RuntimeError for an
    honest, request-level failure (missing library); any other exception is a real bug and
    propagates so main() reports it verbatim rather than masking it."""
    from recipes import generate as gen  # noqa: PLC0415  (pulls in teardown.recipe -> pydantic)
    from teardown import recipe as recipe_model  # noqa: PLC0415
    from teardown.render.compile import compile_recipe  # noqa: PLC0415

    request = dict(resolved.get("request") or {})
    try:
        seed = int(resolved.get("seed", 0) or 0)
    except (TypeError, ValueError):
        seed = 0
    library_dir = str(resolved.get("libraryDir") or "").strip() or gen.LIB_DIR
    if not os.path.isdir(library_dir):
        raise RuntimeError(f"recipe library missing: {library_dir}")
    palette_manifest = str(resolved.get("paletteManifest") or "").strip()
    palette = gen.load_palette(palette_manifest) if palette_manifest else None

    rec, prov = gen.generate(request, library_dir=library_dir, seed=seed, palette=palette)
    compiled = compile_recipe(rec).to_dict()
    return {
        "ok": True,
        "recipeId": rec.recipe_id,
        "request": request,
        "libraryDir": library_dir,
        "paletteManifest": palette_manifest,
        "recipe": json.loads(recipe_model.to_json(rec)),
        "program": compiled,
        "provenance": asdict(prov),
        "commandCount": len(compiled.get("commands", [])),
        "unresolvedCount": len(compiled.get("unresolved", [])),
    }


def main(argv=None) -> int:  # noqa: ARG001 (argv unused — request rides stdin, not argv)
    try:
        raw = sys.stdin.read()
        resolved = json.loads(raw) if raw.strip() else {}
        if not isinstance(resolved, dict):
            raise RuntimeError("stdin must be a JSON object")
        payload = build_payload(resolved)
    except Exception as e:  # noqa: BLE001 — this CLI's whole job is turning any failure
        # (a deliberate RuntimeError OR a genuine bug) into an honest {ok:false, error}
        # envelope on stdout: the caller (server.py, mirroring /get_rhymes) does
        # `json.loads(stdout)` and must never see a raw Python traceback instead of JSON.
        _OUT.write(json.dumps({"ok": False, "error": str(e)}))
        return 1
    _OUT.write(json.dumps(payload))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
