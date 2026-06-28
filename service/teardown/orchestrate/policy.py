"""Confidence/yield gating thresholds for the conductor. Below a floor → stop and queue
for human review rather than emit a confident-but-wrong recipe. Escalation is explicit.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Policy:
    # overall yield below this → status 'needs_review' (don't claim a confident teardown)
    review_floor: float = 0.35
    # per-element confidence below this → the element is flagged unresolved for a later pass
    min_element_conf: float = 0.30
    # run §7 extraction (separation) to mine drums when the skeleton has none
    extract_when_no_drums: bool = True
