"""DoRA-rows LoRA merge, npz -> npz, no torch.

Bakes one or more trained SA3 LoRAs (torch-layout .safetensors from
stable-audio-3's train_lora.py) into the MLX DiT checkpoint at chosen
strengths, writing a merged .npz the MLX engine loads like the stock one.

Math (mirrors stable_audio_3/models/lora/model.py::dora_forward exactly):
    W_2d  = W.view(out, -1)                      # f32
    V     = W_2d + scaling * strength * (B @ A)  # scaling = alpha / rank
    V_hat = V / (row_norm(V) + 1e-12)
    W'    = V_hat * magnitude[:, None]
Stacks apply sequentially in selection order (each re-normalizes), matching
torch's parametrization chaining.

Key mapping (torch module -> MLX npz key), verified against the real artifacts:
    model.<x>                                    -> <x>.weight
    ...to_local_embed.<n>                        -> ...to_local_embed.seq.<n>.weight
    conditioners.seconds_total.embedder.embedding.1 -> cond.seconds_total_weight
1x1 Conv1d weights are stored [out, 1, in] in the npz and merge as [out, in].
Unmappable/mismatched modules are skipped and reported, never fatal.

The render path applies these weights at runtime (no bake, no disk) on every
backend: MLX via the engine's apply_loras, Windows/CUDA via the torch in-memory
apply in stable_audio3_cuda (FIT-013 decision — supersedes the earlier disk-fuse
plan). merge() keeps the disk-bake as the cross-backend test oracle. All paths
share the one math function below.

Stdlib + numpy only (safetensors parsed by hand) so it runs in the SA3 venv.
"""
from __future__ import annotations

import json
import os
import struct

import numpy as np

_EPS = 1e-12


# ── minimal safetensors reader (header: u64 LE length + JSON; row-major data) ──

_DTYPES = {"F32": np.float32, "F16": np.float16, "F64": np.float64,
           "I32": np.int32, "I64": np.int64, "BF16": None}


def read_safetensors(path: str) -> tuple[dict, dict]:
    """Return ({key: ndarray(float32)}, metadata_dict)."""
    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        header = json.loads(f.read(n))
        base = 8 + n
        meta = header.pop("__metadata__", {}) or {}
        out = {}
        for key, info in header.items():
            dt = info["dtype"]
            start, end = info["data_offsets"]
            f.seek(base + start)
            raw = f.read(end - start)
            if dt == "BF16":
                # bf16 -> f32: widen each 2-byte value with a low zero half
                u16 = np.frombuffer(raw, np.uint16)
                arr = (u16.astype(np.uint32) << 16).view(np.float32)
            else:
                np_dt = _DTYPES.get(dt)
                if np_dt is None:
                    raise ValueError(f"unsupported safetensors dtype {dt} for {key}")
                arr = np.frombuffer(raw, np_dt).astype(np.float32)
            out[key] = arr.reshape(info["shape"])
    return out, meta


# ── key mapping ──

def map_module_to_npz_key(module: str) -> str | None:
    if module == "conditioners.seconds_total.embedder.embedding.1":
        return "cond.seconds_total_weight"
    if module.startswith("conditioners."):
        return None                       # other conditioner parts aren't in the DiT npz
    if module.startswith("model."):
        module = module[len("model."):]
    parts = module.split(".to_local_embed.")
    if len(parts) == 2:
        module = parts[0] + ".to_local_embed.seq." + parts[1]
    return module + ".weight"


def group_lora(tensors: dict) -> dict:
    """{module: {lora_A, lora_B, magnitude}} from parametrization keys."""
    groups: dict[str, dict] = {}
    marker = ".parametrizations.weight.0."
    for key, arr in tensors.items():
        if marker not in key:
            continue
        module, part = key.split(marker, 1)
        groups.setdefault(module, {})[part] = arr
    return groups


# ── per-layer math + weight selection (shared by disk merge AND runtime apply) ──

