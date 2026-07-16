from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Mapping, TypedDict

import numpy as np
from numpy.typing import NDArray

TargetModule = Literal["q_proj", "k_proj", "v_proj", "o_proj"]
Tensor = NDArray[np.float32]


class LoraParametersJson(TypedDict):
    rank: int
    dropout: float
    scale: float
    keys: list[str]


class MlxAdapterConfigJson(TypedDict):
    fine_tune_type: str
    num_layers: int
    lora_parameters: LoraParametersJson


@dataclass(frozen=True, slots=True)
class AdapterCompatibilityError(Exception):
    detail: str

    def __str__(self) -> str:
        return self.detail


@dataclass(frozen=True, slots=True)
class BaseModelShape:
    model_type: str
    num_hidden_layers: int
    hidden_size: int
    num_attention_heads: int
    num_key_value_heads: int
    head_dim: int


@dataclass(frozen=True, slots=True)
class PeftAdapterConfig:
    base_model_name_or_path: str
    rank: int
    alpha: float
    dropout: float
    target_modules: tuple[TargetModule, ...]
    layers_to_transform: tuple[int, ...]

    @property
    def scale(self) -> float:
        return self.alpha / self.rank


def _validate_compatibility(config: PeftAdapterConfig, shape: BaseModelShape) -> None:
    layers = config.layers_to_transform
    expected = tuple(range(shape.num_hidden_layers - len(layers), shape.num_hidden_layers))
    if not layers or layers != expected:
        raise AdapterCompatibilityError(
            f"MLX requires the final contiguous layers; got {layers}, expected {expected}"
        )
    if len(set(config.target_modules)) != len(config.target_modules):
        raise AdapterCompatibilityError("target_modules contains duplicates")


def _expected_pair_shape(
    target: TargetModule, config: PeftAdapterConfig, shape: BaseModelShape
) -> tuple[tuple[int, int], tuple[int, int]]:
    query_width = shape.num_attention_heads * shape.head_dim
    kv_width = shape.num_key_value_heads * shape.head_dim
    if target == "q_proj":
        return (config.rank, shape.hidden_size), (query_width, config.rank)
    if target in ("k_proj", "v_proj"):
        return (config.rank, shape.hidden_size), (kv_width, config.rank)
    return (config.rank, query_width), (shape.hidden_size, config.rank)


def transform_adapter_tensors(
    source: Mapping[str, Tensor], config: PeftAdapterConfig, shape: BaseModelShape
) -> dict[str, Tensor]:
    """Validate PEFT coverage and transpose tensors into MLX LoRA orientation."""
    _validate_compatibility(config, shape)
    expected_keys: set[str] = set()
    for layer in config.layers_to_transform:
        for target in config.target_modules:
            prefix = f"base_model.model.model.layers.{layer}.self_attn.{target}"
            expected_keys.update({f"{prefix}.lora_A.weight", f"{prefix}.lora_B.weight"})
    if set(source) != expected_keys:
        missing = sorted(expected_keys - set(source))[:3]
        unexpected = sorted(set(source) - expected_keys)[:3]
        raise AdapterCompatibilityError(
            f"tensor key set mismatch: missing={missing}, unexpected={unexpected}"
        )

    converted: dict[str, Tensor] = {}
    for layer in config.layers_to_transform:
        for target in config.target_modules:
            source_prefix = f"base_model.model.model.layers.{layer}.self_attn.{target}"
            a = source[f"{source_prefix}.lora_A.weight"]
            b = source[f"{source_prefix}.lora_B.weight"]
            expected_a, expected_b = _expected_pair_shape(target, config, shape)
            if a.dtype != np.float32 or b.dtype != np.float32:
                raise AdapterCompatibilityError(f"{source_prefix} must be float32")
            if a.shape != expected_a or b.shape != expected_b:
                raise AdapterCompatibilityError(
                    f"{source_prefix} shape mismatch: A={a.shape}/{expected_a}, B={b.shape}/{expected_b}"
                )
            mlx_prefix = f"model.layers.{layer}.self_attn.{target}"
            converted[f"{mlx_prefix}.lora_a"] = np.ascontiguousarray(a.T)
            converted[f"{mlx_prefix}.lora_b"] = np.ascontiguousarray(b.T)
    return converted


def build_mlx_adapter_config(
    config: PeftAdapterConfig, shape: BaseModelShape
) -> MlxAdapterConfigJson:
    """Build the exact MLX LM adapter configuration for the validated PEFT input."""
    _validate_compatibility(config, shape)
    return {
        "fine_tune_type": "lora",
        "num_layers": len(config.layers_to_transform),
        "lora_parameters": {
            "rank": config.rank,
            "dropout": config.dropout,
            "scale": config.scale,
            "keys": [f"self_attn.{target}" for target in sorted(config.target_modules)],
        },
    }
