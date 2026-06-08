"""Generative model adapters for the Mosh service.

Each adapter conforms to a common interface so the HTTP layer in ``server.py``
stays model-agnostic. The dependency-free ``FakeAdapter`` is always importable;
``StableAudio3Adapter`` (CUDA / torch / stable_audio_3) is imported LAZILY via
``load_adapter`` so the Fake/CI path never pulls in the heavy stack.
"""

from .fake_adapter import FakeAdapter

__all__ = ["FakeAdapter", "load_adapter"]


def load_adapter(name: str):
    """Return an adapter instance by name. Imports heavy deps only when needed.

    ``"fake"`` (default) → FakeAdapter (stdlib only).
    ``"stable_audio_3"`` → StableAudio3Adapter (torch + stable_audio_3, CUDA).
    """
    key = (name or "fake").strip().lower()
    if key in ("fake", "", "stub"):
        return FakeAdapter()
    if key in ("stable_audio_3", "sa3", "stableaudio3"):
        from .stable_audio3_adapter import StableAudio3Adapter
        return StableAudio3Adapter()
    raise ValueError(f"unknown MOSH_ADAPTER '{name}' (expected 'fake' or 'stable_audio_3')")
