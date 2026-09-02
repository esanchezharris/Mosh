#!/usr/bin/env python3
"""Dispatch-selection test for /generate_recipe's split (server.py's _generate_recipe_payload
+ recipes/generate_cli.py::build_payload — see recipes/generate_cli_test.py for the CLI's
own real-generation round-trip test).

Proves the SELECTION logic — in-process vs. teardown-venv subprocess vs. an honest
"unavailable" — without needing a pydantic-capable interpreter anywhere:
  * the in-process branch is exercised by monkeypatching recipes.generate_cli.build_payload
    directly (its module import is pydantic-free; only CALLING it needs pydantic, and this
    test never calls the real one), so it runs under plain python3 regardless of what's
    installed;
  * the subprocess branch uses sys.executable AS the "teardown venv" python — a real
    interpreter, so this exercises the actual subprocess-spawn + stdout-JSON-parse +
    error-mapping code (not a mock of it). Whether or not sys.executable happens to have
    pydantic, the test asserts the one thing that must always hold: a well-formed {ok, error}
    (or full success) JSON envelope comes back with the DOCUMENTED key set — server.py never
    surfaces a raw traceback or an empty result;
  * the "neither available" branch points TEARDOWN_PY at a path that does not exist and
    checks the RuntimeError names it "unavailable".

Run:  python3 service/scripts/recipe_dispatch_test.py     (exit 0 = all pass)
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

# Force the guest posture before importing server — same reasoning as
# guest_degradation_test.py: this dev Mac has every venv/model installed, so without this
# override the test would exercise the wrong (fully-equipped) state instead of the dispatch
# logic under test.
_TMP = tempfile.mkdtemp(prefix="mosh-recipe-dispatch-")
os.environ["MOSH_VENVS_DIR"] = os.path.join(_TMP, "venvs")
os.environ["MOSH_ENABLE_SA3"] = "0"
os.environ.pop("MOSH_PALETTE_MANIFEST", None)
os.environ.pop("MOSH_RECIPE_LIBRARY", None)
os.environ.pop("TEARDOWN_PY", None)

import server  # noqa: E402
import recipes.generate_cli as generate_cli  # noqa: E402

fails = []


def check(name, cond, detail=""):
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond or not detail else f"  [{detail}]"))
    if not cond:
        fails.append(name)


# The documented /generate_recipe success shape (server.py's docstring + generate_cli.py's
# build_payload) — both dispatch paths must return exactly this key set.
PAYLOAD_KEYS = {"ok", "recipeId", "request", "libraryDir", "paletteManifest",
                "recipe", "program", "provenance", "commandCount", "unresolvedCount"}

REQUEST_BODY = {"request": {"mood": "dark", "key": "F minor"}, "tempo": 140, "seed": 3}


def fake_build_payload(resolved):
    return {
        "ok": True, "recipeId": "gen_fake", "request": resolved["request"],
        "libraryDir": resolved["libraryDir"], "paletteManifest": resolved["paletteManifest"],
        "recipe": {"recipe_id": "gen_fake"},
        "program": {"commands": [{"command": "set_tempo", "args": {"bpm": 140}}], "unresolved": []},
        "provenance": {}, "commandCount": 1, "unresolvedCount": 0,
    }


def _has_pydantic(py):
    try:
        proc = subprocess.run([py, "-c", "import pydantic"], capture_output=True, timeout=30)
        return proc.returncode == 0
    except Exception:  # noqa: BLE001
        return False


def main():
    orig_importable = server._recipe_stack_importable
    orig_teardown_py = server._teardown_py
    orig_build_payload = generate_cli.build_payload

    # ── Case A: pydantic importable HERE → dispatch stays in-process (never shells out).
    #    Proof it never shells out: _teardown_py is forced to a guaranteed-nonexistent path;
    #    if dispatch used it anyway this call would raise ("unavailable"), not return the
    #    monkeypatched payload.
    try:
        server._recipe_stack_importable = lambda: True
        server._teardown_py = lambda: os.path.join(_TMP, "definitely-does-not-exist", "python")
        generate_cli.build_payload = fake_build_payload
        result = server._generate_recipe_payload(REQUEST_BODY)
        # If dispatch had fallen back to the subprocess path despite pydantic being
        # "importable", _teardown_py's nonexistent path would have raised RuntimeError here
        # instead of returning — reaching this line at all is part of the proof.
        check("in-process dispatch returns the CLI's payload untouched",
              result.get("recipeId") == "gen_fake", str(result))
        check("in-process payload key set matches the documented /generate_recipe shape",
              set(result.keys()) == PAYLOAD_KEYS, str(sorted(result.keys())))
    finally:
        server._recipe_stack_importable = orig_importable
        server._teardown_py = orig_teardown_py
        generate_cli.build_payload = orig_build_payload

    # ── Case B: pydantic not importable here → dispatch shells out to "the teardown venv"
    #    (sys.executable stands in for it, so this is a REAL subprocess round-trip through
    #    the real generate_cli.py).
    try:
        server._recipe_stack_importable = lambda: False
        server._teardown_py = lambda: sys.executable
        raised = None
        result = None
        try:
            result = server._generate_recipe_payload(REQUEST_BODY)
        except RuntimeError as e:
            raised = e
        if _has_pydantic(sys.executable):
            check("subprocess dispatch succeeds when sys.executable has pydantic",
                  raised is None and result is not None, str(raised))
            if result is not None:
                check("…and returns the same documented key set as the in-process path",
                      set(result.keys()) == PAYLOAD_KEYS, str(sorted(result.keys())))
        else:
            # generate_cli.py's own top-level except turns the ModuleNotFoundError into an
            # honest {"ok": false, "error": "...pydantic..."} envelope on stdout — server.py
            # must surface THAT message via RuntimeError, not swallow it into a bare 500.
            check("subprocess dispatch surfaces generate_cli.py's own error message "
                  "(no interpreter had pydantic)",
                  raised is not None and "pydantic" in str(raised).lower(), str(raised))
    finally:
        server._recipe_stack_importable = orig_importable
        server._teardown_py = orig_teardown_py

    # ── Case C: pydantic not importable AND no teardown venv on disk → an honest
    #    "unavailable" RuntimeError (never a silent fake recipe, never a bare OSError).
    try:
        server._recipe_stack_importable = lambda: False
        server._teardown_py = lambda: os.path.join(_TMP, "venvs", "teardown", "bin", "python")
        raised = None
        try:
            server._generate_recipe_payload(REQUEST_BODY)
        except RuntimeError as e:
            raised = e
        check("missing teardown venv raises RuntimeError", raised is not None, str(raised))
        check('...and names it "unavailable"',
              raised is not None and "unavailable" in str(raised).lower(), str(raised))
    finally:
        server._recipe_stack_importable = orig_importable
        server._teardown_py = orig_teardown_py

    print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
    return len(fails)


if __name__ == "__main__":
    sys.exit(main())
