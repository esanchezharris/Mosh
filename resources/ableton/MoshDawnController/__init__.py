"""Ableton Live entry point for the Mosh DAWN controller."""

from __future__ import annotations

from .model import LiveCInstance


def create_instance(c_instance: LiveCInstance):
    """Create the controller lazily so non-Live tests can import the package."""
    from .surface import MoshDawnController

    return MoshDawnController(c_instance)
