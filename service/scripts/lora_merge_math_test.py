#!/usr/bin/env python3
"""Golden: the LoRA apply math (service/sa3/lora_merge.py) vs the UPSTREAM fixture.

The fixture (service/scripts/golden/lora_dora_fixture.npz, generated once by
scripts/loras/gen_dora_golden.py) contains effective weights computed by the
REAL upstream `LoRAParametrization` (chained dora-rows composition — the code
path the owner's stacking experiments ran). This test pins lora_merge's
`apply_dora` / `weights_for_selection` to it, including:

- solo strengths 0.4 / 1.0 / 1.5 (overdrive) exact in f32 (atol 1e-5)
- CHAINED N-adapter composition, and its ORDER-SENSITIVITY (locks the
  semantics choice: chain(A@1,B@0.7) != chain(B@0.7,A@1))
- the s==0 contract: apply_dora has NO short-circuit (a 0-strength stage
  renorms the base — WRONG vs upstream), so the registry MUST filter 0 rows
  before the math. Both halves are asserted here: the hole case equals the
  upstream fixture when the 0 row is dropped, and the unfiltered stage
  provably diverges (the guard is load-bearing).
- Conv1d handled through the torch 2D domain with the npz [out,1,in] reshape
- the full weights_for_selection pipeline (real safetensors files + an f16
  base, f16 rounding BETWEEN stacked stages — the runtime's exact carry)
  stays within 2e-3 relative of the upstream fixture (measured ~4e-4)

Hermetic: numpy only — no torch, no mlx, no model weights.
"""
import json
import os
import struct
import sys
import tempfile

import numpy as np

SERVICE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, SERVICE)
from sa3 import lora_merge as LM  # noqa: E402

FIX = os.path.join(SERVICE, "scripts", "golden", "lora_dora_fixture.npz")

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


f = np.load(FIX)
RANK = int(f["meta_rank"])
ALPHA = int(f["meta_alpha"])
SCALING = ALPHA / RANK


def ad(i, layer):
    return (f[f"ad{i}_{layer}_A"].astype(np.float32),
            f[f"ad{i}_{layer}_B"].astype(np.float32),
            f[f"ad{i}_{layer}_m"].astype(np.float32))


def chain(layer, specs, carry_f16=False):
    """apply_dora chained over the fixture base. specs = [(adapter_idx, strength)].
    carry_f16 mimics the runtime's between-stage rounding to the stored dtype."""
    W = f[f"base_{layer}"].astype(np.float32)
    if layer == "conv":                       # torch [out,in,1] -> 2D [out,in]
        W = W.reshape(W.shape[0], -1)
    for i, s in specs:
        A, B, m = ad(i, layer)
        W = LM.apply_dora(np, W, A, B, m, "dora-rows", SCALING, s)
        if carry_f16:
            W = W.astype(np.float16).astype(np.float32)
    return W


def exp(key, layer):
    E = f[key].astype(np.float32)
    return E.reshape(E.shape[0], -1) if layer == "conv" else E


def close(a, b, atol=1e-5):
    return np.allclose(a, b, atol=atol, rtol=0)


# --- solo strengths (f32-exact vs upstream, incl. overdrive s=1.5) --------------------
for s in (0.4, 1.0, 1.5):
    E = exp(f"exp_n1_s{s:g}_lin", "lin")
    got = chain("lin", [(0, s)])
    check(f"n1 linear s={s:g}", close(got, E), f"maxdiff {np.abs(got - E).max():.2e}")

# a DIFFERENT adapter at s=1 (guards against accidental adapter-index mixups)
E = exp("exp_n1b_s1_lin", "lin")
got = chain("lin", [(1, 1.0)])
check("n1b linear (adapter 1)", close(got, E), f"maxdiff {np.abs(got - E).max():.2e}")

# --- stacks (chained composition, f32-exact) -------------------------------------------
got = chain("lin", [(0, 1.0), (1, 0.7)])
check("n2 chain (1.0, 0.7)", close(got, exp("exp_n2_s10_07_lin", "lin")))

got = chain("lin", [(0, 0.67), (1, 0.67), (2, 0.67)])
check("n3 chain (0.67 x3)", close(got, exp("exp_n3_s067_lin", "lin")))

got = chain("lin", [(0, 1.0), (1, 1.0), (2, 1.0)])
check("n3 chain (1.0 x3)", close(got, exp("exp_n3_s10_lin", "lin")))

# --- the s==0 contract ------------------------------------------------------------------
# Upstream short-circuits s==0 to the base; lora_merge.apply_dora does NOT — the
# registry filters 0 rows first. (1) with the 0 row DROPPED the chain matches the
# upstream hole fixture; (2) an UNfiltered 0-strength stage diverges from the base
# (proves the registry filter is load-bearing, not redundant).
got = chain("lin", [(0, 1.0), (2, 0.5)])                       # hole: middle row dropped
check("n3 hole == chain with the 0 row filtered", close(got, exp("exp_n3_hole_lin", "lin")))
z = LM.apply_dora(np, f["base_lin"].astype(np.float32), *ad(0, "lin"),
                  "dora-rows", SCALING, 0.0)
