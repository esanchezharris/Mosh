#!/usr/bin/env python3
"""Guards for the CUDA↔MLX bridge. The dequant fixture is HAND-COMPUTED — a
round-trip through the module's own pack/unpack would test it against itself.

Opt-in (`LYRICS_BENCH_MLX_SMOKE=1`, Apple silicon only): verify the numpy
unpacking against mx.quantize/mx.dequantize ground truth on random matrices.

Run:  python3 service/lyrics/bench/fim_bridge_test.py     (exit 0 = all pass)
"""
import json
import os
import sys
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, SERVICE)

from lyrics.bench import fim_bridge  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


# ── unpack: hand-computed, one uint32, nibble order is THE thing ────────────────
# 0x87654321 little-endian nibbles → [1,2,3,4,5,6,7,8]. A big-endian unpack
# yields [8,7,...] and the fixture goes red.
q = np.array([[0x87654321]], dtype=np.uint32)
check("unpack_q4: little-endian nibble order, hand-computed",
      fim_bridge.unpack_q4(q).tolist() == [[1, 2, 3, 4, 5, 6, 7, 8]],
      str(fim_bridge.unpack_q4(q).tolist()))

# dequantize: 16 nibbles, 2 groups of 8, distinct scale/bias per group.
q2 = np.array([[0x87654321, 0xFEDCBA98]], dtype=np.uint32)
sc = np.array([[2.0, 0.5]], dtype=np.float32)
bi = np.array([[10.0, -1.0]], dtype=np.float32)
w = fim_bridge.dequantize_tensor(q2, sc, bi, group_size=8)
expect = ([1 * 2.0 + 10, 2 * 2.0 + 10, 3 * 2.0 + 10, 4 * 2.0 + 10,
           5 * 2.0 + 10, 6 * 2.0 + 10, 7 * 2.0 + 10, 8 * 2.0 + 10]
          + [8 * .5 - 1, 9 * .5 - 1, 10 * .5 - 1, 11 * .5 - 1,
             12 * .5 - 1, 13 * .5 - 1, 14 * .5 - 1, 15 * .5 - 1])
check("dequantize_tensor: per-group scale+bias, hand-computed",
      np.allclose(w, np.array([expect], dtype=np.float32)), str(w.tolist()))

# ── checkpoint round-trip on a tiny fake shard ──────────────────────────────────
from safetensors.numpy import load_file, save_file  # noqa: E402

with tempfile.TemporaryDirectory() as td:
    src = os.path.join(td, "src")
    os.makedirs(src)
    save_file({"model.layers.0.self_attn.q_proj.weight": q2,
               "model.layers.0.self_attn.q_proj.scales": sc,
               "model.layers.0.self_attn.q_proj.biases": bi,
               "model.norm.weight": np.ones(4, dtype=np.float32)},
              os.path.join(src, "model.safetensors"))
    json.dump({"quantization": {"bits": 4, "group_size": 8},
               "model_type": "qwen2"},
              open(os.path.join(src, "config.json"), "w"))
    rep = fim_bridge.dequantize_checkpoint(src, os.path.join(td, "out"),
                                           dtype="float32")
    out = load_file(os.path.join(td, "out", "model.safetensors"))
    cfg = json.load(open(os.path.join(td, "out", "config.json")))
    check("checkpoint: quantized triple collapses to ONE full weight",
          rep["dequantized"] == 1 and rep["passthrough"] == 1
          and "model.layers.0.self_attn.q_proj.scales" not in out
          and np.allclose(out["model.layers.0.self_attn.q_proj.weight"],
                          np.array([expect], dtype=np.float32)),
          str(rep))
    check("checkpoint: quantization block removed from config",
          "quantization" not in cfg and cfg.get("torch_dtype") == "float32")

