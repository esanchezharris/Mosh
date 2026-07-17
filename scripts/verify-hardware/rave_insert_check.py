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

REAL-model mode (no transform venv, or $RAVE_INSERT_MODEL set): candidates come from
the rack and are tried IN ORDER until one produces a healthy render. A pretrained RAVE
model can legitimately map the harness's 220 Hz tone to silence — birds.ts's encoder
state runs away on out-of-domain input and pins the decoder to exact zeros under EVERY
torch runtime (the FIT-013 "insert is silent on Windows" false alarm: the old code
blind-picked the first sorted .ts, which is birds.ts). Silent-on-tone and
failed-to-load candidates are skipped AND reported; the check fails only on genuine
pipeline signals: dropped-block gaps, NaN, a silent post-reset render, a command
failure, or every candidate coming up dead. Set RAVE_INSERT_MODEL (absolute path or a
bare rack filename) to pin one model explicitly — a pinned model is never iterated
past, so a silent pick fails hard.

Lazily imported by verify.py so the default offline checks never depend on torch/numpy-here.
"""
import json
import os
import subprocess
import tempfile
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]

# Real-model mode tries at most this many rack candidates before concluding the
# problem is the pipeline (or a very unlucky rack) rather than one model's taste.
MAX_REAL_CANDIDATES = 4

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


def _real_model_candidates():
    """Real .ts candidates from the rack ($RAVE_MODEL_DIR, else ~/AI/rave-models), in
    sorted order. $RAVE_INSERT_MODEL (absolute path or bare rack filename) pins the
    list to exactly that one model."""
    rack = os.environ.get("RAVE_MODEL_DIR") or os.path.expanduser("~/AI/rave-models")
    pinned = os.environ.get("RAVE_INSERT_MODEL")
    if pinned:
        p = pinned if os.path.isabs(pinned) else os.path.join(rack, pinned)
        return [p], True
    try:
        return [os.path.join(rack, f) for f in sorted(os.listdir(rack))
                if f.lower().endswith(".ts")], False
    except OSError:
        return [], False


def _run_one_model(ctx, ART, run_script, stats, diff_rms, failed_commands, model, tag):
    """Drive the full insert flow (dry → wet → reset → wet again) with one model and
    classify the outcome:
      binary_lacks_anira — add_rave_insert unknown → the whole check should skip
      load_failed        — the model didn't load (bad file / incompatible trace)
      run_failed         — a command failed or an export is missing (hard)
      not_finite         — NaN/inf in a render (hard)
      model_silent       — pipeline behaved but the model maps the tone to silence
      reset_regression   — audible wet but silent/gappy after reset_rave (hard)
      gappy              — dropped-block zero runs in an audible render (hard)
      untransformed      — wet ≈ dry: the insert isn't in the signal path (hard)
      ok                 — healthy
    Returns (cls, detail_dict)."""
    dry = ART / f"04c_rave_insert_{tag}_dry.wav"
    wet = ART / f"04c_rave_insert_{tag}_wet.wav"
    wet2 = ART / f"04c_rave_insert_{tag}_wet_postreset.wav"   # after reset_rave (rebuild+swap)
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
    results, proc = run_script(ctx.bin, cmds, f"verify-rave-insert-{tag}", timeout=300)

    add = next((r for r in results if r.get("command") == "add_rave_insert"), None)
    if add is None or not add.get("ok"):
        return "binary_lacks_anira", {"add_result": add}
    if not add.get("data", {}).get("modelLoaded"):
        return "load_failed", {"add_result": add, "stderr": proc.stderr[-400:]}

    fails = failed_commands(results)
    if fails or not wet.exists() or not dry.exists() or not wet2.exists():
        return "run_failed", {"failed_commands": fails, "wet": wet.exists(), "dry": dry.exists(),
                              "wet_postreset": wet2.exists(), "stderr": proc.stderr[-500:]}

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

    detail = {"wav": str(wet), **sw, "diff_from_dry_rms": transformed,
              "max_zero_run_samples": gap, "gap_threshold": 256, "samplerate": sr,
              "finite": finite,
              "postreset": {"wav": str(wet2), **sw2, "diff_from_dry_rms": transformed2,
                            "max_zero_run_samples": gap2, "finite": finite2}}

    if not (finite and finite2):
        return "not_finite", detail
    if sw["rms"] <= 0.01:
        # The pipeline ran to completion but the model maps the test tone to silence —
        # a model property (state runaway / out-of-domain input), not an insert bug.
        return "model_silent", detail
    if sw2["rms"] <= 0.01:
        return "reset_regression", detail      # audible before reset, dead after → hard
    if gap >= 256 or gap2 >= 256:
        return "gappy", detail
    if transformed <= 0.01 or transformed2 <= 0.01:
        return "untransformed", detail
    return "ok", detail


def check_rave_insert(ctx, ART, run_script, stats, diff_rms, failed_commands):
    name = "RAVE insert offline render (Route C.2)"
    if os.name == "nt":
        conventional = os.path.join(os.environ.get("LOCALAPPDATA", ""),
                                    "Mosh", "venvs", "transform", "Scripts", "python.exe")
    else:
        conventional = os.path.expanduser("~/Library/Mosh/venvs/transform/bin/python")
    py = os.environ.get("TRANSFORM_PY") or (
        conventional if os.path.isfile(conventional) else str(REPO / "service/transform/.venv/bin/python"))

    synthetic_note = ("synthetic scripted RAVE-shaped model through anira+LibTorch; "
                      "gap-free export proves non-real-time mode during render; the "
                      "post-reset export proves RaveEngine::reset()'s RT-safe "
                      "rebuild-swap yields a working pipeline")

    if os.path.exists(py) and not os.environ.get("RAVE_INSERT_MODEL"):
        # Build the synthetic scripted model (needs only torch, from the transform venv).
        d = tempfile.mkdtemp()
        builder = os.path.join(d, "_build.py"); Path(builder).write_text(_BUILDER)
        model = os.path.join(d, "rave_fake.ts")
        b = subprocess.run([py, builder, model], capture_output=True, text=True, timeout=180)
        if b.returncode != 0 or not os.path.isfile(model):
            return {"check": name, "pass": False,
                    "detail": {"stage": "build synthetic model", "stderr": b.stderr[-400:]}}
        cls, detail = _run_one_model(ctx, ART, run_script, stats, diff_rms,
                                     failed_commands, model, "synthetic")
        if cls == "binary_lacks_anira":
            return {"check": name, "pass": True,
                    "detail": {"skipped": "binary lacks RAVE insert — build with -DMOSH_ENABLE_ANIRA=ON",
                               **detail}}
        # The synthetic tanh model is loud on ANY input — every non-ok class is a real failure.
        return {"check": name, "pass": cls == "ok",
                "detail": {**detail, "class": cls, "model": "synthetic", "note": synthetic_note}}

    candidates, pinned = _real_model_candidates()
    if not candidates:
        return {"check": name, "pass": True,
                "detail": {"skipped": "no transform venv (service/transform/setup-transform.sh) "
                                      "and no real .ts in the RAVE rack to fall back to"}}

    skipped = []
    tried = candidates if pinned else candidates[:MAX_REAL_CANDIDATES]
    for model in tried:
        base = os.path.basename(model)
        cls, detail = _run_one_model(ctx, ART, run_script, stats, diff_rms,
                                     failed_commands, model, Path(model).stem)
        if cls == "binary_lacks_anira":
            return {"check": name, "pass": True,
                    "detail": {"skipped": "binary lacks RAVE insert — build with -DMOSH_ENABLE_ANIRA=ON",
                               **detail}}
        if cls == "ok":
            return {"check": name, "pass": True,
                    "detail": {**detail, "model": base, "skipped": skipped,
                               "note": "real pretrained RAVE model through anira+LibTorch; "
                                       "skipped entries are model properties (silent-on-tone "
                                       "or unloadable), proven harmless by this model passing"}}
        if not pinned and cls in ("model_silent", "load_failed"):
            skipped.append({"model": base, "reason": cls,
                            "rms": detail.get("rms"), "stderr": detail.get("stderr", "")[-200:]})
            continue
        # Pipeline-shaped failure (gaps / NaN / reset regression / command failure) — or a
        # pinned model that came up dead. Don't mask it by iterating further.
        return {"check": name, "pass": False,
                "detail": {**detail, "class": cls, "model": base, "skipped": skipped}}

    untried = [os.path.basename(m) for m in candidates[len(tried):]]
    return {"check": name, "pass": False,
            "detail": {"class": "no_healthy_candidate",
                       "summary": f"all {len(tried)} tried rack models were silent-on-tone or "
                                  "unloadable — either the insert pipeline is broken or the rack "
                                  "is unlucky; pin a known-responsive model via RAVE_INSERT_MODEL",
                       "skipped": skipped, "untried": untried}}
