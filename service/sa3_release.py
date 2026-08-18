"""When to hand the SA3 render model's memory back after an audition.

Pure decision logic, kept out of `server.py` so the thresholds and their
asymmetry can be tested without a service, a model, or 9 GB of RAM.

## The measurements this encodes (64 GB reference Mac, 2026-08-17)

    SA3 render model resident      9.2 GB   (service 30 MB -> 9,168 MB)
    trainer @ batch 2              26-31 GB
    together                       35-40 GB = 55-63% of 64 GB
    the measured thrash wall       70% used

So trainer + auditioning FITS on a clean machine. What tipped a real run over
was ~17 GB of ordinary desktop (two editors, another Mosh, WindowServer): free
fell 88% -> 19%, swap 2 GB -> 24 GB, and the run went from ~1.1 s/step to
~65 s/step **silently** — macOS grows the swapfile rather than failing.

Releasing costs a measured **+1.1 s** on the next audition — steady state
2.8 s with the model held vs 3.9 s releasing between takes, A/B'd 3 samples each
in one process. (An earlier +3.6 s figure compared a cold PROCESS to a warm one
and so also charged Python startup and a cold page cache.) MLX genuinely returns
the memory: 5,935 MB -> 451 MB after dropping the engine and `mx.clear_cache()`,
and the service's live footprint drops 9,168 MB -> ~80 MB between takes.

## Why two thresholds and not one

The downside is wildly asymmetric.

  * Training active: not releasing risks a ~50x slowdown on a run that may be
    over an hour. Releasing costs 1.1 s. So act EARLY, with margin — at 45%
    free rather than waiting for the wall, because the trainer's demand is
    steady and already counted in that figure.
  * No training: the only cost of being wrong is a slower render. Nothing else
    is competing, so hold the model until memory is genuinely tight (30% free,
    i.e. the measured wall) and keep auditions fast.

An unreadable probe is resolved the same way: with a run at stake, release (pay
1.1 s rather than gamble an hour); otherwise keep the model.
"""

from __future__ import annotations

import os


def _env(name: str, default: float) -> float:
    """Overridable because the right number is machine-dependent: these were fit
    to a 64 GB Mac where the trainer is ~40% of RAM, and on a 128 GB box the same
    absolute headroom is a much smaller fraction."""
    try:
        return max(0.0, min(1.0, float(os.environ[name])))
    except (KeyError, ValueError):
        return default


# Free-memory fractions, not used-memory — matches `memprobe.available_fraction`.
RELEASE_BELOW_TRAINING = _env("MOSH_SA3_RELEASE_TRAINING", 0.45)
RELEASE_BELOW_IDLE = _env("MOSH_SA3_RELEASE_IDLE", 0.30)


def should_release(available: float | None, training_active: bool) -> bool:
    """Release the render model now?

    `available` is `memprobe.available_fraction()` — `None` when unreadable.
    """
    if available is None:
        # Unknown. With a training run at stake the expected cost of guessing
        # wrong is minutes-to-hours in one direction and 3.6 s in the other.
        return training_active
    return available < (RELEASE_BELOW_TRAINING if training_active else RELEASE_BELOW_IDLE)


def explain(available: float | None, training_active: bool) -> str:
    """One line for the service log — a released model is otherwise an
    unexplained 3.6 s on the next take."""
    where = "training active" if training_active else "idle"
    if available is None:
        return f"memory unreadable, {where} -> {'release' if training_active else 'keep'}"
    limit = RELEASE_BELOW_TRAINING if training_active else RELEASE_BELOW_IDLE
    verb = "release" if available < limit else "keep"
    return f"{available*100:.0f}% free (limit {limit*100:.0f}%, {where}) -> {verb}"
