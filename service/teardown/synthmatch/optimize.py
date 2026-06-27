"""Black-box patch optimization. `evolve` is a self-adapting (1,λ)-ES around the current best
(no VST gradients, no extra dep; `cma` can drop in later for harder spaces). `match_patch`
wraps it: objective = perceptual distance (the §6 scorer) between the target tone and the
synth's render of candidate params. The renderer is injected — synthetic for tests, the §6
oracle (real hosted synth) in production.
"""
from __future__ import annotations

from typing import Callable, Optional, Protocol

import numpy as np


class SynthRenderer(Protocol):
    def render(self, params: dict) -> tuple[np.ndarray, int]: ...


def evolve(objective: Callable[[np.ndarray], float], x0, bounds, iters: int = 60,
           popsize: int = 8, seed: int = 0):
    """Minimize `objective` over box `bounds`. Returns (best_x, best_f, history)."""
    rng = np.random.default_rng(seed)
    lo = np.array([b[0] for b in bounds], float)
    hi = np.array([b[1] for b in bounds], float)
    rng_span = hi - lo
    best_x = np.clip(np.array(x0, float), lo, hi)
    best_f = float(objective(best_x))
    sigma = 0.25 * rng_span
    history = [best_f]
    for _ in range(iters):
        pop = np.clip(best_x + sigma * rng.standard_normal((popsize, best_x.size)), lo, hi)
        fs = [float(objective(p)) for p in pop]
        i = int(np.argmin(fs))
        if fs[i] < best_f:
            best_f, best_x = fs[i], pop[i]
            sigma = np.minimum(sigma * 1.15, rng_span)          # success → expand
        else:
            sigma = np.maximum(sigma * 0.9, 1e-4 * rng_span)    # stall → contract (1/5-rule-ish)
        history.append(best_f)
    return best_x, best_f, history


def match_patch(target, renderer: SynthRenderer, scorer, param_names: list[str], bounds,
                seed_params: Optional[dict] = None, iters: int = 60, popsize: int = 8,
                seed: int = 0, restarts: int = 1) -> dict:
    """Recover params whose render best matches `target` (an (audio, sr) tuple) in the §6
    embedding space. Seeds from §5b's GUI read when given, else box-centre; multi-restart."""
    def objective(x: np.ndarray) -> float:
        y, sr = renderer.render(dict(zip(param_names, [float(v) for v in x])))
        return scorer.score((y, sr), target)

    centre = [(b[0] + b[1]) / 2 for b in bounds]
    x0 = [seed_params[n] for n in param_names] if seed_params else centre
    best = None
    for r in range(max(1, restarts)):
        start = x0 if r == 0 else [np.random.default_rng(seed + r).uniform(b[0], b[1]) for b in bounds]
        bx, bf, hist = evolve(objective, start, bounds, iters, popsize, seed=seed + r)
        if best is None or bf < best[1]:
            best = (bx, bf, hist)
    bx, bf, hist = best
    return {"params": dict(zip(param_names, [round(float(v), 5) for v in bx])),
            "distance": round(float(bf), 5), "iters": iters, "history": [round(h, 5) for h in hist]}
