#!/usr/bin/env python3
"""Unit test for rave_insert_check's REAL-model candidate selection.

Pins the lesson of the FIT-013 false alarm: birds.ts (alphabetically FIRST in the
rack) maps the harness's 220 Hz tone to exact silence after 1-2 blocks under ANY
torch runtime (encoder-state runaway — a model property, not a pipeline bug), so a
blind first-sorted-.ts pick misreports the whole insert as broken. The check must
iterate candidates, skip-and-report models that are silent-on-tone or fail to load,
and fail only on genuine pipeline signals (gaps, NaN, silent-after-reset, all
candidates dead).

Injects a fake run_script that fabricates the dry/wet/wet2 WAVs per a behavior map,
so no binary, torch, or real model is needed. 3x deterministic.
"""
from __future__ import annotations

import contextlib
import importlib.util
import json
import math
import os
import tempfile
import wave
from pathlib import Path
from types import SimpleNamespace

import numpy as np

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("rave_insert_check", HERE / "rave_insert_check.py")
assert SPEC and SPEC.loader
RIC = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RIC)

VERIFY_SPEC = importlib.util.spec_from_file_location("verify", HERE / "verify.py")
assert VERIFY_SPEC and VERIFY_SPEC.loader
VERIFY = importlib.util.module_from_spec(VERIFY_SPEC)
VERIFY.__spec__ = VERIFY_SPEC
import sys
sys.modules.setdefault("verify", VERIFY)
VERIFY_SPEC.loader.exec_module(VERIFY)

FRAMES = 30000  # > 2*skip(8192) so the gap scan has a real middle window


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" - {detail}" if detail and not ok else ""))
    if not ok:
        raise AssertionError(name)


