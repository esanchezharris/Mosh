#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["pydantic>=2"]
# ///
# ─── How to run ───
# With the installed local service Python (no downloads):
# python verify-direct-reimagine.py /absolute/path/to/Mosh /absolute/evidence/directory
# All renders are deterministic fixtures, never SA3 model evidence.
"""Verify explicit Re-Imagine decisions through the real native command seam."""
from __future__ import annotations

import json
import subprocess
import sys
import threading
import time
import wave
from pathlib import Path

from direct_render_harness import Command, Harness, Layer, Run, command, digest, setup, snap, target, tone


def layer(run: Run, label: str) -> Layer:
    result = run.snapshot(label).clip().renderLayer
    assert result is not None, label
    return result


def export(path: Path) -> Command:
    return command("export_audio", {"file": str(path), "range": "custom", "start": 0, "end": 2,
                                    "tail": "cut", "sampleRate": 44100, "bitDepth": 16})


def decisions(harness: Harness, source: Path) -> None:
    # Given one trimmed target and an unrelated track with its own mix setting.
    project = harness.evidence / "saved" / "explicit.mosh"
    project.parent.mkdir()
    before, kept, reopened = (harness.evidence / name for name in ("source.wav", "kept.wav", "reopened.wav"))
    commands = setup(source) + [target("render_layer", {"wait": True}), snap("pending"),
        target("bypass_layer", {"audition": "result"}), snap("audition"), export(before), snap("export_restored"),
        target("bypass_layer", {"audition": "source"}), snap("source_audition"), target("accept_render"), snap("kept"),
        command("undo"), snap("undo_keep"), command("redo"), snap("redo_keep"), export(kept),
        target("set_render_param", {"seed": 1}), target("render_layer", {"wait": True}), snap("pending_again"),
        target("bypass_layer", {"audition": "result"}), command("save_as", {"file": str(project)}), snap("saved"),
        target("reject_render"), snap("rejected"), command("undo"), snap("undo_reject"),
        target("reject_render"), command("save"), command("new_project", {"name": "Empty disposable"}),
        command("open_project", {"file": str(project)}), snap("reopened"), export(reopened),
        target("remove_render_layer"), snap("removed"), command("undo"), snap("undo_remove")]
    # When generation, audition, decisions and persistence execute through MoshOps.
    run = harness.run("decisions", commands)
    run.passed()
    # Then pending playback, source integrity, undo and stored export remain correct.
    original = run.snapshot("before").clip()
    pending = run.snapshot("pending").clip()
    assert pending.sourceFile == original.sourceFile and layer(run, "pending").hasPending
    assert layer(run, "pending").testFixture and layer(run, "pending").sourceStart == 1
    assert layer(run, "pending").sourceDuration == 2
    auditioned = run.snapshot("audition").clip()
    assert auditioned.sourceFile != original.sourceFile and auditioned.offset == 0
    assert run.snapshot("export_restored").clip().sourceFile == original.sourceFile
    assert run.snapshot("source_audition").clip().offset == 1
    committed = run.snapshot("kept").clip()
    assert digest(Path(committed.sourceFile)) == digest(Path(auditioned.sourceFile))
    assert not layer(run, "kept").hasPending and run.snapshot("undo_keep").clip().sourceFile == original.sourceFile
    assert layer(run, "undo_keep").hasPending and run.snapshot("redo_keep").clip().sourceFile == committed.sourceFile
    for label in ("pending_again", "saved", "rejected", "undo_reject", "reopened"):
        assert digest(Path(run.snapshot(label).clip().sourceFile)) == digest(Path(committed.sourceFile)), label
    assert layer(run, "saved").hasPending and layer(run, "saved").audition == "committed"
    assert not layer(run, "rejected").hasPending and layer(run, "undo_reject").hasPending
    assert run.snapshot("removed").clip().renderLayer is None
    assert digest(Path(run.snapshot("removed").clip().sourceFile)) == digest(source)
    assert digest(Path(run.snapshot("undo_remove").clip().sourceFile)) == digest(Path(committed.sourceFile))
    unrelated = next(track for track in run.snapshot("before").tracks if track.name == "Unrelated Track")
    for label in ("pending", "audition", "kept", "undo_keep", "pending_again"):
        assert next(track for track in run.snapshot(label).tracks if track.name == unrelated.name) == unrelated
    with wave.open(str(before), "rb") as first, wave.open(str(kept), "rb") as second, wave.open(str(reopened), "rb") as third:
        raw_source, raw_kept, raw_reopened = (audio.readframes(audio.getnframes()) for audio in (first, second, third))
    assert raw_source != raw_kept and raw_kept == raw_reopened
    assert digest(source) == digest(Path(original.sourceFile))
    request = Path(auditioned.sourceFile).parent
    with wave.open(str(request / "input.wav"), "rb") as staged, wave.open(str(source), "rb") as full:
        full.setpos(44100)
        assert staged.readframes(staged.getnframes()) == full.readframes(88200)
    manifest = json.loads((request / "output_manifest.json").read_text())
    assert manifest["backend"] == "fixture" and manifest["evaluation"] == "disabled"
    assert manifest["source_sha256"] == digest(request / "input.wav")
    offline_output = harness.evidence / "offline-reopened.wav"
    offline = harness.run("offline_reopen", [command("open_project", {"file": str(project)}),
        snap("offline"), export(offline_output)], "unavailable")
    offline.passed()
    assert digest(Path(offline.snapshot("offline").clip().sourceFile)) == digest(Path(committed.sourceFile))
    assert not (offline.directory / "service-started.pid").exists()
    with wave.open(str(offline_output), "rb") as output:
        assert output.readframes(output.getnframes()) == raw_kept


