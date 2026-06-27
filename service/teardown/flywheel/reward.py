"""§12 reward → RL bridge — the ONLY surface the GRPO loop imports.

Floor + pull: FLOOR keeps audio from being broken/amateur (Audiobox PQ + DSP guards via
service/quality_readout, loudness-normalized first — the cheapest reward hack closed); PULL
drags toward "sounds like good music" (the §11 head, injected). composite() is a conservative
aggregation that gates on validity. PromptFeed serves guaranteed-renderable, teardown-seeded
command sequences (from §9). The GRPO trainer itself lives in the audio-taste RL handoff.
"""
from __future__ import annotations

from typing import Callable, Optional

import numpy as np

from ..oracle.score import loudness_normalize


class Reward:
    def __init__(self, pull: Optional[Callable[[np.ndarray, int], float]] = None,
                 version: str = "reward-v0", target_rms_dbfs: float = -20.0) -> None:
        self.pull = pull                      # (audio, sr) → 0..1 music-quality / exemplar proximity
        self.version = version
        self.target_rms_dbfs = target_rms_dbfs

    def _floor(self, y: np.ndarray, sr: int) -> dict:
        """Production-quality floor — Audiobox PQ via service/quality_readout when available,
        else a DSP-lite clip/silence guard."""
        try:
            import quality_readout as qr  # service/ is on sys.path
            r = qr.analyze_array(np.asarray(y, dtype=np.float32), sr)
            return {"pq": float(r.get("pq", 0.0)), "clean": 0.0 if r.get("flags") else 1.0}
        except Exception:
            yy = np.asarray(y, dtype=np.float64)
            peak = float(np.max(np.abs(yy))) if yy.size else 0.0
            rms = float(np.sqrt(np.mean(yy ** 2))) if yy.size else 0.0
            broken = (peak > 0.999) or (rms < 1e-4)
            return {"pq": 0.0 if broken else 6.0, "clean": 0.0 if broken else 1.0}

    def score_audio(self, y, sr: int) -> dict[str, float]:
        yn = loudness_normalize(np.asarray(y, dtype=np.float32), sr, self.target_rms_dbfs)
        scores = self._floor(yn, sr)
        if self.pull is not None:
            scores["pull"] = float(self.pull(yn, sr))
        return scores

    def composite(self, scores: dict[str, float]) -> float:
        """Standardized, conservative aggregation. clean==0 (broken/amateur) → 0."""
        pq = max(0.0, min(1.0, scores.get("pq", 0.0) / 10.0))
        clean = scores.get("clean", 1.0)
        pull = scores.get("pull", pq)
        return round(clean * (0.5 * pq + 0.5 * pull), 4)


class PromptFeed:
    """Guaranteed-renderable, teardown-seeded MoshOps command sequences (from §9) — the RL
    prompt distribution (fixes the handoff's 'mixing ops on empty tracks render to silence')."""

    def __init__(self, prompts: list) -> None:
        self._prompts = list(prompts)

    def renderable_prompts(self, n: int) -> list:
        return self._prompts[: max(0, n)]
