import os
import tempfile
import time
from pathlib import Path

import harness_session


DAY = 24 * 3600


def make_owned(path, files=()):
    path.mkdir(parents=True)
    (path / harness_session.MARKER_NAME).write_text(harness_session.MARKER_CONTENTS)
    for relative, text in files:
        target = path / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
    return path


def entries(directory):
    return sorted(entry.name for entry in os.scandir(directory))


def expect_refusal(action, message):
    try:
        action()
    except RuntimeError:
        return
    raise AssertionError(message)


with tempfile.TemporaryDirectory(prefix="mosh-harness-reset-") as temp:
    root = Path(temp) / "Mosh"
    harness_session._mosh_base = lambda: root
    harness = root / "_harness"

    # A reset frees the requested path and reclaims the quarantine it created.
    owned = make_owned(harness / "owned", [("stale.txt", "stale"), ("exports/take.wav", "take")])
    assert harness_session.reset_owned_harness_session(owned)
    assert not owned.exists()
    assert entries(harness) == [], entries(harness)

    # Reclaim removes a symlink inside the session, never what it points at.
    outside = root / "outside"
    outside.mkdir()
    (outside / "keep.txt").write_text("owner data")
    linked_session = make_owned(harness / "links")
    os.symlink(outside, linked_session / "linked-dir")
    os.symlink(outside / "keep.txt", linked_session / "linked-file")
    assert harness_session.reset_owned_harness_session(linked_session)
    assert (outside / "keep.txt").read_text() == "owner data"
    assert entries(harness) == [], entries(harness)

    # A session holding model or adapter files is reset but its quarantine is kept.
    evidence = make_owned(harness / "style-train",
                          [("training/adapters/style.safetensors", "weights")])
    assert harness_session.reset_owned_harness_session(evidence)
    kept = entries(harness)
    assert len(kept) == 1 and kept[0].startswith(".mosh-reset-style-train-"), kept
    assert (harness / kept[0] / "training/adapters/style.safetensors").read_text() == "weights"

    unowned = harness / "unowned"
    unowned.mkdir()
    (unowned / "keep.txt").write_text("owner data")
    expect_refusal(lambda: harness_session.reset_owned_harness_session(unowned),
                   "unowned harness reset unexpectedly succeeded")
    assert (unowned / "keep.txt").read_text() == "owner data"

    linked = harness / "linked"
    os.symlink(outside, linked)
    expect_refusal(lambda: harness_session.reset_owned_harness_session(linked),
                   "symlinked harness reset unexpectedly succeeded")
    assert (outside / "keep.txt").read_text() == "owner data"


with tempfile.TemporaryDirectory(prefix="mosh-harness-sweep-") as temp:
    root = Path(temp) / "Mosh"
    harness_session._mosh_base = lambda: root
    harness = root / "_harness"
    outside = root / "outside"
    outside.mkdir(parents=True)
    (outside / "keep.txt").write_text("owner data")

    # The three layouts the engine, Python and bash helpers leave behind.
    make_owned(harness / ".mosh-reset-0123456789abcdef0123456789abcdef" / "session",
               [("render.wav", "engine reset")])
    make_owned(harness / ".mosh-reset-verify-recovery-4242-deadbeef",
               [("mosh-log.jsonl", "python reset")])
    make_owned(harness / ".mosh-reset.Ab12Cd" / "session", [("log", "bash reset")])
    os.symlink(outside, harness / ".mosh-reset.Ab12Cd" / "session" / "linked-dir")

    # Everything below must survive any sweep.
    unmarked = harness / ".mosh-reset-unmarked"
    (unmarked / "session").mkdir(parents=True)
    (unmarked / "session" / "keep.txt").write_text("no marker")
    extra = make_owned(harness / ".mosh-reset-extra" / "session")
    (extra.parent / "stray.txt").write_text("not ours")
    os.symlink(outside, harness / ".mosh-reset-symlinked")
    make_owned(harness / ".mosh-reset-adapter" / "session",
               [("training/adapters/a.safetensors", "weights")])
    live_session = make_owned(harness / "verify-recovery", [("session.mosh", "live")])

    later = time.time() + 2 * DAY
    plan = harness_session.plan_harness_cleanup(older_than_hours=24, now=later)
    planned = sorted(entry["name"] for entry in plan["delete"])
    assert planned == [
        ".mosh-reset-0123456789abcdef0123456789abcdef",
        ".mosh-reset-verify-recovery-4242-deadbeef",
        ".mosh-reset.Ab12Cd",
    ], planned
    skipped = {entry["name"]: entry["reason"] for entry in plan["skip"]}
    assert set(skipped) == {".mosh-reset-unmarked", ".mosh-reset-extra",
                            ".mosh-reset-symlinked", ".mosh-reset-adapter"}, skipped
    assert all(entry["bytes"] > 0 for entry in plan["delete"])

    # Nothing is old enough yet without the injected clock.
    assert harness_session.plan_harness_cleanup(older_than_hours=24)["delete"] == []

    # Sessions are only planned on request, and a name on the keep list is never planned.
    with_sessions = harness_session.plan_harness_cleanup(
        older_than_hours=24, sessions_older_than_days=1, now=later)
    assert "verify-recovery" in {entry["name"] for entry in with_sessions["delete"]}
    kept_sessions = harness_session.plan_harness_cleanup(
        older_than_hours=24, sessions_older_than_days=1, keep={"verify-recovery"}, now=later)
    assert "verify-recovery" not in {entry["name"] for entry in kept_sessions["delete"]}

    # An entry replaced after planning is refused at apply time.
    swapped = harness / ".mosh-reset-verify-recovery-4242-deadbeef"
    os.rename(swapped, harness / "displaced")
    make_owned(swapped, [("keep.txt", "replacement")])
    result = harness_session.apply_harness_cleanup(plan, now=later)
    assert sorted(result["deleted"]) == [
        ".mosh-reset-0123456789abcdef0123456789abcdef",
        ".mosh-reset.Ab12Cd",
    ], result
    assert [entry["name"] for entry in result["refused"]] == [
        ".mosh-reset-verify-recovery-4242-deadbeef"], result
    assert (swapped / "keep.txt").read_text() == "replacement"
    assert result["freed_bytes"] > 0

    assert (outside / "keep.txt").read_text() == "owner data"
    assert (unmarked / "session" / "keep.txt").read_text() == "no marker"
    assert (extra.parent / "stray.txt").read_text() == "not ours"
    assert (harness / ".mosh-reset-adapter" / "session" / "training/adapters/a.safetensors").exists()
    assert (live_session / "session.mosh").read_text() == "live"

print("harness-session Python tests passed")
