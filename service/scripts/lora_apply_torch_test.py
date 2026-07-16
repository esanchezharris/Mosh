"""Torch-backend test for service/sa3/lora_merge.py::apply_dora — FIT-013.

Pins the xp-shim (torch lacks .astype; keepdims= is a fragile numpy alias) against
the numpy path: same math, same order, allclose to 1e-5. Hermetic (synthetic
tensors); SKIPs cleanly when torch isn't importable so the gate stays green on
hosts without a torch venv (CI, stock Mac python).

Run:  python3 service/scripts/lora_apply_torch_test.py
"""
from __future__ import annotations

import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, ".."))
sys.path.insert(0, _HERE)

try:
    import torch
except Exception:
    print("[SKIP] torch not importable — lora_apply_torch_test needs a torch venv")
    sys.exit(0)

from sa3 import lora_merge as LM  # noqa: E402
from lora_merge_test import dora_reference  # noqa: E402

CHECKS = 0


def check(cond, msg):
    global CHECKS
    CHECKS += 1
    if not cond:
        print(f"FAIL: {msg}")
        sys.exit(1)


def main():
    rng = np.random.default_rng(11)
    OUT, IN, RANK = 6, 5, 2
    W = rng.normal(size=(OUT, IN)).astype(np.float32)
    A = rng.normal(size=(RANK, IN)).astype(np.float32)
    B = rng.normal(size=(OUT, RANK)).astype(np.float32)
    M = (np.abs(rng.normal(size=(OUT,))) + 0.5).astype(np.float32)
    t = lambda a: torch.from_numpy(np.ascontiguousarray(a))  # noqa: E731

    # 1) dora-rows: torch == numpy == float64 reference
    got_np = LM.apply_dora(np, W, A, B, M, "dora-rows", 1.0, 0.6)
    got_t = LM.apply_dora(torch, t(W), t(A), t(B), t(M), "dora-rows", 1.0, 0.6)
    ref = dora_reference(W, A, B, M, 1.0, 0.6)
    check(np.allclose(got_np, ref, atol=1e-5), "numpy dora-rows drifted from reference")
    check(got_t.dtype == torch.float32, "torch result not float32")
    check(np.allclose(got_t.numpy(), got_np, atol=1e-5),
          f"torch dora-rows != numpy (max {np.abs(got_t.numpy() - got_np).max()})")

    # 2) plain lora (no magnitude / no normalize branch)
    got_np_l = LM.apply_dora(np, W, A, B, None, "lora", 1.0, 0.6)
    got_t_l = LM.apply_dora(torch, t(W), t(A), t(B), None, "lora", 1.0, 0.6)
    check(np.allclose(got_t_l.numpy(), got_np_l, atol=1e-5), "torch lora != numpy")

    # 3) torch Conv1d 1x1 layout [out, in, 1]: slice to 2D, apply, matches numpy on
    #    the equivalent 2D weight (the CUDA apply path's conv branch).
    W_conv_t = t(W).unsqueeze(-1)                       # [out, in, 1]
    got_t_c = LM.apply_dora(torch, W_conv_t[:, :, 0], t(A), t(B), t(M),
                            "dora-rows", 1.0, 0.6)
    check(np.allclose(got_t_c.numpy(), got_np, atol=1e-5), "conv-sliced torch != numpy")

    # 4) f16 input weights (the stored dtype on both backends) round through the
    #    shim's .to(float32) branch identically to numpy's .astype
    W16 = W.astype(np.float16)
    got_np16 = LM.apply_dora(np, W16, A, B, M, "dora-rows", 1.0, 0.6)
    got_t16 = LM.apply_dora(torch, t(W16), t(A), t(B), t(M), "dora-rows", 1.0, 0.6)
    check(np.allclose(got_t16.numpy(), got_np16, atol=1e-5), "f16-input torch != numpy")

    # 5) stacked two-LoRA apply with stored-dtype (f16) cast between — torch
    #    sequential apply matches the weights_for_selection semantics numpy-side
    A2 = rng.normal(size=(RANK, IN)).astype(np.float32)
    B2 = rng.normal(size=(OUT, RANK)).astype(np.float32)
    M2 = (np.abs(rng.normal(size=(OUT,))) + 0.5).astype(np.float32)
    n1 = LM.apply_dora(np, W16, A, B, M, "dora-rows", 1.0, 0.6).astype(np.float16)
    n2 = LM.apply_dora(np, n1, A2, B2, M2, "dora-rows", 1.0, 0.4).astype(np.float16)
    t1 = LM.apply_dora(torch, t(W16), t(A), t(B), t(M), "dora-rows", 1.0, 0.6).to(torch.float16)
    t2 = LM.apply_dora(torch, t1, t(A2), t(B2), t(M2), "dora-rows", 1.0, 0.4).to(torch.float16)
    check(np.allclose(t2.numpy().astype(np.float32), n2.astype(np.float32), atol=2e-3),
          "stacked f16 torch apply != numpy stack")

    # 6) strength scales through the torch branch (guards accidental constant-fold)
    got_t_08 = LM.apply_dora(torch, t(W), t(A), t(B), t(M), "dora-rows", 1.0, 0.8)
    check(not np.allclose(got_t_08.numpy(), got_t.numpy()), "strength had no effect (torch)")

    print(f"lora_apply_torch_test OK ({CHECKS} checks, torch {torch.__version__})")


if __name__ == "__main__":
    main()