def apply_dora(xp, W2, A, B, magnitude, adapter_type, scaling, strength):
    """One layer's LoRA/DoRA update on a 2D weight. `xp` is numpy, mlx.core or torch.

    W2 (out, in), A (rank, in), B (out, rank); `magnitude` (out,) for DoRA, None
    for plain LoRA. Returns the updated 2D weight in float32 (the caller casts to
    the stored dtype + reshapes back). Mirrors dora_forward exactly; the numpy
    path is bit-identical to the old disk merge. torch tensors lack .astype and
    treat keepdims= as a version-fragile numpy alias, hence the hasattr fork —
    same ops, same order, same precision on all three backends.
    """
    W32 = W2.astype(xp.float32) if hasattr(W2, "astype") else W2.to(xp.float32)
    V = W32 + scaling * strength * (B @ A)
    if adapter_type in ("dora-rows", "dora"):
        if hasattr(V, "astype"):                              # numpy / mlx
            norm = xp.sqrt((V * V).sum(axis=1, keepdims=True))  # per-row L2
        else:                                                 # torch
            norm = xp.sqrt((V * V).sum(dim=1, keepdim=True))
        V = V / (norm + _EPS)
        V = V * magnitude[:, None]
    return V


def weights_for_selection(selection, base_get):
    """Compute the updated weights for a LoRA selection WITHOUT baking a file.

    selection = [(name, safetensors_path, strength)] in application order.
    base_get(npz_key) -> pristine base array (any dtype) or None if absent.

    Returns ({npz_key: updated_weight in stored shape/dtype}, report). The stack
    applies sequentially from the base (each DoRA re-normalizes), in the SAME
    order/precision as merge(), so the result is bit-identical to a disk merge —
    this is what makes runtime application == baking.
    """
    work: dict = {}
    applied, skipped = 0, []
    for name, lora_path, strength in selection:
        tensors, meta = read_safetensors(lora_path)
        cfg = json.loads(meta.get("lora_config", "{}")) if meta else {}
        rank = float(cfg.get("rank", 16))
        alpha = float(cfg.get("alpha", cfg.get("lora_alpha", rank)))
        adapter_type = cfg.get("adapter_type", "dora-rows")
        if adapter_type not in ("dora-rows", "dora", "lora"):
            raise ValueError(f"{name}: unsupported adapter_type {adapter_type!r}")
        scaling = alpha / rank
        for module, parts in sorted(group_lora(tensors).items()):
            key = map_module_to_npz_key(module)
            if key is None:
                skipped.append(f"{name}:{module}")
                continue
            if key not in work:
                base = base_get(key)
                if base is None:
                    skipped.append(f"{name}:{module}")
                    continue
                work[key] = base
            W = work[key]
            orig_shape, orig_dtype = W.shape, W.dtype
            W2 = W.reshape(W.shape[0], 1, -1)[:, 0, :] if W.ndim == 3 and W.shape[1] == 1 \
                else (W if W.ndim == 2 else None)
            A, B = parts.get("lora_A"), parts.get("lora_B")
            if W2 is None or A is None or B is None or \
                    B.shape[0] != W2.shape[0] or A.shape[1] != W2.shape[1]:
                skipped.append(f"{name}:{module}")
                continue
            mag = None
            if adapter_type in ("dora-rows", "dora"):
                mag = parts.get("magnitude")
                if mag is None or mag.shape[0] != W2.shape[0]:
                    skipped.append(f"{name}:{module}")
                    continue
            V = apply_dora(np, W2, A, B, mag, adapter_type, scaling, strength)
            work[key] = V.astype(orig_dtype).reshape(orig_shape)
            applied += 1
    return work, {"applied": applied, "skipped": skipped}


# ── merge (disk bake — reuses the shared math; kept as the test oracle) ──

def merge(base_npz: str, selection: list[tuple[str, str, float]], out_path: str) -> dict:
    """Bake the selection onto the base npz and write it. Both render paths (MLX
    engine.apply_loras, CUDA torch in-memory apply) apply the same weights at
    RUNTIME instead — see weights_for_selection, which this shares so runtime
    application stays bit-identical to a bake.
    selection = [(name, safetensors_path, strength)] in application order."""
    arrays = {k: np.array(v) for k, v in np.load(base_npz).items()}
    updated, report = weights_for_selection(selection, lambda k: arrays.get(k))
    arrays.update(updated)
    tmp = out_path + ".tmp.npz"
    np.savez(tmp, **arrays)
    os.replace(tmp, out_path)
    return report
