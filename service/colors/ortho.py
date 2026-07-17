"""Colour-axis orthogonalization (pure numpy) — de-correlate steering vectors that
share a `peak_layer` so a stack composes cleanly instead of fighting itself.

Steers on the SAME layer add linearly to the residual stream
(`x + a1*v1 + a2*v2`, see `service/sa3/guest/dit_mlx_medium.py`), so correlated
same-layer vectors mud each other. `orthogonalize_group` replaces a same-layer
group with the closest MUTUALLY ORTHOGONAL set via **symmetric (Löwdin)**
orthogonalization — no colour is privileged (unlike Gram-Schmidt's "first vector
wins") and the total rotation is minimized. Each vector keeps its ORIGINAL L2
norm, so the per-colour `astd_max` ceilings stay ~valid.

Operates on the RAW stored vectors (polarity `more_sign` is applied later via the
alpha, and orthogonality is sign-invariant, so decoupling them is correct).
Runtime opt-in only — `resolve_steers(orthogonalize=...)` gates it; the default
path never calls this. Cross-layer interference is nonlinear and out of scope.
"""
from __future__ import annotations

import numpy as np

# The overlap matrix is built from UNIT directions, so its eigenvalues live in
# (0, k]. A group with two near-collinear axes drives the smallest eigenvalue to
# 0 (S^-1/2 blows up) — below this floor we pass the group through untouched
# rather than emit a wild rotation.
_MIN_EIG = 1e-6


def orthogonalize_group(vecs: list[np.ndarray]) -> list[np.ndarray]:
    """Return a norm-preserving, mutually-orthogonal version of `vecs` (same order,
    same count, same dtype). A group of <2 vectors, or one whose unit-direction
    overlap is ill-conditioned (near-collinear axes), is returned UNCHANGED
    (identical arrays — the caller can rely on identity for the no-op case)."""
    if len(vecs) < 2:
        return list(vecs)

    dtype = vecs[0].dtype
    V = np.stack([np.asarray(v, dtype=np.float64) for v in vecs], axis=1)   # (D, k)
    norms = np.linalg.norm(V, axis=0)                                        # (k,)
    if np.any(norms == 0.0):
        return list(vecs)                                                    # a zero axis → leave alone

    U = V / norms                                                            # unit columns
    S = U.T @ U                                                              # (k, k) overlap, symmetric PSD
    evals, evecs = np.linalg.eigh(S)
    if float(evals.min()) < _MIN_EIG:                                        # near-collinear → don't force it
        return list(vecs)

    # S^{-1/2} = Q Λ^{-1/2} Qᵀ (sign-invariant → deterministic). U·S^{-1/2} has
    # orthonormal columns closest (Frobenius) to U; rescale each to its own norm.
    s_inv_sqrt = evecs @ np.diag(1.0 / np.sqrt(evals)) @ evecs.T
    Uo = U @ s_inv_sqrt                                                      # orthonormal columns
    Vo = Uo * norms                                                          # restore per-axis magnitude
    return [Vo[:, i].astype(dtype) for i in range(Vo.shape[1])]
