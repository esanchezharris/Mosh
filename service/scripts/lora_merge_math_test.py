#!/usr/bin/env python3
"""Golden: the LoRA-rack merge math (service/sa3/lora_runtime.py) vs the
UPSTREAM fixture.

The fixture (service/scripts/golden/lora_dora_fixture.npz, generated once by
scripts/loras/gen_dora_golden.py) contains effective weights computed by the
REAL upstream `LoRAParametrization` (chained dora-rows composition — the code
path the owner's stacking experiments ran). This test proves the pure-numpy
runtime reproduces it exactly (fp32, atol 1e-5), including:

- the s==0 short-circuit (base weights bit-exact, NOT a renormed W)
- strength scaling pre-renorm (s=0.4 vs 1.0 vs 1.5 all distinct)
- CHAINED N-adapter composition, and its ORDER-SENSITIVITY (locks the
  semantics choice: chain(A@1,B@0.7) != chain(B@0.7,A@1))
- an inactive (s=0) adapter mid-chain drops out exactly
- Conv1d handled in the torch 2D domain with the MLX [out,k,in] permute
- rack_signature stability + parse_adapter round-trip

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
from sa3 import lora_runtime as LR  # noqa: E402

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
    return {"A": f[f"ad{i}_{layer}_A"].astype(np.float32),
            "B": f[f"ad{i}_{layer}_B"].astype(np.float32),
            "m": f[f"ad{i}_{layer}_m"].astype(np.float32)}


def chain_lin(strengths, order=None):
    """Chained dora-rows on the Linear base for the given per-adapter strengths."""
    order = order if order is not None else list(range(len(strengths)))
    W = f["base_lin"].astype(np.float32)
    stages = [{"type": "dora-rows", "scaling": SCALING, "strength": strengths[k],
               **ad(order[k], "lin")} for k in range(len(order))]
    return LR.compose_chain(W, stages)


def close(a, b, atol=1e-5):
    return np.allclose(a, b, atol=atol, rtol=0)


# --- solo strengths (incl. s==0 short-circuit + overdrive) --------------------------
for s in (0.0, 0.4, 1.0, 1.5):
    exp = f[f"exp_n1_s{s:g}_lin"]
    got = chain_lin([s], order=[0])
    check(f"n1 linear s={s:g}", close(got, exp),
          f"maxdiff {np.abs(got - exp).max():.2e}")

check("s=0 is BIT-exact base (short-circuit, not renorm)",
      np.array_equal(chain_lin([0.0], order=[0]), f["base_lin"].astype(np.float32)))

# --- stacks ---------------------------------------------------------------------------
got = chain_lin([1.0, 0.7], order=[0, 1])
check("n2 chain (1.0, 0.7)", close(got, f["exp_n2_s10_07_lin"]),
      f"maxdiff {np.abs(got - f['exp_n2_s10_07_lin']).max():.2e}")

got = chain_lin([0.67, 0.67, 0.67], order=[0, 1, 2])
check("n3 chain (0.67 x3)", close(got, f["exp_n3_s067_lin"]))

got = chain_lin([1.0, 1.0, 1.0], order=[0, 1, 2])
check("n3 chain (1.0 x3)", close(got, f["exp_n3_s10_lin"]))

# inactive middle adapter drops out of the chain exactly
got = chain_lin([1.0, 0.0, 0.5], order=[0, 1, 2])
check("n3 chain with s=0 hole", close(got, f["exp_n3_hole_lin"]))

# --- ORDER SENSITIVITY: locks the chained-semantics choice ---------------------------
rev = chain_lin([0.7, 1.0], order=[1, 0])
check("reversed order matches upstream reversed", close(rev, f["exp_n2_rev_lin"]))
fwd = f["exp_n2_s10_07_lin"]
check("order MATTERS (chain(0,1) != chain(1,0))",
      np.abs(rev - fwd).max() > 1e-3, f"maxdiff {np.abs(rev - fwd).max():.4f}")

# --- Conv1d: torch [out,in,k] domain + the MLX [out,k,in] permute ---------------------
base_conv_torch = f["base_conv"].astype(np.float32)          # [out, in, 1]
base_conv_mlx = base_conv_torch.transpose(0, 2, 1)           # [out, 1, in] (MLX layout)
for tag, strengths, order in (("n1_s1", [1.0], [0]),
                              ("n2_s10_07", [1.0, 0.7], [0, 1])):
    exp = f[f"exp_{tag}_conv"].astype(np.float32)            # torch layout
    stages = [{"type": "dora-rows", "scaling": SCALING, "strength": strengths[k],
               **ad(order[k], "conv")} for k in range(len(order))]
    got_mlx = LR.merge_tensor(base_conv_mlx, stages)         # stays MLX layout
    check(f"conv {tag} (MLX layout round-trip)",
          close(got_mlx, exp.transpose(0, 2, 1)),
          f"maxdiff {np.abs(got_mlx - exp.transpose(0, 2, 1)).max():.2e}")

# linear path through merge_tensor too (2D input stays 2D)
got = LR.merge_tensor(f["base_lin"].astype(np.float32),
                      [{"type": "dora-rows", "scaling": SCALING, "strength": 1.0,
                        **ad(0, "lin")}])
check("merge_tensor on 2D == chain", close(got, f["exp_n1_s1_lin"]))

# --- plain 'lora' adapter type (no renorm) --------------------------------------------
a0 = ad(0, "lin")
got = LR.compose_chain(f["base_lin"].astype(np.float32),
                       [{"type": "lora", "scaling": SCALING, "strength": 0.5,
                         "A": a0["A"], "B": a0["B"], "m": None}])
exp = f["base_lin"].astype(np.float32) + SCALING * 0.5 * (a0["B"] @ a0["A"])
check("plain lora = linear delta, no renorm", close(got, exp))

# --- key mapping ----------------------------------------------------------------------
check("map transformer layer",
      LR.mod_to_mlx_key("model.transformer.layers.3.self_attn.q_proj")
      == "transformer.layers.3.self_attn.q_proj.weight")
check("map to_local_embed rename",
      LR.mod_to_mlx_key("model.transformer.to_local_embed.0")
      == "transformer.to_local_embed.seq.0.weight",
      LR.mod_to_mlx_key("model.transformer.to_local_embed.0"))
check("map preprocess_conv",
      LR.mod_to_mlx_key("model.preprocess_conv") == "preprocess_conv.weight")

# --- parse_adapter round-trip on a synthetic numpy-written safetensors ----------------
def write_st(path, tensors, metadata=None):
    header = {}
    if metadata:
        header["__metadata__"] = metadata
    off = 0
    blobs = []
    for name, arr in tensors.items():
        raw = arr.tobytes()
        dt = {"float16": "F16", "float32": "F32"}[str(arr.dtype)]
        header[name] = {"dtype": dt, "shape": list(arr.shape),
                        "data_offsets": [off, off + len(raw)]}
        blobs.append(raw)
        off += len(raw)
    hj = json.dumps(header).encode()
    with open(path, "wb") as fo:
        fo.write(struct.pack("<Q", len(hj)))
        fo.write(hj)
        for b in blobs:
            fo.write(b)


tmp = tempfile.mkdtemp(prefix="lora-math-")
p = os.path.join(tmp, "t.safetensors")
write_st(p, {
    "model.lin.parametrizations.weight.0.lora_A": f["ad0_lin_A"],
    "model.lin.parametrizations.weight.0.lora_B": f["ad0_lin_B"],
    "model.lin.parametrizations.weight.0.magnitude": f["ad0_lin_m"].reshape(-1, 1),  # legacy 2D
}, {"lora_config": json.dumps({"rank": RANK, "alpha": ALPHA, "adapter_type": "dora-rows"})})

pa = LR.parse_adapter(p)
check("parse_adapter scaling", abs(pa["scaling"] - SCALING) < 1e-9, str(pa["scaling"]))
check("parse_adapter type", pa["adapter_type"] == "dora-rows")
t = pa["targets"].get("model.lin", {})
check("parse_adapter A fp32", t.get("A") is not None and t["A"].dtype == np.float32
      and close(t["A"], f["ad0_lin_A"].astype(np.float32)))
check("parse_adapter legacy 2D magnitude squeezed",
      t.get("m") is not None and t["m"].ndim == 1
      and close(t["m"], f["ad0_lin_m"].astype(np.float32)))

# --- rack signature -------------------------------------------------------------------
rack = [{"sha256": "a" * 64, "strength": 0.8}, {"sha256": "b" * 64, "strength": 1.0}]
s1 = LR.rack_signature(rack)
s2 = LR.rack_signature([dict(r) for r in rack])
check("signature stable", s1 == s2 and len(s1) > 0)
check("signature order-sensitive",
      LR.rack_signature(list(reversed(rack))) != s1)
check("signature strength-sensitive",
      LR.rack_signature([{"sha256": "a" * 64, "strength": 0.81},
                         rack[1]]) != s1)
check("empty rack signature distinct", LR.rack_signature([]) != s1)

print(f"\n{len(fails)} failures")
sys.exit(1 if fails else 0)
