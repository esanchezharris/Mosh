"""§1 Drum-sample vector matcher — embed the owner's one-shot library, return the
perceptually-nearest samples they OWN (so recipes reference your samples, never the
tutorial's copyrighted audio).

Two embedders behind one interface: `EngineeredEmbedder` (librosa/numpy, always
available — the spec's competitive baseline + fallback) and `ClapEmbedder` (gated
behind the teardown venv, like SA3/transform). The index standardizes + L2-normalizes
and does cosine NN; faiss is an optional accelerator, brute-force numpy is the default.
"""
from .embed import EngineeredEmbedder, ClapEmbedder, load_audio, LoadedAudio, SR  # noqa: F401
from .roles import classify_role  # noqa: F401
from .index import SampleIndex, DrumMatcher, Match, IndexStats  # noqa: F401