# TWO-shard fixture: attempt 3 died at from_pretrained because the index was
# deleted on the false claim that transformers globs shards. A one-shard
# fixture cannot carry that failure — sharded checkpoints REQUIRE the index,
# rebuilt (not copied: the source index maps scales/biases that no longer
# exist).
with tempfile.TemporaryDirectory() as td:
    src = os.path.join(td, "src")
    os.makedirs(src)
    save_file({"model.layers.0.self_attn.q_proj.weight": q2,
               "model.layers.0.self_attn.q_proj.scales": sc,
               "model.layers.0.self_attn.q_proj.biases": bi},
              os.path.join(src, "model-00001-of-00002.safetensors"))
    save_file({"model.norm.weight": np.ones(4, dtype=np.float32)},
              os.path.join(src, "model-00002-of-00002.safetensors"))
    json.dump({"quantization": {"bits": 4, "group_size": 8},
               "weight_map": {"model.layers.0.self_attn.q_proj.scales":
                              "model-00001-of-00002.safetensors"}},
              open(os.path.join(src, "model.safetensors.index.json"), "w"))
    json.dump({"quantization": {"bits": 4, "group_size": 8},
               "model_type": "qwen2"},
              open(os.path.join(src, "config.json"), "w"))
    rep2 = fim_bridge.dequantize_checkpoint(src, os.path.join(td, "out"),
                                            dtype="float32")
    idx_p = os.path.join(td, "out", "model.safetensors.index.json")
    check("sharded: the index EXISTS in the output (transformers requires it)",
          os.path.exists(idx_p), str(rep2))
    idx = json.load(open(idx_p))
    check("sharded: weight_map points each tensor at its ACTUAL shard, "
          "no scales/biases entries",
          idx["weight_map"] == {
              "model.layers.0.self_attn.q_proj.weight":
                  "model-00001-of-00002.safetensors",
              "model.norm.weight": "model-00002-of-00002.safetensors"},
          str(idx["weight_map"]))
    check("sharded: total_size matches the written tensors",
          idx["metadata"]["total_size"] == 16 * 4 + 4 * 4,
          str(idx["metadata"]))

# ── recipe export ───────────────────────────────────────────────────────────────
MLX_CFG = {"lora_parameters": {"rank": 8, "scale": 20.0, "dropout": 0.0},
           "num_layers": 16, "model": "mlx-community/Qwen2.5-14B-Instruct-4bit"}
rec = fim_bridge.cuda_recipe(MLX_CFG)
check("recipe: PEFT alpha = mlx scale × rank (160), r matches",
      rec["r"] == 8 and rec["lora_alpha"] == 160.0
      and rec["numLayersFromEnd"] == 16, str(rec))

# ── adapter conversion ──────────────────────────────────────────────────────────
with tempfile.TemporaryDirectory() as td:
    peft = os.path.join(td, "peft")
    os.makedirs(peft)
    A = np.arange(8 * 4, dtype=np.float32).reshape(8, 4)     # (r, in)
    B = np.arange(6 * 8, dtype=np.float32).reshape(6, 8)     # (out, r)
    save_file({"base_model.model.model.layers.32.self_attn.q_proj.lora_A.weight": A,
               "base_model.model.model.layers.32.self_attn.q_proj.lora_B.weight": B},
              os.path.join(peft, "adapter_model.safetensors"))
    json.dump({"r": 8, "lora_alpha": 160.0},
              open(os.path.join(peft, "adapter_config.json"), "w"))
    rep = fim_bridge.peft_to_mlx_adapter(peft, os.path.join(td, "mlx"),
                                         mlx_adapter_config=MLX_CFG)
    out = load_file(os.path.join(td, "mlx", "adapters.safetensors"))
    check("adapter: names map to mlx_lm convention",
          set(out) == {"model.layers.32.self_attn.q_proj.lora_a",
                       "model.layers.32.self_attn.q_proj.lora_b"}, str(set(out)))
    check("adapter: tensors TRANSPOSED (PEFT (r,in)/(out,r) → mlx (in,r)/(r,out))",
          out["model.layers.32.self_attn.q_proj.lora_a"].shape == (4, 8)
          and np.array_equal(out["model.layers.32.self_attn.q_proj.lora_a"], A.T)
          and out["model.layers.32.self_attn.q_proj.lora_b"].shape == (8, 6)
          and np.array_equal(out["model.layers.32.self_attn.q_proj.lora_b"], B.T))
    mcfg = json.load(open(os.path.join(td, "mlx", "adapter_config.json")))
    check("adapter: serve config carries bridge provenance",
          mcfg["bridge"]["from"] == "peft"
          and mcfg["lora_parameters"]["scale"] == 20.0)

    # scale mismatch is a REFUSAL, not a warning
    json.dump({"r": 8, "lora_alpha": 80.0},
              open(os.path.join(peft, "adapter_config.json"), "w"))
    try:
        fim_bridge.peft_to_mlx_adapter(peft, os.path.join(td, "mlx2"),
                                       mlx_adapter_config=MLX_CFG)
        check("adapter: alpha/r ≠ serve scale REFUSES (mis-weighted serve)",
              False, "no exception")
    except ValueError:
        check("adapter: alpha/r ≠ serve scale REFUSES (mis-weighted serve)", True)

