#!/usr/bin/env python3
"""Generate the DoRA golden fixture for the LoRA-rack merge math.

Dev-only, run ONCE on a Mac with a torch venv + the upstream stable-audio-3
repo checked out. It executes the REAL upstream ``LoRAParametrization``
(chained composition — the exact code path the owner's stacking experiments
ran via ``load_and_apply_loras`` + ``set_lora_strength``) on a tiny seeded
synthetic model, and pins the resulting effective weights to
``service/scripts/golden/lora_dora_fixture.npz``.

Every later merge-math test (``service/scripts/lora_merge_math_test.py``)
compares the pure-numpy runtime against this fixture — hermetic, torch-free.

Usage (transform venv has torch; upstream repo at ~/AI/stable-audio-3):
  ~/Library/Mosh/venvs/transform/bin/python scripts/loras/gen_dora_golden.py

The upstream package's __init__ pulls heavy deps (tqdm, einops, ...), so the
lora module is loaded via package stubs — only torch + the module itself run.
"""
import importlib.util
import os
import sys
import types

import numpy as np

UPSTREAM = os.path.expanduser(os.environ.get("SA3_TORCH_DIR", "~/AI/stable-audio-3"))
OUT = os.path.join(os.path.dirname(__file__), "..", "..",
                   "service", "scripts", "golden", "lora_dora_fixture.npz")

RANK = 2
ALPHA = 3            # scaling = alpha/rank = 1.5 — deliberately != 1 to catch scaling bugs
OUT_F, IN_F = 8, 6   # tiny layer dims
N_ADAPTERS = 3
STRENGTHS_SOLO = [0.0, 0.4, 1.0, 1.5]


def _load_upstream_lora():
    """Import stable_audio_3.models.lora.model without executing the package
    __init__ (which needs tqdm/einops/etc.)."""
    root = os.path.join(UPSTREAM, "stable_audio_3")

    pkg = types.ModuleType("stable_audio_3")
    pkg.__path__ = [root]
    sys.modules["stable_audio_3"] = pkg

    spec = importlib.util.spec_from_file_location(
        "stable_audio_3.verbose", os.path.join(root, "verbose.py"))
    verbose = importlib.util.module_from_spec(spec)
    sys.modules["stable_audio_3.verbose"] = verbose
    spec.loader.exec_module(verbose)

    for sub, path in (("stable_audio_3.models", os.path.join(root, "models")),
                      ("stable_audio_3.models.lora", os.path.join(root, "models", "lora"))):
        m = types.ModuleType(sub)
        m.__path__ = [path]
        sys.modules[sub] = m

    spec = importlib.util.spec_from_file_location(
        "stable_audio_3.models.lora.model",
        os.path.join(root, "models", "lora", "model.py"))
    mod = importlib.util.module_from_spec(spec)
    sys.modules["stable_audio_3.models.lora.model"] = mod
    spec.loader.exec_module(mod)
    return mod


