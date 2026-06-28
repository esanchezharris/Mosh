"""§6 render-and-compare oracle — the most-shared back-half component (§8/§9/§11/§12).

`render()` bounces a MoshOps command sequence to audio via the engine (`Mosh --run-script`
+ export); `score()` embeds + compares against a target. Rules baked in so every consumer
inherits them: loudness-normalize before scoring (closes the cheapest reward hack), a
fixed render window, cache by rendered-WAV hash, and a versioned scorer (swapped in-place
by §11's learned head later). The scorer starts as an embedding cosine.
"""
from .score import EmbeddingScorer, loudness_normalize  # noqa: F401
from .cache import RenderCache, wav_hash  # noqa: F401
from .render import Oracle  # noqa: F401
