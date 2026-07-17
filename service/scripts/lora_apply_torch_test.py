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

    module_level(rng, t)

    print(f"lora_apply_torch_test OK ({CHECKS} checks, torch {torch.__version__})")


def module_level(rng, t):
    """Drive the CUDA adapter's _compute_updated_torch/_apply_loras_cuda/
    _restore_base_cuda on a tiny nn.Module against the weights_for_selection
    disk-merge oracle (FIT-013: runtime apply == disk bake)."""
    import json
    import tempfile

    import torch.nn as nn

    from adapters import stable_audio3_cuda as cuda
    from lora_merge_test import write_safetensors

    OUT, IN, RANK = 4, 3, 2

    class NS(nn.Module):
        def __init__(self, **kids):
            super().__init__()
            for k, v in kids.items():
                setattr(self, k, v)

    lin = nn.Linear(IN, OUT, bias=False).to(torch.float16)
    conv = nn.Conv1d(IN, OUT, 1, bias=False).to(torch.float16)     # weight [out, in, 1]
    emb = nn.Linear(IN, OUT, bias=False).to(torch.float16)
    root = NS(
        transformer=NS(layers=nn.ModuleList(
            [NS(self_attn=NS(to_qkv=lin), to_local_embed=nn.ModuleList([emb]))])),
        preprocess_conv=conv,
    )
    sm = NS(model=NS(model=NS(model=root)))    # serving wrapper shape
    base = {n: p.data.detach().clone() for n, p in root.named_parameters()}

    def mk_parts():
        return (rng.normal(size=(RANK, IN)).astype(np.float32),
                rng.normal(size=(OUT, RANK)).astype(np.float32),
                (np.abs(rng.normal(size=(OUT,))) + 0.5).astype(np.float32))

    A1, B1, M1 = mk_parts()
    A2, B2, M2 = mk_parts()
    tmp = tempfile.mkdtemp(prefix="lora-apply-torch-")
    meta = {"lora_config": json.dumps({"rank": RANK, "alpha": RANK,
                                       "adapter_type": "dora-rows"})}
    l1 = os.path.join(tmp, "l1.safetensors")
    write_safetensors(l1, {
        "model.transformer.layers.0.self_attn.to_qkv.parametrizations.weight.0.lora_A": A1,
        "model.transformer.layers.0.self_attn.to_qkv.parametrizations.weight.0.lora_B": B1,
        "model.transformer.layers.0.self_attn.to_qkv.parametrizations.weight.0.magnitude": M1,
        "model.preprocess_conv.parametrizations.weight.0.lora_A": A1,
        "model.preprocess_conv.parametrizations.weight.0.lora_B": B1,
        "model.preprocess_conv.parametrizations.weight.0.magnitude": M1,
        "model.transformer.layers.0.to_local_embed.0.parametrizations.weight.0.lora_A": A1,
        "model.transformer.layers.0.to_local_embed.0.parametrizations.weight.0.lora_B": B1,
        "model.transformer.layers.0.to_local_embed.0.parametrizations.weight.0.magnitude": M1,
        "conditioners.seconds_total.embedder.embedding.1.parametrizations.weight.0.lora_A": A1,
        "conditioners.seconds_total.embedder.embedding.1.parametrizations.weight.0.lora_B": B1,
        "conditioners.seconds_total.embedder.embedding.1.parametrizations.weight.0.magnitude": M1,
    }, meta)
    l2 = os.path.join(tmp, "l2.safetensors")
    write_safetensors(l2, {
        "model.transformer.layers.0.self_attn.to_qkv.parametrizations.weight.0.lora_A": A2,
        "model.transformer.layers.0.self_attn.to_qkv.parametrizations.weight.0.lora_B": B2,
        "model.transformer.layers.0.self_attn.to_qkv.parametrizations.weight.0.magnitude": M2,
    }, meta)

    # oracle: weights_for_selection over the SAME base weights in npz layout
    # (conv [out,1,in] vs torch's [out,in,1]; to_local_embed.seq.<n> rename)
    npz_of = {
        "transformer.layers.0.self_attn.to_qkv.weight":
            base["transformer.layers.0.self_attn.to_qkv.weight"].numpy(),
        "preprocess_conv.weight":
            base["preprocess_conv.weight"].numpy().transpose(0, 2, 1),
        "transformer.layers.0.to_local_embed.seq.0.weight":
            base["transformer.layers.0.to_local_embed.0.weight"].numpy(),
    }
    sel = [("l1", l1, 0.6), ("l2", l2, 0.25)]
    oracle, oracle_rep = LM.weights_for_selection(sel, lambda k: npz_of.get(k))

    # roots resolve through the wrapper; apply matches the oracle per param
    roots = cuda._lora_roots(sm)
    check(roots and roots[0] is root, f"_lora_roots missed the DiT root: {roots}")
    rep = cuda._apply_loras_cuda(sm, sel, cuda._loras_key(sel))
    check(rep["applied"] == oracle_rep["applied"] == 4,
          f"applied count: {rep} vs oracle {oracle_rep}")
    check(rep["skipped"] == oracle_rep["skipped"],
          f"skip parity: {rep['skipped']} vs {oracle_rep['skipped']}")
    got_lin = root.get_parameter("transformer.layers.0.self_attn.to_qkv.weight")
    check(np.allclose(got_lin.data.to(torch.float32).numpy(),
                      oracle["transformer.layers.0.self_attn.to_qkv.weight"]
                      .astype(np.float32), atol=1e-3),
          "stacked torch apply != disk-merge oracle (linear)")
    got_conv = root.get_parameter("preprocess_conv.weight")
    check(np.allclose(got_conv.data.to(torch.float32).numpy().transpose(0, 2, 1),
                      oracle["preprocess_conv.weight"].astype(np.float32), atol=1e-3),
          "conv layout apply != oracle")
    got_emb = root.get_parameter("transformer.layers.0.to_local_embed.0.weight")
    check(np.allclose(got_emb.data.to(torch.float32).numpy(),
                      oracle["transformer.layers.0.to_local_embed.seq.0.weight"]
                      .astype(np.float32), atol=1e-3),
          "to_local_embed raw-name resolution != oracle (MLX seq-rename divergence)")

    # idempotence on the key
    rep2 = cuda._apply_loras_cuda(sm, sel, cuda._loras_key(sel))
    check(rep2.get("reused") is True, "repeat key not reused")
    check(torch.equal(got_lin.data,
                      root.get_parameter("transformer.layers.0.self_attn.to_qkv.weight").data),
          "repeat key touched weights")

    # different strength -> different weights (restore-then-apply from pristine)
    snap = got_lin.data.detach().clone()
    sel_b = [("l1", l1, 0.2)]
    cuda._apply_loras_cuda(sm, sel_b, cuda._loras_key(sel_b))
    check(not torch.equal(
        root.get_parameter("transformer.layers.0.self_attn.to_qkv.weight").data, snap),
        "strength change had no effect at module level")

    # empty selection == stock restore, bit-clean
    cuda._apply_loras_cuda(sm, [], "")
    for n, b in base.items():
        check(torch.equal(root.get_parameter(n).data, b), f"restore not bit-clean: {n}")
    check(cuda._LORA_APPLIED_KEY == "", "stock key not recorded")

    # cpu stash escape hatch round-trips too
    os.environ["MOSH_SA3_LORA_STASH"] = "cpu"
    try:
        cuda._reset_lora_state()
        cuda._apply_loras_cuda(sm, sel, "again")
        cuda._apply_loras_cuda(sm, [], "")
        for n, b in base.items():
            check(torch.equal(root.get_parameter(n).data, b), f"cpu-stash restore: {n}")
    finally:
        os.environ.pop("MOSH_SA3_LORA_STASH", None)
        cuda._reset_lora_state()


if __name__ == "__main__":
    main()
