"""Generative model adapters for the Mosh service.

Each adapter conforms to a common interface so the HTTP layer in ``server.py``
stays model-agnostic. Stage 0 only requires the dependency-free ``FakeAdapter``.
"""

from .fake_adapter import FakeAdapter

__all__ = ["FakeAdapter"]
