#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["pydantic>=2"]
# ///
# ─── How to run ───
# Imported by verify-direct-reimagine.py; uses its isolated fixture harness.
from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, ConfigDict

from direct_render_harness import Harness, command, digest, setup, snap, target


class SubmittedControls(BaseModel):
    model_config = ConfigDict(frozen=True, strict=True)
    seed: int
    nl: float


def reopen_controls(harness: Harness, source: Path) -> None:
    for seed, amount in ((0, 0.4), (37, 0.23)):
        # Given a kept render saved as XML, then a completely new app process.
        project = harness.evidence / f"reopen-controls-{seed}" / "kept.mosh"
        project.parent.mkdir()
        prepared = harness.run(f"reopen_prepare_{seed}", setup(source) + [
            target("set_render_param", {"seed": seed, "nl": amount}),
            target("render_layer", {"wait": True}), target("accept_render"),
            command("save_as", {"file": str(project)}), snap("saved")])
        prepared.passed()
        kept = prepared.snapshot("saved").clip()
        kept_hash = digest(Path(kept.sourceFile))
        clip_args = {"clipId": kept.id}
        reopened = harness.run(f"reopen_generate_{seed}", [
            command("open_project", {"file": str(project)}), snap("reopened"),
            command("bypass_layer", {**clip_args, "audition": "result"}), snap("auditioned"),
            command("bypass_layer", {**clip_args, "audition": "committed"}),
            # The drawer resends unchanged numeric controls when only prompt changes.
            command("set_render_param", {**clip_args, "prompt": "A different fixture prompt.",
                                         "seed": seed, "nl": amount}),
            command("render_layer", {**clip_args, "wait": True}), snap("pending"),
            command("accept_render", clip_args), snap("kept_again"), command("save")])
        # When the reopened drawer auditions and generates again with unchanged numbers.
        reopened.passed()
        # Then a real fixture job completes, retaining the exact selected controls.
        pending = reopened.snapshot("pending").clip()
        assert pending.renderLayer is not None and pending.renderLayer.hasPending
        assert pending.renderLayer.status == "ready" and pending.renderLayer.testFixture
        assert pending.renderLayer.seed == seed and pending.renderLayer.nl == amount
        received = reopened.directory / f"request-{pending.renderLayer.requestId}.json"
        controls = SubmittedControls.model_validate_json(received.read_text())
        assert controls.seed == seed and controls.nl == amount
        assert digest(Path(pending.sourceFile)) == kept_hash
        restored = reopened.snapshot("reopened").clip()
        assert restored.renderLayer is not None and restored.renderLayer.userKept
        assert restored.renderLayer.seed == seed and restored.renderLayer.nl == amount
        auditioned = reopened.snapshot("auditioned").clip()
        assert auditioned.renderLayer is not None and auditioned.renderLayer.audition == "result"
        assert digest(Path(auditioned.sourceFile)) == kept_hash
        accepted = reopened.snapshot("kept_again").clip()
        assert accepted.renderLayer is not None and accepted.renderLayer.userKept
        assert not accepted.renderLayer.hasPending
        assert digest(source) == digest(Path(prepared.snapshot("before").clip().sourceFile))
        final = harness.run(f"reopen_kept_again_{seed}", [
            command("open_project", {"file": str(project)}), snap("restored")], "unavailable")
        final.passed()
        restored_again = final.snapshot("restored").clip()
        assert restored_again.renderLayer is not None and restored_again.renderLayer.userKept
        assert digest(Path(restored_again.sourceFile)) == digest(Path(accepted.sourceFile))
        assert not (final.directory / "service-started.pid").exists()