def _write_wav(path: Path, kind: str) -> None:
    t = np.arange(FRAMES, dtype=np.float64)
    if kind == "silent":
        sig = np.zeros(FRAMES)
    elif kind == "dry":
        sig = 0.2 * np.sin(2 * math.pi * 220.0 * t / 44100.0)
    elif kind == "audible":
        sig = 0.5 * np.sin(2 * math.pi * 330.0 * t / 44100.0)
    elif kind == "gappy":
        sig = 0.5 * np.sin(2 * math.pi * 330.0 * t / 44100.0)
        sig[12000:18000] = 0.0  # a dropped-block hole inside the steady-state window
    else:
        raise ValueError(kind)
    pcm = (np.clip(sig, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(44100)
        w.writeframes(pcm.tobytes())


def _fake_run_script(behaviors):
    """behaviors: {model_basename: 'audible'|'silent'|'load_fail'|'gappy'|'silent_after_reset'}"""
    def run_script(binary, cmds, session, timeout=None, **kw):
        model = next(c["args"]["path"] for c in cmds if c["command"] == "add_rave_insert")
        b = behaviors[os.path.basename(model)]
        exports = [Path(c["args"]["file"]) for c in cmds if c["command"] == "export_audio"]
        dry, wet, wet2 = exports
        _write_wav(dry, "dry")
        if b == "load_fail":
            _write_wav(wet, "dry"); _write_wav(wet2, "dry")   # passthrough: model never engaged
        else:
            wet_kind = "silent" if b == "silent" else ("gappy" if b == "gappy" else "audible")
            wet2_kind = "silent" if b in ("silent", "silent_after_reset") else wet_kind
            _write_wav(wet, wet_kind)
            _write_wav(wet2, wet2_kind)
        results = []
        for c in cmds:
            r = {"command": c["command"], "ok": True, "data": {}}
            if c["command"] == "add_rave_insert":
                r["data"] = {"modelLoaded": b != "load_fail", "index": 0}
            results.append(r)
        return results, SimpleNamespace(stderr="", stdout="")
    return run_script


@contextlib.contextmanager
def _env(**kv):
    old = {k: os.environ.get(k) for k in kv}
    try:
        for k, v in kv.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        yield
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def _run(behaviors, rack_models, tmp, env_extra=None):
    rack = Path(tmp) / "rack"
    rack.mkdir(exist_ok=True)
    for m in rack_models:
        (rack / m).write_bytes(b"fake-ts")
    art = Path(tmp) / "art"
    art.mkdir(exist_ok=True)
    ctx = SimpleNamespace(bin="/nonexistent/Mosh")
    env = {"RAVE_MODEL_DIR": str(rack), "TRANSFORM_PY": "/nonexistent/python",
           "RAVE_INSERT_MODEL": None}
    env.update(env_extra or {})
    with _env(**env):
        return RIC.check_rave_insert(ctx, art, _fake_run_script(behaviors),
                                     VERIFY.stats, VERIFY.diff_rms, VERIFY.failed_commands)


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        # 1) the FIT-013 scenario: first sorted model silent-on-tone, second healthy
        r = _run({"birds.ts": "silent", "ensembles.ts": "audible"},
                 ["birds.ts", "ensembles.ts"], tmp)
        check("silent first model is skipped, check passes on the next", r["pass"] is True,
              json.dumps(r["detail"])[:300])
        check("passing detail names the model that proved the pipeline",
              r["detail"].get("model") == "ensembles.ts", json.dumps(r["detail"])[:300])
        skipped = r["detail"].get("skipped", [])
        check("skip list carries birds.ts with a silent-on-tone reason",
              len(skipped) == 1 and skipped[0]["model"] == "birds.ts"
              and skipped[0]["reason"] == "model_silent", json.dumps(skipped))

    with tempfile.TemporaryDirectory() as tmp:
        # 2) every candidate silent -> genuine pipeline suspicion -> FAIL
        r = _run({"a.ts": "silent", "b.ts": "silent"}, ["a.ts", "b.ts"], tmp)
        check("all-silent rack fails the check", r["pass"] is False, json.dumps(r["detail"])[:300])
        check("all-silent failure reports every skipped candidate",
              len(r["detail"].get("skipped", [])) == 2, json.dumps(r["detail"])[:300])

    with tempfile.TemporaryDirectory() as tmp:
        # 3) load failure (e.g. a genuinely runtime-incompatible trace) skips, not fails
        r = _run({"broken.ts": "load_fail", "good.ts": "audible"},
                 ["broken.ts", "good.ts"], tmp)
        check("unloadable model is skipped, check passes on the next", r["pass"] is True,
              json.dumps(r["detail"])[:300])
        check("skip list carries the load failure",
              any(s["reason"] == "load_failed" for s in r["detail"].get("skipped", [])),
              json.dumps(r["detail"])[:300])

    with tempfile.TemporaryDirectory() as tmp:
        # 4) RAVE_INSERT_MODEL pins the candidate (bare rack name), no iteration
        r = _run({"birds.ts": "silent", "guitar.ts": "audible"},
                 ["birds.ts", "guitar.ts"], tmp, env_extra={"RAVE_INSERT_MODEL": "guitar.ts"})
        check("RAVE_INSERT_MODEL pins the model", r["pass"] is True
              and r["detail"].get("model") == "guitar.ts", json.dumps(r["detail"])[:300])
        r = _run({"birds.ts": "silent", "guitar.ts": "audible"},
                 ["birds.ts", "guitar.ts"], tmp, env_extra={"RAVE_INSERT_MODEL": "birds.ts"})
        check("a pinned silent model fails hard (explicit choice, no fallback)",
              r["pass"] is False, json.dumps(r["detail"])[:300])

    with tempfile.TemporaryDirectory() as tmp:
        # 5) gaps in an audible wet = dropped blocks = hard pipeline failure, no iteration past it
        r = _run({"a.ts": "gappy", "b.ts": "audible"}, ["a.ts", "b.ts"], tmp)
        check("gappy (dropped-block) output fails hard instead of iterating",
              r["pass"] is False, json.dumps(r["detail"])[:300])

    with tempfile.TemporaryDirectory() as tmp:
        # 6) audible wet but silent post-reset = reset regression = hard failure
        r = _run({"a.ts": "silent_after_reset", "b.ts": "audible"}, ["a.ts", "b.ts"], tmp)
        check("silent-after-reset fails hard (reset rebuilt a dead pipeline)",
              r["pass"] is False, json.dumps(r["detail"])[:300])

    print("rave_insert_check_test: all checks passed")


if __name__ == "__main__":
    main()
