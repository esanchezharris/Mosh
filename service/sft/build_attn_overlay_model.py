#!/usr/bin/env python
"""Build a mixed-precision MLX serving artifact: a quantized base model whose
LoRA-touched attention projections are replaced by EXACT bf16 (base + delta)
Linear weights.

Why this exists (measured 2026-07-16, a3b-r5): the r5 LoRA was trained against
the bf16 base on the CUDA lane. Its per-element delta RMS is ~2% of the 4-bit
quantization step of the MLX base, so `mlx_lm fuse` into the 4-bit base rounds
most of the delta away (probe: the applied weight-change had cosine ~0.03 with
the intended delta and ~5x its norm — mostly re-quantization noise; only ~17%
of the delta magnitude survived in-grid). Storing the 64 touched projections
unquantized (bf16 base tensor + delta, computed in f32) preserves the adapter
exactly, at ~+0.6 GB model size, and needs only the touched bf16 tensors
(~600 MB ranged download) instead of the full 61 GB bf16 checkpoint.

mlx_lm loads this via its per-layer quantization config: entries set to False
opt a path out of quantization, and layers without `.scales` in the weight file
stay regular Linears (verified against mlx_lm 0.31.3 utils.load_model).

Usage:
  python build_attn_overlay_model.py BASE_DIR BF16_ATTN_DIR MLX_ADAPTER_DIR OUT_DIR

  BASE_DIR        quantized MLX base (e.g. ...-4bit or ...-8bit)
  BF16_ATTN_DIR   dir of single-tensor .safetensors files holding the bf16
                  base attention weights for every adapter-touched projection
                  (fetch via HTTP range requests; see conversion notes)
  MLX_ADAPTER_DIR output of convert_peft_adapter_to_mlx.py (adapters.safetensors
                  + adapter_config.json with lora_parameters.scale)
  OUT_DIR         new model dir (refuses to overwrite)
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import mlx.core as mx


def touched_paths(adapter_weights: dict) -> list[str]:
    paths = sorted({k.rsplit(".lora_", 1)[0] for k in adapter_weights})
    if not paths:
        raise SystemExit("adapter holds no lora tensors")
    return paths


def main(base_dir: Path, attn_dir: Path, adapter_dir: Path, out_dir: Path) -> None:
    if out_dir.exists():
        raise SystemExit(f"refusing to overwrite {out_dir}")
    adapter = mx.load(str(adapter_dir / "adapters.safetensors"))
    scale = json.loads((adapter_dir / "adapter_config.json").read_text())[
        "lora_parameters"
    ]["scale"]
    paths = touched_paths(adapter)

    # Exact fused weights, computed in f32, stored bf16 (the CUDA-lane merged-
    # checkpoint convention; bf16 rounding noise is ~1% of delta energy here).
    fused: dict[str, mx.array] = {}
    for path in paths:
        f = attn_dir / (path + ".weight.safetensors")
        if not f.is_file():
            raise SystemExit(f"missing bf16 tensor file: {f}")
        w = mx.load(str(f))[path + ".weight"].astype(mx.float32)
        la = adapter[path + ".lora_a"].astype(mx.float32)
        lb = adapter[path + ".lora_b"].astype(mx.float32)
        delta = scale * (lb.T @ la.T)
        if delta.shape != w.shape:
            raise SystemExit(f"{path}: delta {delta.shape} != weight {w.shape}")
        fused[path + ".weight"] = (w + delta).astype(mx.bfloat16)

    out_dir.mkdir(parents=True)
    index = json.loads((base_dir / "model.safetensors.index.json").read_text())
    weight_map: dict[str, str] = index["weight_map"]
    drop = {p + s for p in paths for s in (".weight", ".scales", ".biases")}
    new_map: dict[str, str] = {}
    total = 0
    shards = sorted({weight_map[k] for k in weight_map})
    for shard in shards:
        tensors = mx.load(str(base_dir / shard))
        kept = {k: v for k, v in tensors.items() if k not in drop}
        # Land each fused weight in the shard that held the original .weight.
        for path in paths:
            if weight_map.get(path + ".weight") == shard:
                kept[path + ".weight"] = fused[path + ".weight"]
        mx.save_safetensors(str(out_dir / shard), kept, {"format": "mlx"})
        for k, v in kept.items():
            new_map[k] = shard
            total += v.nbytes
        del tensors, kept

    (out_dir / "model.safetensors.index.json").write_text(
        json.dumps(
            {"metadata": {"total_size": total}, "weight_map": dict(sorted(new_map.items()))},
            indent=2,
        )
        + "\n"
    )

    config = json.loads((base_dir / "config.json").read_text())
    for key in ("quantization", "quantization_config"):
        if key in config and isinstance(config[key], dict):
            for path in paths:
                config[key][path] = False
    (out_dir / "config.json").write_text(json.dumps(config, indent=2) + "\n")

    for f in base_dir.iterdir():
        if f.name in ("config.json", "model.safetensors.index.json"):
            continue
        if f.name.startswith("model-") and f.name.endswith(".safetensors"):
            continue
        if f.is_file() and not f.name.startswith("."):
            shutil.copy2(f, out_dir / f.name)

    manifest = {
        "schema_version": 1,
        "builder": "mosh-attn-overlay-v1",
        "base_dir": str(base_dir),
        "adapter_dir": str(adapter_dir),
        "scale": scale,
        "overlaid_paths": paths,
        "stored_dtype": "bfloat16",
    }
    (out_dir / "overlay_manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"built {out_dir} ({len(paths)} overlaid projections, total {total/1e9:.2f} GB)")


if __name__ == "__main__":
    if len(sys.argv) != 5:
        raise SystemExit(__doc__)
    main(*(Path(a).expanduser() for a in sys.argv[1:5]))