check("unfiltered s=0 stage DIVERGES from base (registry filter is load-bearing)",
      float(np.abs(z - f["base_lin"].astype(np.float32)).max()) > 1e-2,
      f"maxdiff {np.abs(z - f['base_lin'].astype(np.float32)).max():.3f}")

# --- ORDER SENSITIVITY: locks the chained-semantics choice ----------------------------
rev = chain("lin", [(1, 0.7), (0, 1.0)])
check("reversed order matches upstream reversed", close(rev, exp("exp_n2_rev_lin", "lin")))
fwd = exp("exp_n2_s10_07_lin", "lin")
check("order MATTERS (chain(0,1) != chain(1,0))",
      float(np.abs(rev - fwd).max()) > 1e-3, f"maxdiff {np.abs(rev - fwd).max():.4f}")

# --- Conv1d: the torch 2D domain (npz stores 1x1 convs [out,1,in]) ---------------------
for tag, specs in (("n1_s1", [(0, 1.0)]), ("n2_s10_07", [(0, 1.0), (1, 0.7)])):
    E = exp(f"exp_{tag}_conv", "conv")
    got = chain("conv", specs)
    check(f"conv {tag} (2D domain)", close(got, E),
          f"maxdiff {np.abs(got - E).max():.2e}")

# --- the FULL runtime pipeline: weights_for_selection over real safetensors -----------
# f16 base + f16 rounding between stacked stages (exactly what apply_loras computes on
# the GPU) must stay within 2e-3 relative of the upstream f32 fixture (measured ~4e-4).
def write_safetensors(path, tensors, metadata=None):
    header = {}
    if metadata:
        header["__metadata__"] = metadata
    offset = 0
    blobs = []
    for name, arr in tensors.items():
        raw = arr.astype(np.float16).tobytes()
        header[name] = {"dtype": "F16", "shape": list(arr.shape),
                        "data_offsets": [offset, offset + len(raw)]}
        blobs.append(raw)
        offset += len(raw)
    hj = json.dumps(header).encode("utf-8")
    with open(path, "wb") as fo:
        fo.write(struct.pack("<Q", len(hj)))
        fo.write(hj)
        for b in blobs:
            fo.write(b)


tmp = tempfile.mkdtemp(prefix="lora-merge-test-")
try:
    paths = []
    for i in range(2):
        A, B, m = ad(i, "lin")
        cA, cB, cm = ad(i, "conv")
        p = os.path.join(tmp, f"ad{i}.safetensors")
        write_safetensors(p, {
            "model.lin.parametrizations.weight.0.lora_A": A,
            "model.lin.parametrizations.weight.0.lora_B": B,
            "model.lin.parametrizations.weight.0.magnitude": m,
            "model.conv.parametrizations.weight.0.lora_A": cA,
            "model.conv.parametrizations.weight.0.lora_B": cB,
            "model.conv.parametrizations.weight.0.magnitude": cm,
        }, {"lora_config": json.dumps({"rank": RANK, "alpha": ALPHA,
                                       "adapter_type": "dora-rows"})})
        paths.append(p)

    base_lin16 = f["base_lin"].astype(np.float16)
    base_conv16 = f["base_conv"].astype(np.float32).transpose(0, 2, 1).astype(np.float16)  # npz [out,1,in]
    bases = {"lin.weight": base_lin16, "conv.weight": base_conv16}

    sel = [("ad0", paths[0], 1.0), ("ad1", paths[1], 0.7)]
    updated, report = LM.weights_for_selection(sel, lambda k: bases.get(k))
    check("pipeline applied both layers x both adapters", report["applied"] == 4,
          str(report))
    check("pipeline skipped nothing", report["skipped"] == [], str(report["skipped"]))

    E = exp("exp_n2_s10_07_lin", "lin")
    got = updated["lin.weight"].astype(np.float32)
    rel = float(np.abs(got - E).max()) / (float(np.abs(E).max()) + 1e-12)
    check("pipeline linear within 2e-3 rel of upstream (f16 carry)", rel < 2e-3,
          f"rel {rel:.2e}")
    check("pipeline keeps stored dtype", updated["lin.weight"].dtype == np.float16)

    Ec = f["exp_n2_s10_07_conv"].astype(np.float32).transpose(0, 2, 1)   # npz layout
    gotc = updated["conv.weight"].astype(np.float32)
    check("pipeline conv keeps npz [out,1,in] shape", gotc.shape == Ec.shape,
          f"{gotc.shape} vs {Ec.shape}")
    relc = float(np.abs(gotc - Ec).max()) / (float(np.abs(Ec).max()) + 1e-12)
    check("pipeline conv within 2e-3 rel of upstream", relc < 2e-3, f"rel {relc:.2e}")
finally:
    import shutil
    shutil.rmtree(tmp, ignore_errors=True)

print(f"\n{len(fails)} failures")
sys.exit(1 if fails else 0)