# ── opt-in: CUDA-trainer encoding parity vs mlx_lm's CompletionsDataset ─────────
# The 2026-07-29 twin run failed because the two stacks encoded rows
# differently (mlx_lm re-templates; the CUDA trainer concatenated raw). This
# pins _cuda_train_fim.encode_row byte-for-byte against the real thing, with
# the REAL tokenizer — a fake vocab cannot carry a chat-template drift.
if os.environ.get("LYRICS_BENCH_MLX_SMOKE") == "1":
    try:
        from transformers import AutoTokenizer
        from mlx_lm.tuner.datasets import CompletionsDataset

        from lyrics.bench import _cuda_train_fim

        _tok = AutoTokenizer.from_pretrained(
            "mlx-community/Qwen2.5-14B-Instruct-4bit")
        _rows = [
            {"prompt": "<|im_start|>system\nfinish the bar<|im_end|>\n"
                       "<|im_start|>user\nfill it<|im_end|>\n"
                       "<|im_start|>assistant\nMan, these times has been ",
             "completion": "rough\n"},
            {"prompt": "plain instruction, no baked template, ends mid ",
             "completion": "word\n"},
        ]
        _ds = CompletionsDataset(_rows, _tok, "prompt", "completion",
                                 mask_prompt=True)
        _ok = True
        for _r in _rows:
            _ids, _labels = _cuda_train_fim.encode_row(
                _tok, _r["prompt"], _r["completion"], 4096)
            _want_ids, _want_off = _ds.process(_r)
            _ok = (_ok and _ids == list(_want_ids)
                   and _labels[:_want_off] == [-100] * _want_off
                   and _labels[_want_off:] == list(_want_ids)[_want_off:])
        check("SMOKE: encode_row == CompletionsDataset.process (ids+mask)", _ok)
    except ImportError as e:
        print(f"[SKIP] SMOKE encoding parity: {e}")

# ── opt-in ground truth vs mx.quantize (Apple silicon only) ─────────────────────
if os.environ.get("LYRICS_BENCH_MLX_SMOKE") == "1":
    try:
        import mlx.core as mx
        mx.random.seed(3)
        wref = mx.random.normal((16, 256))
        qq, ss, bb = mx.quantize(wref, group_size=64, bits=4)
        mine = fim_bridge.dequantize_tensor(np.array(qq), np.array(ss),
                                            np.array(bb), group_size=64)
        gt = np.array(mx.dequantize(qq, ss, bb, group_size=64, bits=4))
        err = float(np.abs(mine - gt).max())
        check(f"SMOKE: numpy dequant == mx.dequantize (max err {err:.2e})",
              err < 1e-5)
    except ImportError:
        print("[SKIP] SMOKE: mlx not importable in this interpreter")

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)
