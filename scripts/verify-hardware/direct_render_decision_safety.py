#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["pydantic>=2"]
# ///
# ─── How to run ───
# Imported by verify-direct-reimagine.py; no inference runs in these fixtures.
"""Closing monitoring or persisting must cancel pending audition validation."""
from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict

from direct_render_harness import Harness, command, setup, snap, target


class QueuedDecision(BaseModel):
    model_config = ConfigDict(frozen=True)
    status: Literal["queued"]
    requestId: str


def cancel_pending_audition(harness: Harness, source: Path) -> None:
    # Given a queued Result identity check. When monitoring closes or audio is saved.
    for name, boundary in (("close", target("bypass_layer", {"audition": "committed"})),
                           ("save", command("save")),
                           ("export", command("export_audio", {"file": str(harness.evidence / "cancel-audition-export.wav"),
                               "range": "custom", "start": 0, "end": 2, "tail": "cut"}))):
        run = Harness(harness.binary, harness.evidence, settle_decisions=False).run("cancel_audition_" + name,
            setup(source) + [target("render_layer", {"wait": True}), target("bypass_layer", {"audition": "result"}),
                boundary, command("__wait", {"ms": 2000}), snap("after")])
        run.passed()
        queued = QueuedDecision.model_validate(next(row.data for row in run.results if row.command == "bypass_layer"))
        assert queued.requestId
        # Then the late validation cannot activate Result monitoring or consume pending audio.
        clip = run.snapshot("after").clip()
        assert clip.sourceFile == run.snapshot("before").clip().sourceFile
        assert clip.renderLayer is not None
        assert clip.renderLayer.status == "ready" and clip.renderLayer.hasPending
        assert clip.renderLayer.audition == "committed"
