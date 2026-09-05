#!/usr/bin/env python3
"""Subprocess round-trip test for recipes/generate_cli.py — the pydantic-backed recipe
generation CLI that server.py's /generate_recipe dispatches to (in-process when its own
interpreter has pydantic, else as a subprocess under the teardown venv). See
service/scripts/recipe_dispatch_test.py for the SELECTION logic itself (tested there with
pydantic monkeypatched out, so it runs under any python3); THIS file needs a REAL
pydantic-capable interpreter to prove the CLI actually generates a real recipe from the
bundled ~590-recipe library — there is no honest way to fake that through a subprocess.

Picks, in order: sys.executable (if pydantic is importable there), else TEARDOWN_PY / the
conventional teardown venv (~/Library/Mosh/venvs/teardown), else the SA3 MLX venv
(~/AI/stable-audio-3/optimized/mlx/.venv, per docs/POSTMORTEM-2026-09). Skips cleanly (exit
0, with a message) when NONE of those has pydantic — but always asserts real checks ran when
one does, so a quietly-broken interpreter search can't masquerade as "skip".

Run:  python3 service/recipes/generate_cli_test.py
"""
import importlib.util
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
CLI = os.path.join(HERE, "generate_cli.py")
LIB_DIR = os.path.join(HERE, "library")

fails = []
ran_any_check = False


def check(name, cond, detail=""):
    global ran_any_check
    ran_any_check = True
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond or not detail else f"  [{detail}]"))
    if not cond:
        fails.append(name)


def _venvs_root():
    explicit = os.environ.get("MOSH_VENVS_DIR", "").strip()
    if explicit:
        return explicit
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA", "").strip() or os.path.expanduser("~")
        return os.path.join(base, "Mosh", "venvs")
    return os.path.join(os.path.expanduser("~"), "Library", "Mosh", "venvs")


def _venv_py(dirname):
    exe = "python.exe" if os.name == "nt" else "python"
    sub = "Scripts" if os.name == "nt" else "bin"
    return os.path.join(_venvs_root(), dirname, sub, exe)


def _has_pydantic(py):
    if not py or not os.path.isfile(py):
        return False
    try:
        proc = subprocess.run([py, "-c", "import pydantic"], capture_output=True, timeout=30)
        return proc.returncode == 0
    except Exception:  # noqa: BLE001
        return False


def _pick_interpreter():
    if importlib.util.find_spec("pydantic") is not None:
        return sys.executable
    candidates = [
        os.environ.get("TEARDOWN_PY", "").strip(),
        _venv_py("teardown"),
        os.path.expanduser("~/AI/stable-audio-3/optimized/mlx/.venv/bin/python"),
    ]
    for c in candidates:
        if c and _has_pydantic(c):
            return c
    return None


def run_cli(py, payload, timeout=120):
    return subprocess.run([py, CLI], input=json.dumps(payload), capture_output=True,
                          text=True, timeout=timeout, cwd=SERVICE)


def main():
    py = _pick_interpreter()
    if py is None:
        print("skip generate_cli_test: no interpreter on this machine has pydantic "
              "(checked sys.executable, TEARDOWN_PY, ~/Library/Mosh/venvs/teardown, and the "
              "SA3 MLX venv) — install it in one of them to exercise the real CLI round-trip")
        return 0
    print(f"— using interpreter: {py} —")

    request = {"request": {"mood": "dark", "tempo": 140, "key": "F minor"}, "seed": 3,
               "libraryDir": LIB_DIR, "paletteManifest": ""}
    proc = run_cli(py, request)
    check("generate_cli.py exits 0 on a real request",
          proc.returncode == 0, f"stderr tail: {proc.stderr[-300:]!r}")
    check("stdout is a single JSON line (no leaked library chatter)",
          proc.stdout.strip().count("\n") == 0, repr(proc.stdout[:200]))
    try:
        payload = json.loads((proc.stdout or "").strip())
    except (json.JSONDecodeError, ValueError):
        check("stdout parses as JSON", False, repr(proc.stdout[:200]))
        payload = {}
    if payload:
        check("payload.ok is True", payload.get("ok") is True, str(payload.get("error")))
        check("recipeId is present", bool(payload.get("recipeId")))
        check("commandCount >= 1 (a real program was compiled)", payload.get("commandCount", 0) >= 1)
        commands = payload.get("program", {}).get("commands")
        check("program.commands is a non-empty list",
              isinstance(commands, list) and len(commands) >= 1, str(type(commands)))
        check("at least one create_track command was emitted",
              any(c.get("command") == "create_track" for c in (commands or [])),
              str([c.get("command") for c in (commands or [])]))
        check("libraryDir round-trips to the bundled library",
              payload.get("libraryDir") == LIB_DIR, str(payload.get("libraryDir")))

    # Determinism: same (request, seed) -> the same recipeId (mirrors generate_test.py's
    # in-process determinism check, through the actual subprocess CLI this time).
    proc2 = run_cli(py, request)
    payload2 = json.loads((proc2.stdout or "{}").strip() or "{}")
    check("same request+seed -> the same recipeId across two CLI invocations",
          payload.get("recipeId") and payload.get("recipeId") == payload2.get("recipeId"),
          f"{payload.get('recipeId')} vs {payload2.get('recipeId')}")

    # A genuinely bad request (missing library) still returns an honest JSON error envelope
    # on stdout with a non-zero exit — never a raw Python traceback, which would poison
    # server.py's json.loads() and surface as a confusing 500 instead of the real cause.
    bad = run_cli(py, {"request": {}, "seed": 0, "libraryDir": "/nonexistent/recipe/lib",
                       "paletteManifest": ""}, timeout=60)
    check("a missing library dir exits non-zero", bad.returncode != 0)
    try:
        bad_payload = json.loads((bad.stdout or "").strip())
        check("...and still emits an honest {ok: false, error} envelope on stdout",
              bad_payload.get("ok") is False and "error" in bad_payload, str(bad_payload))
        check("...naming the missing library",
              "library" in str(bad_payload.get("error", "")).lower(), str(bad_payload))
    except (json.JSONDecodeError, ValueError):
        check("bad-request stdout parses as JSON", False, repr(bad.stdout[:200]))

    if not ran_any_check:
        print("FAIL generate_cli_test: no checks ran (interpreter search or CLI invocation "
              "silently produced nothing)")
        return 1

    print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
    return len(fails)


if __name__ == "__main__":
    sys.exit(main())
