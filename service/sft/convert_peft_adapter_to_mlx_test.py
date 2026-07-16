from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pytest
from safetensors.numpy import load_file, save_file

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from convert_peft_adapter_to_mlx import (  # noqa: E402
    AdapterCompatibilityError,
    BaseModelShape,
    PeftAdapterConfig,
    build_mlx_adapter_config,
    convert_adapter_directory,
    transform_adapter_tensors,
)


def model_shape(*, layers: int = 48) -> BaseModelShape:
    return BaseModelShape(
        model_type="qwen3_moe",
        num_hidden_layers=layers,
        hidden_size=3,
        num_attention_heads=2,
        num_key_value_heads=1,
        head_dim=2,
    )


def peft_config(
    *,
    layers: tuple[int, ...] = (47,),
    targets: tuple[str, ...] = ("q_proj",),
) -> PeftAdapterConfig:
    return PeftAdapterConfig(
        base_model_name_or_path="Qwen/Qwen3-30B-A3B-Instruct-2507",
        rank=2,
        alpha=4.0,
        dropout=0.05,
        target_modules=targets,
        layers_to_transform=layers,
    )


def test_transform_transposes_tensors_and_preserves_peft_delta() -> None:
    source_a = np.array([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]], dtype=np.float32)
    source_b = np.array(
        [[0.5, 1.0], [1.5, 2.0], [2.5, 3.0], [3.5, 4.0]],
        dtype=np.float32,
    )
    prefix = "base_model.model.model.layers.47.self_attn.q_proj"

    converted = transform_adapter_tensors(
        {
            f"{prefix}.lora_A.weight": source_a,
            f"{prefix}.lora_B.weight": source_b,
        },
        peft_config(),
        model_shape(),
    )

    mlx_prefix = "model.layers.47.self_attn.q_proj"
    np.testing.assert_array_equal(converted[f"{mlx_prefix}.lora_a"], source_a.T)
    np.testing.assert_array_equal(converted[f"{mlx_prefix}.lora_b"], source_b.T)

    x = np.array([[0.25, -0.5, 2.0]], dtype=np.float32)
    peft_delta = ((x @ source_a.T) @ source_b.T) * 2.0
    mlx_delta = (
        (x @ converted[f"{mlx_prefix}.lora_a"])
        @ converted[f"{mlx_prefix}.lora_b"]
    ) * 2.0
    np.testing.assert_allclose(mlx_delta, peft_delta, rtol=1e-6, atol=1e-6)


def test_mlx_config_carries_exact_rank_scale_dropout_and_keys() -> None:
    config = peft_config(
        targets=("v_proj", "q_proj", "o_proj", "k_proj"),
    )

    mlx_config = build_mlx_adapter_config(config, model_shape())

    assert mlx_config == {
        "fine_tune_type": "lora",
        "num_layers": 1,
        "lora_parameters": {
            "rank": 2,
            "dropout": 0.05,
            "scale": 2.0,
            "keys": [
                "self_attn.k_proj",
                "self_attn.o_proj",
                "self_attn.q_proj",
                "self_attn.v_proj",
            ],
        },
    }


def test_non_tail_layers_are_rejected_before_conversion() -> None:
    with pytest.raises(AdapterCompatibilityError, match="final contiguous layers"):
        transform_adapter_tensors({}, peft_config(layers=(31,)), model_shape())


def test_missing_lora_pair_is_rejected() -> None:
    prefix = "base_model.model.model.layers.47.self_attn.q_proj"
    with pytest.raises(AdapterCompatibilityError, match="tensor key set"):
        transform_adapter_tensors(
            {f"{prefix}.lora_A.weight": np.ones((2, 3), dtype=np.float32)},
            peft_config(),
            model_shape(),
        )


def test_directory_conversion_is_deterministic_and_self_auditing(tmp_path: Path) -> None:
    source_dir = tmp_path / "source"
    base_dir = tmp_path / "base"
    first_out = tmp_path / "mlx-first"
    second_out = tmp_path / "mlx-second"
    source_dir.mkdir()
    base_dir.mkdir()

    source_config = {
        "base_model_name_or_path": "Qwen/Qwen3-30B-A3B-Instruct-2507",
        "bias": "none",
        "fan_in_fan_out": False,
        "layers_to_transform": [1],
        "lora_alpha": 4,
        "lora_dropout": 0.05,
        "peft_type": "LORA",
        "r": 2,
        "target_modules": ["q_proj"],
        "task_type": "CAUSAL_LM",
        "use_dora": False,
        "use_rslora": False,
    }
    base_config = {
        "model_type": "qwen3_moe",
        "num_hidden_layers": 2,
        "hidden_size": 3,
        "num_attention_heads": 2,
        "num_key_value_heads": 1,
        "head_dim": 2,
    }
    (source_dir / "adapter_config.json").write_text(
        json.dumps(source_config), encoding="utf-8"
    )
    (base_dir / "config.json").write_text(json.dumps(base_config), encoding="utf-8")
    prefix = "base_model.model.model.layers.1.self_attn.q_proj"
    save_file(
        {
            f"{prefix}.lora_A.weight": np.arange(6, dtype=np.float32).reshape(2, 3),
            f"{prefix}.lora_B.weight": np.arange(8, dtype=np.float32).reshape(4, 2),
        },
        source_dir / "adapter_model.safetensors",
    )

    convert_adapter_directory(source_dir, base_dir, first_out)
    convert_adapter_directory(source_dir, base_dir, second_out)

    first_weights = (first_out / "adapters.safetensors").read_bytes()
    second_weights = (second_out / "adapters.safetensors").read_bytes()
    assert first_weights == second_weights
    assert (first_out / "adapter_config.json").read_bytes() == (
        second_out / "adapter_config.json"
    ).read_bytes()

    converted = load_file(first_out / "adapters.safetensors")
    assert sorted(converted) == [
        "model.layers.1.self_attn.q_proj.lora_a",
        "model.layers.1.self_attn.q_proj.lora_b",
    ]
    manifest = json.loads((first_out / "conversion_manifest.json").read_text())
    assert manifest["schema_version"] == 1
    assert manifest["adapter"]["tensor_count"] == 2
    assert manifest["adapter"]["scale"] == 2.0
    assert manifest["outputs"]["adapters.safetensors"]["sha256"]
    assert manifest["outputs"]["adapter_config.json"]["sha256"]


if __name__ == "__main__":
    # gate.sh run_py_tests executes test files directly with python3 — without
    # this block a pytest-style file would exit 0 having run nothing.
    raise SystemExit(pytest.main([__file__, "-q"]))
