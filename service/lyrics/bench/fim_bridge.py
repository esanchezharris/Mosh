#!/usr/bin/env python3
"""The CUDA↔MLX LoRA bridge (I4 sweeps lane). numpy + safetensors only — the
dequantizer must run on a Linux/CUDA box where MLX does not exist, and this Mac
lacks the disk for a 28GB bf16 export, so NOTHING here may import mlx.

Three pieces:

  * `dequantize_checkpoint` — MLX affine-int4 → full-precision HF checkpoint.
    The packing was verified against `mx.dequantize` ground truth before this
    was written (8 nibbles per uint32, LITTLE-endian nibble order,
    `w = q*scale + bias` per group; max err 1.2e-7 == fp32 epsilon). The
    CUDA-side LoRA then trains against the SAME function MLX serves — closing
    the quantization-grid and activation-precision mismatches that make naive
    cross-stack adapters lossy (the r5 fuse measured ~17% delta kept).
  * `peft_to_mlx_adapter` — PEFT adapter → mlx_lm adapter. Exact conventions:
    MLX `y += scale·(x@lora_a)@lora_b` with lora_a (in,r);
    PEFT `y += (alpha/r)·(x@A^T)@B^T` with A (r,in). So lora_a = A^T,
    lora_b = B^T, scale = alpha/r — asserted, never assumed.
  * `cuda_recipe` — the training recipe exported FROM an MLX adapter config so
    the CUDA sweep can never drift from what serve expects.

Ground-truth smoke (`LYRICS_BENCH_MLX_SMOKE=1`, this Mac only) re-verifies the
unpacking against mx.quantize/mx.dequantize on random matrices.
"""
from __future__ import annotations

import glob
import json
import os
import shutil
from typing import Dict, List, Optional

import numpy as np

BRIDGE_VERSION = "v1"

# The seven projections mlx_lm's default LoRA touches, in HF/PEFT naming.
LORA_MODULES = ("q_proj", "k_proj", "v_proj", "o_proj",
                "gate_proj", "up_proj", "down_proj")


# ── dequantization ───────────────────────────────────────────────────────────────

def unpack_q4(q: np.ndarray) -> np.ndarray:
    """uint32-packed 4-bit → int nibbles, LITTLE-endian nibble order.

    Verified against mx.dequantize before use; the sabotage that flips the
    nibble order is caught by the hand-computed fixture, not by luck."""
    out = np.zeros((*q.shape[:-1], q.shape[-1] * 8), dtype=np.int64)
    for i in range(8):
        out[..., i::8] = (q >> (4 * i)) & 0xF
    return out


def dequantize_tensor(q: np.ndarray, scales: np.ndarray, biases: np.ndarray,
                      group_size: int = 64) -> np.ndarray:
    nib = unpack_q4(q).astype(np.float32)
    g = nib.reshape(*nib.shape[:-1], -1, group_size)
    w = g * scales[..., None].astype(np.float32) \
        + biases[..., None].astype(np.float32)
    return w.reshape(*nib.shape)


