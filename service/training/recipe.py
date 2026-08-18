"""Training recipe defaults — how long to train, and at what batch size.

Every number here is measured, not guessed. Sources: the 2026-08 local-training
round (pmetal `docs/training/stable-audio-3.md`), run on a 64GB M1 Max against
three real corpora.

**Epoch count is the dominant knob and it does NOT transfer between corpora.**
The same step count that under-trains one corpus over-trains another:

    corpus size   epochs that worked   evidence
    33 clips      ~145                 probe descended smoothly to the last step
    189 clips     ~44                  25 epochs scored 0.14 LOWER (undertrained)
    424 clips     ~11                  already near its cloud reference

So the default is interpolated on clip count, and it is a STARTING POINT the
producer is expected to override by ear — the same round found that a
25-epoch adapter had better character than a 44-epoch one that scored 0.14
higher, i.e. best-scoring is not best-sounding.

**Memory is a hard wall, not a preference.** Footprint is linear and was
measured at four points (22/31/40/49 GB at batch 1/2/3/4). Exceeding available
RAM does not fail loudly: macOS grows the swapfile and the run silently
thrashes — measured at 12.65 s/step versus ~1.1 s healthy, which is *worse
per sample than batch=1*. Hence the default is batch 2 x grad-accum 2
(effective batch 4 at ~31 GB), not a literal batch 4 (~49 GB), which only
works with every other app closed.

**The footprint below covers the TRAINER ONLY, and that is not the whole
picture once the LoRA Lab exists.** Auditioning a take mid-run makes the SA3
render model resident in the service alongside the trainer. Measured
2026-08-17 on the 64 GB reference machine: trainer at 26 GB, one audition
during the run, and free memory fell from 88% to 19% with swap going 2 GB ->
24 GB — the same silent thrash as an over-large batch, dropping a run that
should pace ~1.1 s/step to roughly 65 s/step. Nothing errors; the run just
becomes ~50x slower while looking healthy.

That is a real tension in the product, because "listen while it trains" is
exactly what the Lab is for. It is NOT yet handled here: `batch_plan` still
budgets for the trainer alone. The options, none of them free, are to reserve
render headroom in the plan (smaller batch, slower training, for everyone),
release the render model between auditions, or simply warn.

RESOLVED 2026-08-17: the release path shipped (`sa3.engine.unload` +
`sa3_release`), gated on a ~4 ms free-memory probe so it fires only when memory
is actually tight — 45% free while a run is active, 30% idle. Measured cost when
it does fire: **+1.1 s per audition**, returning 9.2 GB.
"""

from __future__ import annotations

import math
import os

# Footprint model, fit to four direct phys_footprint measurements. NOTE that
# MLX memory is invisible to RSS — `ps` reports ~1.2GB for a run using 22GB —
# so these came from `footprint -p <pid>`, and any re-measurement must too.
FIXED_GB = 13.0
PER_BATCH_ITEM_GB = 9.0

# Measured seconds/step at batch<=3 on the reference machine. Nearly flat in
# batch size (1.019/1.074/1.087 for 1/2/3) because the GPU is underfed —
# which is exactly why accumulation is cheap here.
SECONDS_PER_STEP = 1.1

# (clip_count, epochs) anchors from the measured table above.
_EPOCH_ANCHORS = [(33, 145.0), (189, 44.0), (424, 11.0)]


def epochs_for(clip_count: int) -> float:
    """Interpolate the measured epoch curve. Monotonically decreasing."""
    if clip_count <= _EPOCH_ANCHORS[0][0]:
        return _EPOCH_ANCHORS[0][1]
    if clip_count >= _EPOCH_ANCHORS[-1][0]:
        return _EPOCH_ANCHORS[-1][1]
    for (c0, e0), (c1, e1) in zip(_EPOCH_ANCHORS, _EPOCH_ANCHORS[1:]):
        if c0 <= clip_count <= c1:
            t = (clip_count - c0) / (c1 - c0)
            return e0 + t * (e1 - e0)
    return _EPOCH_ANCHORS[-1][1]


def footprint_gb(batch_size: int) -> float:
    """Estimated physical footprint of one training process."""
    return FIXED_GB + PER_BATCH_ITEM_GB * max(1, int(batch_size))


def physical_ram_gb() -> float:
    """Physical RAM, or 0.0 if it can't be determined (disables the check)."""
    try:
        import subprocess
        out = subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True,
                             text=True, timeout=5)
        return int(out.stdout.strip()) / (1 << 30)
    except Exception:  # noqa: BLE001
        return 0.0


def batch_plan(ram_gb: float | None = None) -> tuple[int, int]:
    """Pick (batch_size, grad_accum) for an effective batch of 4.

    Prefers the largest batch whose footprint stays under 70% of RAM — the
    threshold is bracketed by measurement, not chosen round: batch 3 (40GB =
    62.5% of 64GB) ran healthy at 1.087 s/step while batch 4 (49GB = 76.6%)
    thrashed. Accumulation makes up the rest of the effective batch, which is
    exact for mean-MSE over equal microbatches.
    """
    if ram_gb is None:
        ram_gb = physical_ram_gb()
    if ram_gb <= 0:
        return 2, 2  # unknown machine: the safe default
    limit = ram_gb * 0.70
    for batch in (4, 3, 2, 1):
        if footprint_gb(batch) <= limit and 4 % batch == 0:
            return batch, 4 // batch
    return 1, 4


def recommend_recipe(clip_count: int, ram_gb: float | None = None) -> dict:
    """The full default recipe for a corpus of `clip_count` clips.

    Returned from `/training/capabilities` so the UI never hardcodes the curve.
    """
    clip_count = max(1, int(clip_count))
    epochs = epochs_for(clip_count)
    batch, accum = batch_plan(ram_gb)
    effective = batch * accum
    steps = max(1, math.ceil(epochs * clip_count / effective))
    return {
        "epochs": round(epochs, 1),
        "steps": steps,
        "batchSize": batch,
        "gradAccum": accum,
        "effectiveBatch": effective,
        "footprintGb": round(footprint_gb(batch), 1),
        "estMinutes": round(steps * SECONDS_PER_STEP / 60.0, 1),
        "clipCount": clip_count,
        # Surfaced so the UI can be honest that this is a starting point.
        "note": "Epoch count does not transfer between corpora; audition checkpoints by ear.",
    }


def steps_for(clip_count: int, epochs: float, batch_size: int, grad_accum: int) -> int:
    """Steps needed for `epochs` passes over `clip_count` clips. UI override path."""
    effective = max(1, int(batch_size) * int(grad_accum))
    return max(1, math.ceil(float(epochs) * max(1, int(clip_count)) / effective))
