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
    globbed = harness_session.plan_harness_cleanup(
        older_than_hours=24, sessions_older_than_days=1, keep={"verify-*"}, now=later)
    assert "verify-recovery" not in {entry["name"] for entry in globbed["delete"]}

    # A hand-edited entry that claims a failed inspection as its layout is refused.
    unmarked_stat = os.lstat(unmarked)
    forged = dict(plan, delete=[{
        "root": "harness", "name": ".mosh-reset-unmarked", "kind": "quarantine",
        "layout": "no ownership marker", "identity": [unmarked_stat.st_dev, unmarked_stat.st_ino],
        "bytes": 1, "min_age_seconds": 0}])
    forged_result = harness_session.apply_harness_cleanup(forged, now=later)
    assert forged_result["deleted"] == [] and len(forged_result["refused"]) == 1, forged_result

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

    # A quarantine whose session name marks it as evaluation evidence is kept.
    make_owned(harness / ".mosh-reset-eval-take-7-4242-deadbeef", [("scores.json", "{}")])
    evaluation = harness_session.plan_harness_cleanup(older_than_hours=24, now=later)
    assert ".mosh-reset-eval-take-7-4242-deadbeef" not in {
        entry["name"] for entry in evaluation["delete"]}


def last_project(session, leaf):
    project = f"{session.parents[1]}/{leaf}/projects/take.tracktionedit"
    (session / "last-project.json").write_text(f'{{"last": "{project}", "recent": ["{project}"]}}')