def invalidations(harness: Harness, source: Path) -> None:
    for name, mutation in (("trim", target("trim_clip", {"length": 1})),
                           ("undo", command("undo")), ("remove", target("remove_clip")),
                           ("project", command("new_project", {"name": "Replacement"})),
                           ("cancel_before", target("cancel_render"))):
        # Given a captured request. When its target lifetime changes before delivery.
        run = harness.run(name, setup(source) + [target("render_layer"), mutation,
                          command("__wait", {"ms": 4000}), snap("after")], "delayed")
        run.passed()
        # Then no stale artifact becomes playable or pending on any surviving clip.
        for track in run.snapshot("after").tracks:
            for clip in track.clips:
                assert digest(Path(clip.sourceFile)) == digest(source)
                if clip.renderLayer is not None:
                    assert not clip.renderLayer.hasPending
    # Given inference is demonstrably running. When its actual request is cancelled.
    run = harness.run("cancel_running", setup(source) + [target("render_layer"), command("__wait", {"ms": 1000}),
        snap("running"), target("cancel_render"), command("__wait", {"ms": 3500}), snap("after")], "delayed")
    run.passed()
    assert layer(run, "running").jobId and layer(run, "running").status in ("queued", "rendering")
    assert layer(run, "after").status == "cancelled" and not layer(run, "after").hasPending
    assert digest(Path(run.snapshot("after").clip().sourceFile)) == digest(source)


def failures(harness: Harness, source: Path) -> None:
    for mode in ("failed", "malformed", "unavailable"):
        # Given an unavailable service or deliberately failed/corrupted fixture result.
        run = harness.run(mode, setup(source) + [target("render_layer", {"wait": True}), snap("after")], mode)
        # When the job resolves. Then state is error and source is untouched.
        run.passed()
        assert layer(run, "after").status == "error" and not layer(run, "after").hasPending
        assert digest(Path(run.snapshot("after").clip().sourceFile)) == digest(source)
    run = harness.run("overlap", setup(source) + [target("render_layer"), target("render_layer"),
        command("__wait", {"ms": 4500}), snap("after")], "delayed")
    failed = [result for result in run.results if not result.ok]
    assert run.exit_code != 0 and len(failed) == 1 and failed[0].command == "render_layer"
    assert layer(run, "after").hasPending


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("Usage: verify-direct-reimagine.py /absolute/Mosh /absolute/evidence")
    binary, evidence = (Path(value).resolve() for value in sys.argv[1:])
    assert binary.is_file()
    evidence.mkdir(parents=True, exist_ok=True)
    source = evidence / "synthetic-4s.wav"
    tone(source)
    harness = Harness(binary, evidence)
    identity = {"binary": str(binary), "binary_sha256": digest(binary), "fixture_sha256": digest(source),
                "model_execution": False, "backend": "deterministic fake fixture"}
    (evidence / "identity.json").write_text(json.dumps(identity, indent=2))
    decisions(harness, source)
    invalidations(harness, source)
    failures(harness, source)
    owned_pids = [path.read_text().strip() for pattern in ("*/app.pid", "*/service-started.pid") for path in evidence.glob(pattern)]
    deadline = time.monotonic() + 5
    while True:
        process_evidence = subprocess.run(["ps", "-p", ",".join(owned_pids), "-o", "pid=,command="], capture_output=True, text=True)
        if process_evidence.returncode == 1 or time.monotonic() >= deadline:
            break
        threading.Event().wait(0.2)
    (evidence / "final-processes.txt").write_text(f"Owned PIDs: {','.join(owned_pids)}\nps exit={process_evidence.returncode}\n{process_evidence.stdout}")
    assert process_evidence.returncode == 1, "Owned harness process did not exit within its idle window"
    (evidence / "PASS.json").write_text(json.dumps({**identity, "verdict": "PASS"}, indent=2))
    print(json.dumps({"verdict": "PASS", "evidence": str(evidence)}))


if __name__ == "__main__":
    main()
