#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["pydantic>=2"]
# ///
# ─── How to run ───
# Imported by verify-direct-reimagine.py; uses an isolated fixture project.
"""Keep separate split-clip render assets through Save As and reopen."""
from __future__ import annotations

import wave
from pathlib import Path

from direct_render_harness import Harness, command, digest, setup, snap, target


def split_persistence(harness: Harness, source: Path) -> None:
    # Given two halves copied from one kept layer, with a new result on the right.
    project = harness.evidence / "split-saved" / "split.mosh"
    project.parent.mkdir()
    exports = [harness.evidence / name for name in ("split-before.wav", "split-after.wav", "split-reopened.wav")]
    initial = [item for item in setup(source) if item["command"] != "trim_clip"]
    commands = initial + [target("render_layer", {"wait": True}), target("accept_render"),
        command("split_clip", {"clipId": "${C}", "time": 2}, {"RIGHT": "newClipId"}),
        command("rename_clip", {"clipId": "${RIGHT}", "name": "Right"}),
        command("set_render_param", {"clipId": "${RIGHT}", "seed": 1}),
        command("render_layer", {"clipId": "${RIGHT}", "wait": True}),
        command("accept_render", {"clipId": "${RIGHT}"}), snap("before_save")]
    for label, output in zip(("before", "after", "reopened"), exports, strict=True):
        if label == "after":
            commands += [command("save_as", {"file": str(project)}), snap("after_save")]
        if label == "reopened":
            commands += [command("new_project", {"name": "Disposable"}), command("open_project", {"file": str(project)}), snap("reopened")]
        commands += [command("export_audio", {"file": str(output), "range": "custom", "start": 0, "end": 4,
                                                "tail": "cut", "sampleRate": 44100, "bitDepth": 16})]
    # When saving and reopening. Then each owning clip retains its own audio identity.
    run = harness.run("split_persistence", commands)
    run.passed()
    before = run.snapshot("before_save")
    left, right = before.clip(), before.clip("Right")
    assert left.renderLayer is not None and right.renderLayer is not None
    assert digest(Path(left.sourceFile)) != digest(Path(right.sourceFile))
    assert right.renderLayer.sourceStart == 2
    for label in ("after_save", "reopened"):
        for clip in (left, right):
            restored = run.snapshot(label).clip(clip.name)
            assert digest(Path(restored.sourceFile)) == digest(Path(clip.sourceFile)), (label, clip.name, run.directory)
            assert restored.offset == clip.offset
    with wave.open(str(exports[0]), "rb") as original:
        expected = original.readframes(original.getnframes())
    for output in exports[1:]:
        with wave.open(str(output), "rb") as audio:
            assert audio.readframes(audio.getnframes()) == expected
