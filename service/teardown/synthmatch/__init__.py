"""§8 Synth patch-matching & substitution (refinement + substitute layer).

NOT a competing path to reading the screen — it's the error-correction on §5b's approximate
GUI read and the fallback for plugins you can't read / don't own. v1 is CMA-ES-style
optimization against the §6 oracle: render candidate params with the REAL synth, embed,
compare to the target tone, step. The optimizer + objective are here and testable against a
synthetic synth; the real render-in-the-loop is the §6 oracle (Mosh binary + hosted
Serum/Vital) and is gated on those. (The amortized per-synth estimator is deferred — speed,
not correctness.)
"""
from .optimize import SynthRenderer, evolve, match_patch  # noqa: F401
from .substitute import substitute  # noqa: F401
