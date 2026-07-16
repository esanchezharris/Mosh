"""Route C.2 — real-time RAVE *insert* offline-render check (anira build only).

Proves the live Tier-A RAVE insert (RaveInsertPlugin, via anira+LibTorch) transforms
audio in the render graph AND — the C.2 follow-up this guards — that an offline,
faster-than-real-time export is GAP-FREE. anira in real-time mode is non-blocking, so a
fast export outruns the inference thread and drops samples (block-boundary zero gaps);
the fix toggles anira to non-real-time (blocking) mode when PluginRenderContext::isRendering
is true so every block completes. This check fails if those gaps come back.

Gated like the other real-model checks: needs (a) a Mosh binary built with
-DMOSH_ENABLE_ANIRA=ON (else add_rave_insert is unknown → skips cleanly) and (b) the
transform venv (TRANSFORM_PY) to build a small SYNTHETIC scripted RAVE-shaped .ts (so we
don't depend on a flaky pretrained download — the real torch.jit/LibTorch path is still
exercised). Point --bin at build-anira/.../Mosh to run it.

Lazily imported by verify.py so the default offline checks never depend on torch/numpy-here.
"""
import json
import os
import subprocess
import tempfile
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]

# A scripted module whose forward() is a shape-preserving transform — exactly the I/O
# shape anira drives a RAVE export with ([1,1,2048] in == out; anira calls forward()).
_BUILDER = '''
import sys, torch
class FakeRave(torch.nn.Module):
    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return torch.tanh(x * 4.0)
torch.jit.script(FakeRave()).save(sys.argv[1])
'''


def _max_zero_run(sig):
    """Longest run of EXACT-zero samples — the signature of a dropped/missing block."""
    z = (sig == 0.0)
    if not z.any():
        return 0
    # run-lengths of True via diff of indices where the value changes
    idx = np.flatnonzero(np.diff(np.concatenate(([0], z.view(np.int8), [0]))))
    runs = idx[1::2] - idx[0::2]
    return int(runs.max()) if runs.size else 0


def _real_model_fallback():
    """First real .ts from the rack ($RAVE_MODEL_DIR, else ~/AI/rave-models). Used when
    no transform venv can build the synthetic model — e.g. the Windows PC, where real
    models exist but the transform venv is a deferred parity row (FIT-013)."""
    rack = os.environ.get("RAVE_MODEL_DIR") or os.path.expanduser("~/AI/rave-models")
    try:
        for f in sorted(os.listdir(rack)):
            if f.lower().endswith(".ts"):
                return os.path.join(rack, f)
    except OSError:
        pass
    return None


