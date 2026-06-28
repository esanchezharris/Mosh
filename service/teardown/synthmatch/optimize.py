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


def evolve(objective: Optional[Callable[[np.ndarray], float]], x0, bounds, iters: int = 60,
           popsize: int = 8, seed: int = 0,
           batch_objective: Optional[Callable[[np.ndarray], list]] = None):
    """Minimize over box `bounds`. Returns (best_x, best_f, history).

    Supply EITHER a per-individual `objective(x)->float` (synthetic/cheap), OR a
    `batch_objective(X)->list[float]` that scores a whole (m,d) population in one shot —
    the live path uses the latter so each generation is a single engine launch (one synth
    instance, params swept), which is what makes CMA-ES against a real VST tractable."""
    if objective is None and batch_objective is None:
        raise ValueError("evolve needs objective or batch_objective")

    def eval_pop(X: np.ndarray) -> list:
        if batch_objective is not None:
            return [float(v) for v in batch_objective(X)]
        return [float(objective(p)) for p in X]

    rng = np.random.default_rng(seed)
    lo = np.array([b[0] for b in bounds], float)
    hi = np.array([b[1] for b in bounds], float)
    rng_span = hi - lo
    best_x = np.clip(np.array(x0, float), lo, hi)
    best_f = eval_pop(best_x[None, :])[0]
    sigma = 0.25 * rng_span
    history = [best_f]
    for _ in range(iters):
        pop = np.clip(best_x + sigma * rng.standard_normal((popsize, best_x.size)), lo, hi)
        fs = eval_pop(pop)
        i = int(np.argmin(fs))
        if fs[i] < best_f:
            best_f, best_x = fs[i], pop[i]
            sigma = np.minimum(sigma * 1.15, rng_span)          # success → expand
        else:
            sigma = np.maximum(sigma * 0.9, 1e-4 * rng_span)    # stall → contract (1/5-rule-ish)
        history.append(best_f)
    return best_x, best_f, history


def match_patch(target, renderer: Optional[SynthRenderer], scorer, param_names: list,
                bounds, seed_params: Optional[dict] = None, iters: int = 60, popsize: int = 8,
                seed: int = 0, restarts: int = 1,
                batch_render: Optional[Callable[[list], list]] = None) -> dict:
    """Recover params whose render best matches `target` (an (audio, sr) tuple) in the §6
    embedding space. Seeds from §5b's GUI read when given, else box-centre; multi-restart.

    Pass `batch_render(list[dict]) -> list[(audio,sr)]` (e.g. LiveSynthRenderer.render_batch)
    to evaluate each generation in ONE engine launch — the real-synth path. Otherwise the
    per-candidate `renderer.render` is used (synthetic tests)."""
    def objective(x: np.ndarray) -> float:
        y, sr = renderer.render(dict(zip(param_names, [float(v) for v in x])))
        return scorer.score((y, sr), target)

    def batch_objective(X: np.ndarray) -> list:
        dicts = [dict(zip(param_names, [float(v) for v in row])) for row in X]
        renders = batch_render(dicts)
        return [scorer.score(r, target) for r in renders]

    obj = None if batch_render is not None else objective
    bobj = batch_objective if batch_render is not None else None

    centre = [(b[0] + b[1]) / 2 for b in bounds]
    x0 = [seed_params[n] for n in param_names] if seed_params else centre
    best = None
    for r in range(max(1, restarts)):
        start = x0 if r == 0 else [np.random.default_rng(seed + r).uniform(b[0], b[1]) for b in bounds]
        bx, bf, hist = evolve(obj, start, bounds, iters, popsize, seed=seed + r,
                              batch_objective=bobj)
        if best is None or bf < best[1]:
            best = (bx, bf, hist)
    bx, bf, hist = best
    return {"params": dict(zip(param_names, [round(float(v), 5) for v in bx])),
            "distance": round(float(bf), 5), "iters": iters, "history": [round(h, 5) for h in hist]}
