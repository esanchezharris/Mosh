"""Pure-Python, stdlib-only prompt utilities for the generative service.

Currently exposes the deterministic prompt-concision rewriter (05 §6). These
helpers are standalone — they never touch the MoshOps command surface, the
adapters, the colors rack, or SA3.
"""
from . import concision  # noqa: F401
