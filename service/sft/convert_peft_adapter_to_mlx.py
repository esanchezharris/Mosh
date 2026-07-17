#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "numpy>=2.0,<3",
#     "rich>=13,<15",
#     "safetensors>=0.5,<1",
#     "typer>=0.12,<1",
# ]
# ///

# ─── How to run ───
# 1. Install uv (if not installed):
#      curl -LsSf https://astral.sh/uv/install.sh | sh
# 2. Run directly (no venv, no pip install needed):
#      uv run convert_peft_adapter_to_mlx.py SOURCE_DIR BASE_MODEL_DIR OUTPUT_DIR
# 3. Or make executable and run:
#      chmod +x convert_peft_adapter_to_mlx.py && ./convert_peft_adapter_to_mlx.py SOURCE_DIR BASE_MODEL_DIR OUTPUT_DIR
# ──────────────────

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Final, Mapping, TypeAlias

import typer
from rich.console import Console
from safetensors.numpy import load_file, save_file

from peft_mlx_adapter import (
    AdapterCompatibilityError,
    BaseModelShape,
    PeftAdapterConfig,
    TargetModule,
    build_mlx_adapter_config,
    transform_adapter_tensors,
)

CONVERTER_ID: Final = "mosh-peft-to-mlx-lora-v1"
JsonValue: TypeAlias = (
    str | int | float | bool | None | list["JsonValue"] | dict[str, "JsonValue"]
)
JsonObject: TypeAlias = dict[str, JsonValue]


@dataclass(frozen=True, slots=True)
class ConversionResult:
    output_dir: Path
    adapter_sha256: str
    config_sha256: str