# The engine's auto-session prune quarantined into the Mosh root itself
# (`<Mosh>/.mosh-reset-<uuid32>/session`). Those are swept only on request, only as
# direct `.mosh-reset-*` children, and only in the engine's nested layout.
with tempfile.TemporaryDirectory(prefix="mosh-root-sweep-") as temp:
    root = Path(temp) / "Mosh"
    harness_session._mosh_base = lambda: root
    harness = root / "_harness"
    outside = Path(temp) / "outside"
    make_owned(outside / "session", [("keep.txt", "owner data")])

    planned_names = []
    for index in range(2):
        name = f".mosh-reset-{index:032x}"
        session = make_owned(root / name / "session",
                             [("mosh-log.jsonl", "prune"), ("exports/take.wav", "take")])
        (session / "training" / "adapters").mkdir(parents=True)   # empty: not evidence
        last_project(session, f"session-selftest-auto-{4000 + index}-{index:08x}")
        planned_names.append(name)
    make_owned(harness / ".mosh-reset-verify-recovery-4242-deadbeef", [("log", "harness")])

    # Everything below must survive any sweep.
    make_owned(root / ".mosh-reset-flat", [("keep.txt", "flat layout")])
    (root / ".mosh-reset-unmarked" / "session").mkdir(parents=True)
    (root / ".mosh-reset-unmarked" / "session" / "keep.txt").write_text("no marker")
    wrong = make_owned(root / ".mosh-reset-wrong-marker" / "session")
    (wrong / harness_session.MARKER_NAME).write_text(harness_session.MARKER_CONTENTS + "\n")
    extra = make_owned(root / ".mosh-reset-extra" / "session")
    (extra.parent / "stray.txt").write_text("not ours")
    os.symlink(outside, root / ".mosh-reset-symlinked")
    (root / ".mosh-reset-session-link").mkdir()
    os.symlink(outside / "session", root / ".mosh-reset-session-link" / "session")
    make_owned(root / ".mosh-reset-adapter" / "session",
               [("training/adapters/a.safetensors", "weights")])
    evaluation = make_owned(root / ".mosh-reset-eval-named" / "session", [("scores.json", "{}")])
    last_project(evaluation, "session-eval-auto-1-deadbeef")
    make_owned(root / ".mosh-reset.Ab12Cd" / "session", [("log", "bash layout")])
    stale_session = make_owned(root / "session-selftest-auto-9-deadbeef", [("log", "auto")])
    owner_session = root / "session"
    owner_session.mkdir()
    (owner_session / "session.tracktionedit").write_text("<EDIT>owner</EDIT>")
    make_owned(root / "work" / ".mosh-reset-nested" / "session", [("log", "not direct")])

    later = time.time() + 2 * DAY

    # Off by default: a plan without the flag lists nothing at the Mosh root.
    default = harness_session.plan_harness_cleanup(older_than_hours=24, now=later)
    assert all(entry.get("root", "harness") == "harness" for entry in default["delete"]), default
    assert all(entry.get("root", "harness") == "harness" for entry in default["skip"]), default

    plan = harness_session.plan_harness_cleanup(older_than_hours=24, now=later,
                                                include_mosh_root=True)
    assert plan["mosh_root"] == str(root), plan
    mosh_delete = sorted(entry["name"] for entry in plan["delete"] if entry["root"] == "mosh")
    assert mosh_delete == planned_names, plan
    assert [entry["name"] for entry in plan["delete"] if entry["root"] == "harness"] == [
        ".mosh-reset-verify-recovery-4242-deadbeef"], plan
    assert {entry["producer"] for entry in plan["delete"] if entry["root"] == "mosh"} == {
        "session-selftest-auto-<tag>"}, plan
    assert all(entry["layout"] == "nested" and entry["bytes"] > 0
               for entry in plan["delete"] if entry["root"] == "mosh"), plan
    mosh_skip = {entry["name"] for entry in plan["skip"] if entry["root"] == "mosh"}
    assert mosh_skip == {".mosh-reset-flat", ".mosh-reset-unmarked", ".mosh-reset-wrong-marker",
                         ".mosh-reset-extra", ".mosh-reset-symlinked", ".mosh-reset-session-link",
                         ".mosh-reset-adapter", ".mosh-reset-eval-named"}, plan

    # Age is max(mtime, ctime): back-dating mtime cannot make a quarantine look old.
    old = time.time() - 10 * DAY
    os.utime(root / planned_names[0], (old, old))
    os.utime(root / planned_names[0] / "session", (old, old))
    fresh = harness_session.plan_harness_cleanup(older_than_hours=24, include_mosh_root=True)
    assert [entry for entry in fresh["delete"] if entry["root"] == "mosh"] == [], fresh

    # A manifest for another Mosh root is refused outright.
    foreign = dict(plan, mosh_root=str(outside))
    expect_refusal(lambda: harness_session.apply_harness_cleanup(foreign, now=later),
                   "a manifest for another Mosh root was applied")

    # A tampered entry naming anything but a direct `.mosh-reset-*` child is refused.
    mosh_entry = next(entry for entry in plan["delete"] if entry["root"] == "mosh")
    tampered = dict(plan, delete=[dict(mosh_entry, name=name) for name in (
        "session", "session-selftest-auto-9-deadbeef", "work/.mosh-reset-nested",
        ".mosh-reset.Ab12Cd")])
    tampered_result = harness_session.apply_harness_cleanup(tampered, now=later)
    assert tampered_result["deleted"] == [] and len(tampered_result["refused"]) == 4, \
        tampered_result

    # A sibling that appears beside a planned session after the plan is kept, and so is
    # the quarantine holding it.
    (root / planned_names[1] / "late.txt").write_text("appeared after the plan")
    result = harness_session.apply_harness_cleanup(plan, now=later)
    assert sorted(result["deleted"]) == sorted(
        [planned_names[0], ".mosh-reset-verify-recovery-4242-deadbeef"]), result
    assert [entry["name"] for entry in result["refused"]] == [planned_names[1]], result
    assert (root / planned_names[1] / "late.txt").read_text() == "appeared after the plan"
    assert not (root / planned_names[0]).exists()

    assert (outside / "session" / "keep.txt").read_text() == "owner data"
    assert (root / ".mosh-reset-flat" / "keep.txt").read_text() == "flat layout"
    assert (root / ".mosh-reset-unmarked" / "session" / "keep.txt").read_text() == "no marker"
    assert (extra.parent / "stray.txt").read_text() == "not ours"
    assert (root / ".mosh-reset-adapter" / "session/training/adapters/a.safetensors").exists()
    assert (evaluation / "scores.json").read_text() == "{}"
    assert (root / ".mosh-reset.Ab12Cd" / "session" / "log").read_text() == "bash layout"
    assert (stale_session / "log").read_text() == "auto"
    assert (owner_session / "session.tracktionedit").read_text() == "<EDIT>owner</EDIT>"
    assert (root / "work" / ".mosh-reset-nested" / "session" / "log").read_text() == "not direct"

print("harness-session Python tests passed")
