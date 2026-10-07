#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["pydantic>=2"]
# ///
# ─── How to run ───
# Imported by verify-direct-reimagine.py; no inference runs in these fixtures.
"""FINDINGS.md #7 (2026-09-23 demo walkthrough): "Keep is not undoable" -- Cmd+Z fired
right after clicking Keep used to race accept_render's async decision validation
(Thread::launch on every interactive run, since eng.hasAudio() is true). Reproduces the
exact race with NO settle gap -- Harness normally auto-inserts a 2s wait after
accept_render/bypass_layer specifically to avoid this race, so settle_decisions=False here
is the point of the test -- and proves Keep now completes as ONE atomic decision (see
MoshOps::completePendingAcceptDecisions) before undo/redo can touch the history, with a
prior, unrelated edit surviving the undo untouched (the G14-class "empty transaction eats
the previous edit" check)."""
from __future__ import annotations

import json
from pathlib import Path

from direct_render_harness import Harness, command, digest, setup, snap, target


def undo_race(harness: Harness, source: Path) -> None:
    # Given a prior, unrelated user edit, then a generated result Kept -- with ZERO settle
    # gap before the immediate undo.
    race = Harness(harness.binary, harness.evidence, settle_decisions=False)
    commands = setup(source) + [
        command("rename_track", {"trackId": "${T}", "name": "Renamed before Keep"}),
        target("render_layer", {"wait": True}), snap("pending"),
        target("accept_render"),
        command("undo"), snap("undo_keep"),
        command("redo"), snap("redo_keep"),
    ]
    run = race.run("undo_race", commands)
    run.passed()

    # Then Keep is never silently dropped by the race...
    accepts = [row for row in run.results if row.command == "accept_render"]
    assert len(accepts) == 1 and accepts[0].ok, accepts

    original = run.snapshot("before").clip()
    undo_keep = run.snapshot("undo_keep").clip()
    redo_keep = run.snapshot("redo_keep").clip()

    # ...and one undo reverts EXACTLY Keep: source, pending and kept flags all land back
    # at their pre-Keep values, never "cancelled" (the old race's silent-drop symptom).
    assert undo_keep.renderLayer is not None
    assert undo_keep.sourceFile == original.sourceFile
    assert undo_keep.renderLayer.hasPending is True
    assert undo_keep.renderLayer.userKept is False
    assert undo_keep.renderLayer.status == "ready"

    # ...redo re-applies Keep...
    assert redo_keep.renderLayer is not None
    assert redo_keep.renderLayer.userKept is True
    assert redo_keep.renderLayer.hasPending is False
    assert digest(Path(redo_keep.sourceFile)) != digest(source)

    # ...and the prior, unrelated edit (the rename) survives undoing Keep untouched --
    # the G14 class: a setter-backed mutation whose own transaction ends up empty would
    # instead revert the PREVIOUS transaction (the rename) rather than Keep.
    renamed = [t for t in run.snapshot("undo_keep").tracks if t.name == "Renamed before Keep"]
    assert len(renamed) == 1, "the prior rename_track edit must survive one undo of Keep"

    # mosh-log.jsonl: exactly ONE "queued" accept_render line, clearly marked as such (not
    # the final word on whether Keep is undoable -- FINDINGS.md #7's own "logged
    # undoable:false" reading), and exactly ONE "applied" line with undoable:true.
    log_path = Path(original.sourceFile).parent.parent / "mosh-log.jsonl"
    rows = [json.loads(line) for line in log_path.read_text().splitlines()]
    accept_lines = [row for row in rows if row.get("command") == "accept_render"]
    assert len(accept_lines) == 2, accept_lines
    assert accept_lines[0]["undoable"] is False and accept_lines[0]["args"].get("status") == "queued"
    assert accept_lines[1]["undoable"] is True