def check_rave_insert(ctx, ART, run_script, stats, diff_rms, failed_commands):
    name = "RAVE insert offline render (Route C.2)"
    if os.name == "nt":
        conventional = os.path.join(os.environ.get("LOCALAPPDATA", ""),
                                    "Mosh", "venvs", "transform", "Scripts", "python.exe")
    else:
        conventional = os.path.expanduser("~/Library/Mosh/venvs/transform/bin/python")
    py = os.environ.get("TRANSFORM_PY") or (
        conventional if os.path.isfile(conventional) else str(REPO / "service/transform/.venv/bin/python"))

    model = None
    if os.path.exists(py):
        # Build the synthetic scripted model (needs only torch, from the transform venv).
        d = tempfile.mkdtemp()
        builder = os.path.join(d, "_build.py"); Path(builder).write_text(_BUILDER)
        model = os.path.join(d, "rave_fake.ts")
        b = subprocess.run([py, builder, model], capture_output=True, text=True, timeout=180)
        if b.returncode != 0 or not os.path.isfile(model):
            return {"check": name, "pass": False,
                    "detail": {"stage": "build synthetic model", "stderr": b.stderr[-400:]}}
    else:
        model = _real_model_fallback()
        if model is None:
            return {"check": name, "pass": True,
                    "detail": {"skipped": "no transform venv (service/transform/setup-transform.sh) "
                                          "and no real .ts in the RAVE rack to fall back to"}}

    dry = ART / "04c_rave_insert_dry.wav"
    wet = ART / "04c_rave_insert_wet.wav"
    wet2 = ART / "04c_rave_insert_wet_postreset.wav"   # after reset_rave (rebuild+swap)
    cmds = [
        {"command": "create_track", "args": {"name": "Rave"}, "capture": {"T": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 2.0, "freq": 220.0}},
        {"command": "add_rave_insert", "args": {"trackId": "${T}", "path": model}, "capture": {"RI": "index"}},
        {"command": "set_rave_param", "args": {"trackId": "${T}", "index": "${RI}", "value": 0}},     # dry (L-delayed)
        {"command": "export_audio", "args": {"file": str(dry)}},
        {"command": "set_rave_param", "args": {"trackId": "${T}", "index": "${RI}", "value": 100}},   # full wet
        {"command": "export_audio", "args": {"file": str(wet)}},
        # reset_rave rebuilds the model + atomically swaps it in (RT-safe reset). Re-export and
        # assert the insert still transforms gap-free afterwards, exercising RaveEngine::reset's
        # rebuild-swap path end-to-end (a broken rebuild → silent/untransformed/gappy = fail).
        {"command": "reset_rave", "args": {"trackId": "${T}", "index": "${RI}"}},
        {"command": "export_audio", "args": {"file": str(wet2)}},
    ]
    results, proc = run_script(ctx.bin, cmds, "verify-rave-insert", timeout=300)

    add = next((r for r in results if r.get("command") == "add_rave_insert"), None)
    if add is None or not add.get("ok"):
        # Binary wasn't built with anira (command unknown / plugin not registered) → skip.
        return {"check": name, "pass": True,
                "detail": {"skipped": "binary lacks RAVE insert — build with -DMOSH_ENABLE_ANIRA=ON",
                           "add_result": add}}
    if not add.get("data", {}).get("modelLoaded"):
        return {"check": name, "pass": False,
                "detail": {"stage": "model load", "add_result": add, "stderr": proc.stderr[-400:]}}

    fails = failed_commands(results)
    if fails or not wet.exists() or not dry.exists() or not wet2.exists():
        return {"check": name, "pass": False,
                "detail": {"failed_commands": fails, "wet": wet.exists(), "dry": dry.exists(),
                           "wet_postreset": wet2.exists(), "stderr": proc.stderr[-500:]}}

    from verify import load_wav, mono  # reuse the WAV loader

    # Skip the head/tail latency regions (startup zeros + PDC tail are legitimate) and
    # look for dropped blocks in the steady-state middle.
    skip = 8192

    def _analyze(path):
        m = mono(load_wav(path)[0]); srr = load_wav(path)[1]
        finite = bool(np.isfinite(m).all())     # NaN/inf = a broken inference path
        st = stats(path)
        t = diff_rms(str(dry), str(path))
        mid = m[skip: max(skip, m.size - skip)]
        g = _max_zero_run(mid) if mid.size else 0
        return srr, st, t, g, finite

    sr, sw, transformed, gap, finite = _analyze(wet)
    # Post-reset export must ALSO be non-silent, transformed vs dry, and gap-free — i.e. the
    # reset rebuilt a working pipeline (not a dead/half-reset handler nor a lost model).
    sr2, sw2, transformed2, gap2, finite2 = _analyze(wet2)

    ok = bool(finite and sw["rms"] > 0.01 and transformed > 0.01 and gap < 256
              and finite2 and sw2["rms"] > 0.01 and transformed2 > 0.01 and gap2 < 256)
    return {"check": name, "pass": ok,
            "detail": {"wav": str(wet), **sw, "diff_from_dry_rms": transformed,
                       "max_zero_run_samples": gap, "gap_threshold": 256, "samplerate": sr,
                       "finite": finite,
                       "postreset": {"wav": str(wet2), **sw2, "diff_from_dry_rms": transformed2,
                                     "max_zero_run_samples": gap2, "finite": finite2},
                       "note": "synthetic scripted RAVE-shaped model through anira+LibTorch; "
                               "gap-free export proves non-real-time mode during render; the "
                               "post-reset export proves RaveEngine::reset()'s RT-safe "
                               "rebuild-swap yields a working pipeline"}}
