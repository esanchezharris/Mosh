"""The ablation engine — the load-bearing mechanism. From a reconstruction's isolated
element stems, generate paired data by controlled edits that change ONE musical decision
while holding the production surface ~constant (swap a stem for a §1 near-neighbor). 1 swap →
`near`, 2 swaps → `far`: a KNOWN ordering (fewer changes ⇒ closer to the reference) that
forces the reward onto the MUSICAL axis (negatives differ only in a musical choice, not in
loudness/spectrum/fidelity). Constrain edits to stay musically coherent.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import numpy as np


@dataclass
class Triplet:
    ref: np.ndarray    # the original reconstruction mix
    near: np.ndarray   # one element swapped
    far: np.ndarray    # two elements swapped
    sr: int
    swapped: tuple     # (role_near, role_far)


class AblationEngine:
    def __init__(self, swap_fn: Callable[[np.ndarray, str], np.ndarray]) -> None:
        """swap_fn(stem_audio, role) → a near-neighbour stem (e.g. a §1 nearest sample)."""
        self.swap = swap_fn

    @staticmethod
    def mix(stems: dict[str, np.ndarray]) -> np.ndarray:
        if not stems:
            return np.zeros(1, np.float32)
        n = max(len(s) for s in stems.values())
        m = np.zeros(n, np.float32)
        for s in stems.values():
            m[: len(s)] += s
        peak = float(np.max(np.abs(m)))
        return (m / peak if peak > 0 else m).astype(np.float32)

    def make_triplet(self, stems: dict[str, np.ndarray], roles_to_swap, sr: int = 44100) -> Triplet:
        r0, r1 = roles_to_swap[0], roles_to_swap[1]
        ref = self.mix(stems)
        near_stems = dict(stems)
        near_stems[r0] = self.swap(stems[r0], r0)
        far_stems = dict(near_stems)
        far_stems[r1] = self.swap(stems[r1], r1)
        return Triplet(ref=ref, near=self.mix(near_stems), far=self.mix(far_stems), sr=sr, swapped=(r0, r1))