def _read_json_object(path: Path) -> JsonObject:
    try:
        value: JsonValue = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise AdapterCompatibilityError(f"cannot read JSON object {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise AdapterCompatibilityError(f"expected a JSON object in {path}")
    return value


def _required_str(raw: Mapping[str, JsonValue], key: str) -> str:
    value = raw.get(key)
    if not isinstance(value, str):
        raise AdapterCompatibilityError(f"invalid or missing {key}")
    return value


def _required_int(raw: Mapping[str, JsonValue], key: str) -> int:
    value = raw.get(key)
    if type(value) is not int:
        raise AdapterCompatibilityError(f"invalid or missing {key}")
    return value


def _required_number(raw: Mapping[str, JsonValue], key: str) -> float:
    value = raw.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise AdapterCompatibilityError(f"invalid or missing {key}")
    return float(value)


def _required_list(raw: Mapping[str, JsonValue], key: str) -> list[JsonValue]:
    value = raw.get(key)
    if not isinstance(value, list):
        raise AdapterCompatibilityError(f"invalid or missing {key}")
    return value


def _target_module(value: str) -> TargetModule:
    match value:
        case "q_proj":
            return "q_proj"
        case "k_proj":
            return "k_proj"
        case "v_proj":
            return "v_proj"
        case "o_proj":
            return "o_proj"
        case _:
            raise AdapterCompatibilityError(f"unsupported target module: {value}")


def _parse_peft_config(path: Path) -> PeftAdapterConfig:
    raw = _read_json_object(path)
    required_equals: dict[str, JsonValue] = {
        "peft_type": "LORA",
        "task_type": "CAUSAL_LM",
        "bias": "none",
        "fan_in_fan_out": False,
        "use_dora": False,
        "use_rslora": False,
    }
    for key, expected in required_equals.items():
        if raw.get(key) != expected:
            raise AdapterCompatibilityError(f"unsupported PEFT setting {key}={raw.get(key)!r}")

    targets: list[TargetModule] = []
    for value in _required_list(raw, "target_modules"):
        if not isinstance(value, str):
            raise AdapterCompatibilityError("target_modules must contain only strings")
        targets.append(_target_module(value))
    layers: list[int] = []
    for value in _required_list(raw, "layers_to_transform"):
        if type(value) is not int:
            raise AdapterCompatibilityError("layers_to_transform must contain only integers")
        layers.append(value)

    rank = _required_int(raw, "r")
    alpha = _required_number(raw, "lora_alpha")
    dropout = _required_number(raw, "lora_dropout")
    if rank <= 0 or alpha <= 0 or not 0.0 <= dropout < 1.0:
        raise AdapterCompatibilityError("rank, alpha, or dropout is outside its valid range")
    return PeftAdapterConfig(
        base_model_name_or_path=_required_str(raw, "base_model_name_or_path"),
        rank=rank,
        alpha=alpha,
        dropout=dropout,
        target_modules=tuple(sorted(targets)),
        layers_to_transform=tuple(layers),
    )


def _parse_model_shape(path: Path) -> BaseModelShape:
    raw = _read_json_object(path)
    return BaseModelShape(
        model_type=_required_str(raw, "model_type"),
        num_hidden_layers=_required_int(raw, "num_hidden_layers"),
        hidden_size=_required_int(raw, "hidden_size"),
        num_attention_heads=_required_int(raw, "num_attention_heads"),
        num_key_value_heads=_required_int(raw, "num_key_value_heads"),
        head_dim=_required_int(raw, "head_dim"),
    )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_json(path: Path, value: Mapping[str, JsonValue]) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def convert_adapter_directory(
    source_dir: Path, base_model_dir: Path, output_dir: Path
) -> ConversionResult:
    """Convert one immutable PEFT directory into a new, non-overwriting MLX bundle."""
    if output_dir.exists():
        raise AdapterCompatibilityError(f"refusing to overwrite output directory: {output_dir}")
    source_weights = source_dir / "adapter_model.safetensors"
    source_config_path = source_dir / "adapter_config.json"
    base_config_path = base_model_dir / "config.json"
    for required in (source_weights, source_config_path, base_config_path):
        if not required.is_file():
            raise AdapterCompatibilityError(f"required input is missing: {required}")

    config = _parse_peft_config(source_config_path)
    shape = _parse_model_shape(base_config_path)
    converted = transform_adapter_tensors(load_file(source_weights), config, shape)
    mlx_config = build_mlx_adapter_config(config, shape)
    output_dir.mkdir(parents=True)
    output_weights = output_dir / "adapters.safetensors"
    output_config = output_dir / "adapter_config.json"
    save_file(
        {key: converted[key] for key in sorted(converted)},
        output_weights,
        metadata={"mosh_conversion": f"{CONVERTER_ID}:{_sha256(source_weights)}"},
    )
    _write_json(output_config, mlx_config)
    adapter_sha = _sha256(output_weights)
    config_sha = _sha256(output_config)
    source_hashes: dict[str, JsonValue] = {
        "adapter_model.safetensors": _sha256(source_weights),
        "adapter_config.json": _sha256(source_config_path),
        "base_model_config.json": _sha256(base_config_path),
    }
    source_run = source_dir / "sft_run.json"
    if source_run.is_file():
        source_hashes["sft_run.json"] = _sha256(source_run)
    manifest: JsonObject = {
        "schema_version": 1,
        "converter": CONVERTER_ID,
        "source": source_hashes,
        "base_model": {
            "name": config.base_model_name_or_path,
            "model_type": shape.model_type,
            "num_hidden_layers": shape.num_hidden_layers,
        },
        "adapter": {
            "rank": config.rank,
            "alpha": config.alpha,
            "scale": config.scale,
            "dropout": config.dropout,
            "layers": list(config.layers_to_transform),
            "target_modules": list(config.target_modules),
            "tensor_count": len(converted),
        },
        "outputs": {
            "adapters.safetensors": {"sha256": adapter_sha},
            "adapter_config.json": {"sha256": config_sha},
        },
    }
    _write_json(output_dir / "conversion_manifest.json", manifest)
    return ConversionResult(output_dir, adapter_sha, config_sha)


def main(
    source_dir: Annotated[Path, typer.Argument(help="PEFT adapter directory")],
    base_model_dir: Annotated[Path, typer.Argument(help="Local MLX base model directory")],
    output_dir: Annotated[Path, typer.Argument(help="New MLX adapter directory")],
) -> None:
    """Convert SOURCE_DIR without altering it or the quantized base model."""
    try:
        result = convert_adapter_directory(source_dir, base_model_dir, output_dir)
    except AdapterCompatibilityError as exc:
        Console(stderr=True).print(f"[red]conversion refused:[/red] {exc}")
        raise typer.Exit(code=2) from exc
    Console().print(
        f"[green]converted[/green] {result.output_dir}\n"
        f"adapters.safetensors sha256={result.adapter_sha256}\n"
        f"adapter_config.json sha256={result.config_sha256}"
    )


if __name__ == "__main__":
    typer.run(main)
