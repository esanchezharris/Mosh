"""SA3 training precompute — clips + captions → latents + conditioning on disk.

Phase 1 of a local LoRA training job. The trainer (`pmetal train-audio`) does
not touch audio: it consumes a manifest of pre-encoded VAE latents and raw
T5Gemma conditioning, so every clip is encoded exactly once instead of once
per epoch.

**Why this is a port and not a subprocess.** The reference implementation is
`scripts/sa3_precompute/precompute.py` in the pmetal repo, which loads T5Gemma,
the conditioner and the SAME-L encoder itself. Mosh's service already runs
under that same MLX venv and `sa3.engine` holds all three models warm — so
shelling out would load ~3GB of models a second time, in a second process,
for no benefit. This drives the live engine instead.

**Output layout** (must match pmetal's `Sa3DataLoader::from_manifest`):

    <out_dir>/manifest.json          list of records (see `_record`)
    <out_dir>/tensors/<id>.safetensors   {latent, cross_attn_cond_raw, global_cond_raw}

Tensors carry NO batch dimension: latent `(256, T_lat)`, cross-attn
`(257, 768)`, global `(768,)`.

**The two silent-failure traps** (both guarded by
`sa3_precompute_parity_test.py`, which diffs this against pmetal's own script):

  1. `T_lat` is per-clip, not the engine's fixed render grid.
  2. `seconds_total` is the clip's REAL pre-padding duration.

Either one wrong yields an adapter that trains with a healthy-looking loss
curve and is simply wrong — so the parity test is not optional.
"""

from __future__ import annotations

import json
import os
from typing import Any, Callable, Iterable

_PROGRESS_EVERY = 1


def _record(sample_id: str, prompt: str, seconds: float, t_lat: int,
            tensor_rel: str, source_wav: str, sums: dict[str, float]) -> dict[str, Any]:
    """One manifest row. Field names are pmetal's loader contract — do not rename.

    The `*_sum` fields are cheap integrity witnesses: the trainer logs them, so a
    corrupted or mis-encoded tensor shows up as a number that moved rather than as
    a mysteriously bad adapter.
    """
    return {
        "id": sample_id,
        "prompt": prompt,
        "duration_seconds": round(float(seconds), 6),
        "t_lat": int(t_lat),
        "tensor_file": tensor_rel,
        "source_wav": source_wav,
        "latent_sum": sums["latent"],
        "cross_attn_cond_raw_sum": sums["cross"],
        "global_cond_raw_sum": sums["global"],
    }


def precompute(
    clips: Iterable[dict[str, Any]],
    out_dir: str,
    engine: Any | None = None,
    on_progress: Callable[[int, int, str], None] | None = None,
) -> dict[str, Any]:
    """Encode `clips` into `out_dir`. Returns `{manifest_path, count, skipped}`.

    `clips` is an iterable of `{"id": str, "wav": path, "caption": str}`.
    The caption is the prompt the adapter learns to answer; an empty one is
    accepted but weakens the adapter, so it is reported in `skipped`-adjacent
    telemetry rather than silently tolerated.

    `engine` defaults to the live singleton. Injectable so the parity test can
    drive it directly.
    """
    if engine is None:
        from sa3 import engine as E  # local import: service may run without SA3
        engine = E.get_engine()

    import mlx.core as mx

    tensors_dir = os.path.join(out_dir, "tensors")
    os.makedirs(tensors_dir, exist_ok=True)

    clips = list(clips)
    total = len(clips)
    manifest: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []

    for i, clip in enumerate(clips):
        sample_id = str(clip.get("id") or f"clip_{i:04d}")
        wav = os.path.expanduser(str(clip.get("wav", "")))
        caption = str(clip.get("caption") or "").strip()

        if not wav or not os.path.exists(wav):
            skipped.append({"id": sample_id, "reason": f"missing audio: {wav or '(none)'}"})
            continue

        try:
            latent, seconds = engine.encode_for_training(wav)
            cross, glob = engine.cond_for_training(caption, seconds)
            mx.eval(latent, cross, glob)
        except Exception as exc:  # noqa: BLE001 — one bad clip must not kill the run
            skipped.append({"id": sample_id, "reason": f"encode failed: {exc}"})
            continue

        t_lat = int(latent.shape[-1])
        tensor_rel = f"tensors/{sample_id}.safetensors"
        mx.save_safetensors(
            os.path.join(out_dir, tensor_rel),
            {"latent": latent, "cross_attn_cond_raw": cross, "global_cond_raw": glob},
            metadata={
                "sample_id": sample_id,
                "prompt": caption,
                "duration_seconds": f"{seconds:.6f}",
                "t_lat": str(t_lat),
            },
        )
        sums = {
            "latent": float(mx.abs(latent.astype(mx.float32)).sum().item()),
            "cross": float(mx.abs(cross.astype(mx.float32)).sum().item()),
            "global": float(mx.abs(glob.astype(mx.float32)).sum().item()),
        }
        manifest.append(_record(sample_id, caption, seconds, t_lat, tensor_rel, wav, sums))

        if on_progress and (i % _PROGRESS_EVERY == 0 or i == total - 1):
            on_progress(i + 1, total, sample_id)

    manifest_path = os.path.join(out_dir, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    return {"manifest_path": manifest_path, "count": len(manifest), "skipped": skipped}