def main():
    import torch
    from functools import partial

    lora_mod = _load_upstream_lora()
    LoRAParametrization = lora_mod.LoRAParametrization
    add_lora = lora_mod.add_lora
    set_lora_strength = lora_mod.set_lora_strength

    torch.manual_seed(0)
    rng = np.random.default_rng(0)

    # Tiny model: one Linear + one k=1 Conv1d (the two layer types the real
    # adapters target; the DiT convs are all kernel-size 1).
    model = torch.nn.Module()
    model.lin = torch.nn.Linear(IN_F, OUT_F, bias=False)
    model.conv = torch.nn.Conv1d(IN_F, OUT_F, kernel_size=1, bias=False)
    with torch.no_grad():
        model.lin.weight.copy_(torch.from_numpy(
            rng.standard_normal((OUT_F, IN_F)).astype(np.float32)))
        model.conv.weight.copy_(torch.from_numpy(
            rng.standard_normal((OUT_F, IN_F, 1)).astype(np.float32)))

    fixture = {
        "meta_rank": np.array(RANK),
        "meta_alpha": np.array(ALPHA),
        "base_lin": model.lin.weight.detach().numpy().copy(),
        "base_conv": model.conv.weight.detach().numpy().copy(),
    }

    # Synthetic "trained" adapters: seeded nonzero A/B/magnitude, stored fp16
    # (the on-disk precision of real adapter files) then upcast — mirrors
    # load_lora_checkpoint → fp32 params.
    adapters = []
    for i in range(N_ADAPTERS):
        a = {}
        for layer in ("lin", "conv"):
            a[layer] = {
                "A": (rng.standard_normal((RANK, IN_F)) * 0.3).astype(np.float16),
                "B": (rng.standard_normal((OUT_F, RANK)) * 0.3).astype(np.float16),
                "m": (np.abs(rng.standard_normal(OUT_F)) + 0.5).astype(np.float16),
            }
            fixture[f"ad{i}_{layer}_A"] = a[layer]["A"]
            fixture[f"ad{i}_{layer}_B"] = a[layer]["B"]
            fixture[f"ad{i}_{layer}_m"] = a[layer]["m"]
        adapters.append(a)

    # Register adapters 0..N-1 in order (chained composition, lora_index=i) —
    # identical to loader.load_and_apply_loras.
    for i in range(N_ADAPTERS):
        cfg = {
            torch.nn.Linear: {"weight": partial(
                LoRAParametrization.from_linear, rank=RANK, lora_alpha=ALPHA,
                adapter_type="dora-rows", lora_index=i)},
            torch.nn.Conv1d: {"weight": partial(
                LoRAParametrization.from_conv1d, rank=RANK, lora_alpha=ALPHA,
                adapter_type="dora-rows", lora_index=i)},
        }
        add_lora(model, cfg)
        with torch.no_grad():
            for layer_name in ("lin", "conv"):
                layer = getattr(model, layer_name)
                p = layer.parametrizations.weight[i]
                a = adapters[i][layer_name]
                p.lora_A.copy_(torch.from_numpy(a["A"].astype(np.float32)))
                p.lora_B.copy_(torch.from_numpy(a["B"].astype(np.float32)))
                p.magnitude.copy_(torch.from_numpy(a["m"].astype(np.float32)))

    def snapshot(tag, strengths):
        """Set per-index strengths, record effective weights."""
        for i in range(N_ADAPTERS):
            set_lora_strength(model, strengths[i] if i < len(strengths) else 0.0,
                              lora_index=i)
        with torch.no_grad():
            fixture[f"exp_{tag}_lin"] = model.lin.weight.detach().numpy().copy()
            fixture[f"exp_{tag}_conv"] = model.conv.weight.detach().numpy().copy()

    # Solo adapter 0 across the strength grid (incl. the s==0 short-circuit
    # and s>1 overdrive).
    for s in STRENGTHS_SOLO:
        snapshot(f"n1_s{s:g}", [s])

    # Solo adapter 1 (used by the order-sensitivity check).
    snapshot("n1b_s1", [0.0, 1.0])

    # Stacks. NOTE: chained order here is registration order (0,1,2) — the
    # strengths vector picks which are active.
    snapshot("n2_s10_07", [1.0, 0.7])
    snapshot("n3_s067", [0.67, 0.67, 0.67])
    snapshot("n3_s10", [1.0, 1.0, 1.0])
    # Inactive middle adapter (s=0 short-circuit inside a chain).
    snapshot("n3_hole", [1.0, 0.0, 0.5])

    os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
    np.savez(os.path.abspath(OUT), **fixture)
    print(f"WROTE {os.path.abspath(OUT)} ({len(fixture)} arrays)")

    # Order-sensitivity witness (chain(0,1) vs chain(1,0)) — computed on a
    # FRESH model with reversed registration, stored for the test to assert
    # order matters (locks the chained-semantics choice).
    torch.manual_seed(0)
    model2 = torch.nn.Module()
    model2.lin = torch.nn.Linear(IN_F, OUT_F, bias=False)
    model2.conv = torch.nn.Conv1d(IN_F, OUT_F, kernel_size=1, bias=False)
    with torch.no_grad():
        model2.lin.weight.copy_(torch.from_numpy(fixture["base_lin"]))
        model2.conv.weight.copy_(torch.from_numpy(fixture["base_conv"]))
    for j, i in enumerate((1, 0)):   # adapter 1 first, then adapter 0
        cfg = {
            torch.nn.Linear: {"weight": partial(
                LoRAParametrization.from_linear, rank=RANK, lora_alpha=ALPHA,
                adapter_type="dora-rows", lora_index=j)},
            torch.nn.Conv1d: {"weight": partial(
                LoRAParametrization.from_conv1d, rank=RANK, lora_alpha=ALPHA,
                adapter_type="dora-rows", lora_index=j)},
        }
        add_lora(model2, cfg)
        with torch.no_grad():
            for layer_name in ("lin", "conv"):
                p = getattr(model2, layer_name).parametrizations.weight[j]
                a = adapters[i][layer_name]
                p.lora_A.copy_(torch.from_numpy(a["A"].astype(np.float32)))
                p.lora_B.copy_(torch.from_numpy(a["B"].astype(np.float32)))
                p.magnitude.copy_(torch.from_numpy(a["m"].astype(np.float32)))
    set_lora_strength(model2, 0.7, lora_index=0)   # adapter 1 @ 0.7 (first)
    set_lora_strength(model2, 1.0, lora_index=1)   # adapter 0 @ 1.0 (second)
    with torch.no_grad():
        fixture["exp_n2_rev_lin"] = model2.lin.weight.detach().numpy().copy()
        fixture["exp_n2_rev_conv"] = model2.conv.weight.detach().numpy().copy()
    np.savez(os.path.abspath(OUT), **fixture)
    print(f"REWROTE with order-witness ({len(fixture)} arrays)")


if __name__ == "__main__":
    main()
