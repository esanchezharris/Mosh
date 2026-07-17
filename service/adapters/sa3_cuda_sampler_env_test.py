#!/usr/bin/env python3
"""Golden test: SA3-CUDA sampler tuning is ENGINE-LEVEL env config, not a per-render
param — HERMETIC (the module's top-level imports are torch-free, so this loads with no
GPU / no stable_audio_3). 3× deterministic.

Context (2026-07-17): cfg/steps were retired as RenderLayer render params. On the
canonical MLX path they had NO audible effect (the engine never read a `cfg`/`steps`
param and takes steps from the SA3_STEPS env), yet they sat in the native cache
fingerprint and busted it for zero change. The CUDA adapter DID read them per-render,
so a naive delete would have been a Mac-vs-Windows divergence. Reconciliation: the CUDA
adapter now reads steps/cfg from ENGINE env (MOSH_SA3_STEPS / MOSH_SA3_CFG), defaulting
to its validated 30 steps / cfg 7.0 — symmetric with the MLX engine's SA3_STEPS, and out
of the render-cache key. This test pins that posture.

Run:  python3 service/adapters/sa3_cuda_sampler_env_test.py   (exit 0 = all pass)
"""
import importlib
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))   # service/ on the path for `import adapters.*`

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def _load(env):
    """(Re)import the CUDA adapter under a given env overlay and return the module."""
    saved = {k: os.environ.get(k) for k in ("MOSH_SA3_STEPS", "MOSH_SA3_CFG")}
    try:
        for k in ("MOSH_SA3_STEPS", "MOSH_SA3_CFG"):
            os.environ.pop(k, None)
        os.environ.update(env)
        import adapters.stable_audio3_cuda as m
        return importlib.reload(m)
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


# 1) Defaults preserve this backend's validated values (Windows SA3-CUDA selftest config).
m = _load({})
check("default STEPS is 30", m.STEPS == 30, f"got {m.STEPS!r}")
check("default CFG_SCALE is 7.0", m.CFG_SCALE == 7.0, f"got {m.CFG_SCALE!r}")

# 2) The env drives them (engine-level tuning knob, like the MLX engine's SA3_STEPS).
m = _load({"MOSH_SA3_STEPS": "12", "MOSH_SA3_CFG": "3.0"})
check("MOSH_SA3_STEPS overrides steps", m.STEPS == 12, f"got {m.STEPS!r}")
check("MOSH_SA3_CFG overrides cfg", m.CFG_SCALE == 3.0, f"got {m.CFG_SCALE!r}")

# 3) render() must NOT read cfg/steps from the per-render params dict — that is the
#    divergence we removed. Static source guard (no GPU needed to assert this).
with open(os.path.join(HERE, "stable_audio3_cuda.py"), "r", encoding="utf-8") as f:
    src = f.read()
check("render no longer reads params.get(\"steps\")", 'params.get("steps"' not in src)
check("render no longer reads params.get(\"cfg\")", 'params.get("cfg"' not in src)

# Restore a clean default import so the module cache isn't left env-skewed for any
# later import in the same interpreter.
_load({})

if fails:
    print(f"\n{len(fails)} FAILED: {', '.join(fails)}")
    sys.exit(1)
print("\nall passed")
sys.exit(0)