def dequantize_checkpoint(in_dir: str, out_dir: str,
                          dtype: str = "bfloat16") -> Dict:
    """MLX 4-bit checkpoint dir → full-precision HF-loadable dir.

    Weight names in mlx_lm checkpoints already follow HF conventions; the
    quantized triples (`X.weight` uint32 + `X.scales` + `X.biases`) collapse to
    one full `X.weight`, everything else passes through. config.json loses its
    `quantization` block. bfloat16 needs `ml_dtypes` (in the runbook's pip
    line); without it we fall back to float32 — bigger on disk, never wrong.
    """
    from safetensors.numpy import load_file, save_file

    os.makedirs(out_dir, exist_ok=True)
    cfg = json.load(open(os.path.join(in_dir, "config.json"), encoding="utf-8"))
    quant = cfg.pop("quantization", None) or {}
    cfg.pop("quantization_config", None)
    group = int(quant.get("group_size", 64))
    if int(quant.get("bits", 4)) != 4:
        raise ValueError(f"bridge handles 4-bit only, got {quant.get('bits')}")

    if dtype == "bfloat16":
        try:
            import ml_dtypes
            np_dtype = ml_dtypes.bfloat16
        except ImportError:
            np_dtype, dtype = np.float32, "float32"
    else:
        np_dtype = np.float32
    cfg["torch_dtype"] = dtype

    n_deq = n_pass = 0
    for shard in sorted(glob.glob(os.path.join(in_dir, "*.safetensors"))):
        tensors = load_file(shard)
        out: Dict[str, np.ndarray] = {}
        for name, t in tensors.items():
            if name.endswith(".scales") or name.endswith(".biases"):
                continue
            base = name[:-len(".weight")] if name.endswith(".weight") else None
            if (base is not None and t.dtype == np.uint32
                    and f"{base}.scales" in tensors):
                w = dequantize_tensor(t, tensors[f"{base}.scales"],
                                      tensors[f"{base}.biases"], group)
                out[name] = w.astype(np_dtype)
                n_deq += 1
            else:
                out[name] = t
                n_pass += 1
        save_file(out, os.path.join(out_dir, os.path.basename(shard)))

    with open(os.path.join(out_dir, "config.json"), "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=1, sort_keys=True)
    for aux in ("tokenizer.json", "tokenizer_config.json", "vocab.json",
                "merges.txt", "special_tokens_map.json", "generation_config.json",
                "model.safetensors.index.json"):
        src = os.path.join(in_dir, aux)
        if os.path.exists(src):
            shutil.copy(src, os.path.join(out_dir, aux))
    # The index (if present) maps names→shards; names are unchanged, so it
    # stays valid — but its byte totals are stale after dequant. Drop it and
    # let transformers glob the shards instead.
    idx = os.path.join(out_dir, "model.safetensors.index.json")
    if os.path.exists(idx):
        os.remove(idx)
    return {"ok": True, "dequantized": n_deq, "passthrough": n_pass,
            "dtype": dtype, "groupSize": group, "out": out_dir}


# ── adapter conversion ───────────────────────────────────────────────────────────

def cuda_recipe(mlx_adapter_config: Dict) -> Dict:
    """The PEFT recipe equivalent to an mlx_lm adapter config — exported, not
    hand-copied, so the sweep can never drift from what serve expects."""
    lp = mlx_adapter_config.get("lora_parameters") or {}
    rank = int(lp.get("rank", 8))
    scale = float(lp.get("scale", 20.0))
    n_layers = int(mlx_adapter_config.get("num_layers", 16))
    return {"r": rank, "lora_alpha": scale * rank,   # PEFT applies alpha/r
            "lora_dropout": float(lp.get("dropout", 0.0)),
            "target_modules": list(LORA_MODULES),
            # mlx_lm's --num-layers N = the LAST N decoder layers.
            "numLayersFromEnd": n_layers,
            "baseModel": mlx_adapter_config.get("model", ""),
            "bridgeVersion": BRIDGE_VERSION}


def _peft_name_to_mlx(name: str) -> Optional[str]:
    """base_model.model.model.layers.N...lora_A.weight → model.layers.N...lora_a"""
    if ".lora_A." in name:
        which = "lora_a"
    elif ".lora_B." in name:
        which = "lora_b"
    else:
        return None
    core = name.split(".lora_")[0]
    for prefix in ("base_model.model.model.", "base_model.model.", "model."):
        if core.startswith(prefix):
            core = core[len(prefix):]
            break
    return f"model.{core}.{which}"


def peft_to_mlx_adapter(peft_dir: str, out_dir: str, *,
                        mlx_adapter_config: Dict) -> Dict:
    """PEFT adapter dir → mlx_lm adapter dir servable via --adapter-path.

    The scale identity is CHECKED, not trusted: PEFT's alpha/r must equal the
    MLX config's scale, or the served adapter would be silently mis-weighted —
    the exact class of quiet corruption this bridge exists to prevent."""
    from safetensors.numpy import load_file, save_file

    peft_cfg = json.load(open(os.path.join(peft_dir, "adapter_config.json"),
                              encoding="utf-8"))
    lp = mlx_adapter_config.get("lora_parameters") or {}
    want_scale = float(lp.get("scale", 20.0))
    got_scale = float(peft_cfg["lora_alpha"]) / float(peft_cfg["r"])
    if abs(got_scale - want_scale) > 1e-6:
        raise ValueError(f"scale mismatch: PEFT alpha/r = {got_scale} but the "
                         f"MLX serve config expects {want_scale} — the adapter "
                         f"would serve mis-weighted")
    if int(peft_cfg["r"]) != int(lp.get("rank", 8)):
        raise ValueError(f"rank mismatch: PEFT r={peft_cfg['r']} vs MLX "
                         f"rank={lp.get('rank')}")

    tensors = load_file(os.path.join(peft_dir, "adapter_model.safetensors"))
    out: Dict[str, np.ndarray] = {}
    for name, t in tensors.items():
        mlx_name = _peft_name_to_mlx(name)
        if mlx_name is None:
            continue
        # PEFT A (r,in) / B (out,r); MLX lora_a (in,r) / lora_b (r,out).
        out[mlx_name] = np.ascontiguousarray(t.T.astype(np.float32))
    if not out:
        raise ValueError("no LoRA tensors recognized in the PEFT adapter")

    os.makedirs(out_dir, exist_ok=True)
    save_file(out, os.path.join(out_dir, "adapters.safetensors"))
    cfg = dict(mlx_adapter_config)
    cfg["bridge"] = {"version": BRIDGE_VERSION, "from": "peft",
                     "peftAlpha": peft_cfg["lora_alpha"], "peftR": peft_cfg["r"]}
    with open(os.path.join(out_dir, "adapter_config.json"), "w",
              encoding="utf-8") as f:
        json.dump(cfg, f, indent=1, sort_keys=True)
    return {"ok": True, "tensors": len(out), "out": out_dir,
            "scale": want_scale}
