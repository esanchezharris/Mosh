"""How much memory is actually available, cheaply.

Used to decide whether to hand the SA3 render model's ~9.2 GB back after an
audition (see `sa3.engine.unload`). Measured cost: **~4 ms per call**, so it can
sit on the render path without thought.

## Why `memory_pressure` and not `vm_stat`

Both cost the same ~4 ms. The thresholds this feeds were calibrated against two
REAL observations on the 64 GB reference Mac — 88% free while a run paced
normally, 19% free while it thrashed at ~65 s/step — and both of those numbers
came from `memory_pressure`'s own "System-wide memory free percentage". A
`vm_stat`-derived figure is a different approximation (0.775 vs 0.870 on an idle
machine, measured), so swapping the source silently moves every threshold. If
you change the source, re-derive the thresholds; do not port the numbers.

## Why RSS is not an option

MLX memory is Metal-backed and invisible to RSS: `ps` reported **1.5 MB** for a
service holding a 9.2 GB model. Anything reasoning about this process's own
usage must use `footprint`, and anything reasoning about the machine must use a
system-wide source like this one.

Stdlib only.
"""

from __future__ import annotations

import subprocess
import time

# One probe per second is plenty: this gates a decision taken at most once per
# render, and a fresher number would not change the answer.
_CACHE_TTL_S = 1.0
_cache: tuple[float, float | None] = (0.0, None)


def available_fraction(force: bool = False) -> float | None:
    """Fraction of physical RAM available, 0..1. `None` when it cannot be read.

    `None` is a real answer and callers must handle it — see
    `sa3_release.should_release`, which resolves it differently depending on
    whether a training run is at stake."""
    global _cache
    now = time.monotonic()
    if not force and _cache[1] is not None and (now - _cache[0]) < _CACHE_TTL_S:
        return _cache[1]
    value = _read()
    _cache = (now, value)
    return value


def _read() -> float | None:
    try:
        out = subprocess.run(["memory_pressure"], capture_output=True,
                             text=True, timeout=5).stdout
    except Exception:  # noqa: BLE001 — not on macOS, or the tool is unavailable
        return None
    for line in out.splitlines():
        if "free percentage" in line:
            try:
                return float(line.rsplit(":", 1)[1].strip().rstrip("%")) / 100.0
            except (ValueError, IndexError):
                return None
    return None
