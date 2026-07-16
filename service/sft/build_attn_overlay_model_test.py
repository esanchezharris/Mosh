"""Golden test for build_attn_overlay_model.py on a tiny synthetic model.

Pins: untouched quantized tensors pass through bit-exact, touched projections
are replaced by exact bf16 (base + scale·BA) Linears with their quant triplets
removed, the per-layer quantization config opts the touched paths out, and the
output refuses to overwrite. Runs under plain python3 (gate.sh run_py_tests);
skips cleanly where mlx is unavailable (e.g. Linux CI).
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

try:
    import mlx.core as mx
except ImportError:
    print("build_attn_overlay_model_test: SKIP (mlx unavailable)")
    sys.exit(0)

from build_attn_overlay_model import main as build_overlay  # noqa: E402

TOUCHED = "model.layers.1.self_attn.q_proj"
UNTOUCHED = "model.layers.0.mlp.up_proj"


def make_fixture(root: Path) -> tuple[Path, Path, Path]:
    base = root / "base"
    attn = root / "attn"
    adapter = root / "adapter"
    for d in (base, attn, adapter):
        d.mkdir()

    mx.random.seed(7)
    w_touched = mx.random.normal((128, 64)).astype(mx.float32) * 0.02
    w_untouched = mx.random.normal((64, 64)).astype(mx.float32) * 0.02
    tq, ts, tb = mx.quantize(w_touched, group_size=64, bits=4)
    uq, us, ub = mx.quantize(w_untouched, group_size=64, bits=4)

    shard1 = {f"{UNTOUCHED}.weight": uq, f"{UNTOUCHED}.scales": us, f"{UNTOUCHED}.biases": ub}
    shard2 = {f"{TOUCHED}.weight": tq, f"{TOUCHED}.scales": ts, f"{TOUCHED}.biases": tb}
    mx.save_safetensors(str(base / "model-00001-of-00002.safetensors"), shard1)
    mx.save_safetensors(str(base / "model-00002-of-00002.safetensors"), shard2)
    weight_map = {k: "model-00001-of-00002.safetensors" for k in shard1}
    weight_map |= {k: "model-00002-of-00002.safetensors" for k in shard2}
    (base / "model.safetensors.index.json").write_text(
        json.dumps({"metadata": {"total_size": 0}, "weight_map": weight_map})
    )
    (base / "config.json").write_text(
        json.dumps({"model_type": "qwen3_moe", "quantization": {"group_size": 64, "bits": 4},
                    "quantization_config": {"group_size": 64, "bits": 4}})
    )
    (base / "tokenizer.json").write_text("{}")

    # bf16 "original" for the touched projection: dequant(base) + a visible offset,
    # so the test proves the overlay uses THIS tensor, not the quantized one.
    w_bf16 = (mx.dequantize(tq, ts, tb, group_size=64, bits=4).astype(mx.float32) + 0.001).astype(mx.bfloat16)
    mx.save_safetensors(str(attn / f"{TOUCHED}.weight.safetensors"), {f"{TOUCHED}.weight": w_bf16})

    rank = 2
    la = (mx.random.normal((64, rank)) * 0.01).astype(mx.float32)
    lb = (mx.random.normal((rank, 128)) * 0.01).astype(mx.float32)
    mx.save_safetensors(str(adapter / "adapters.safetensors"),
                        {f"{TOUCHED}.lora_a": la, f"{TOUCHED}.lora_b": lb})
    (adapter / "adapter_config.json").write_text(
        json.dumps({"fine_tune_type": "lora", "num_layers": 1,
                    "lora_parameters": {"rank": rank, "dropout": 0.0, "scale": 2.0,
                                        "keys": ["self_attn.q_proj"]}})
    )
    return base, attn, adapter


def run() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        base, attn, adapter = make_fixture(root)
        out = root / "out"
        build_overlay(base, attn, adapter, out)

        # Untouched tensors: bit-exact pass-through, still quantized.
        s1 = mx.load(str(out / "model-00001-of-00002.safetensors"))
        b1 = mx.load(str(base / "model-00001-of-00002.safetensors"))
        for k in b1:
            assert mx.array_equal(s1[k], b1[k]).item(), f"untouched {k} changed"

        # Touched: only a bf16 weight, exactly bf16 + scale·(B@A).
        s2 = mx.load(str(out / "model-00002-of-00002.safetensors"))
        assert set(s2) == {f"{TOUCHED}.weight"}, sorted(s2)
        assert s2[f"{TOUCHED}.weight"].dtype == mx.bfloat16
        w_bf16 = mx.load(str(attn / f"{TOUCHED}.weight.safetensors"))[f"{TOUCHED}.weight"]
        ad = mx.load(str(adapter / "adapters.safetensors"))
        expect = (w_bf16.astype(mx.float32)
                  + 2.0 * (ad[f"{TOUCHED}.lora_b"].T @ ad[f"{TOUCHED}.lora_a"].T)).astype(mx.bfloat16)
        assert mx.array_equal(s2[f"{TOUCHED}.weight"], expect).item(), "fused weight mismatch"

        config = json.loads((out / "config.json").read_text())
        assert config["quantization"][TOUCHED] is False
        assert config["quantization_config"][TOUCHED] is False
        index = json.loads((out / "model.safetensors.index.json").read_text())
        assert f"{TOUCHED}.scales" not in index["weight_map"]
        assert index["weight_map"][f"{TOUCHED}.weight"] == "model-00002-of-00002.safetensors"
        assert (out / "tokenizer.json").is_file()
        manifest = json.loads((out / "overlay_manifest.json").read_text())
        assert manifest["overlaid_paths"] == [TOUCHED]

        try:
            build_overlay(base, attn, adapter, out)
        except SystemExit as exc:
            assert "refusing" in str(exc)
        else:
            raise AssertionError("expected refusal on existing output dir")

    print("build_attn_overlay_model_test: ALL PASS")


if __name__ == "__main__":
    run()
