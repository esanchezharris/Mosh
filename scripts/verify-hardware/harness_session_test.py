import os
import tempfile
from pathlib import Path

import harness_session


with tempfile.TemporaryDirectory(prefix="mosh-harness-reset-") as temp:
    root = Path(temp) / "Mosh"
    harness_session._mosh_base = lambda: root
    owned = root / "_harness" / "owned"
    owned.mkdir(parents=True)
    (owned / harness_session.MARKER_NAME).write_text(harness_session.MARKER_CONTENTS)
    (owned / "stale.txt").write_text("stale")
    assert harness_session.reset_owned_harness_session(owned)
    assert not owned.exists()
    recovery = list((root / "_harness").glob(".mosh-reset-owned-*"))
    assert len(recovery) == 1
    assert (recovery[0] / "stale.txt").read_text() == "stale"

    unowned = root / "_harness" / "unowned"
    unowned.mkdir()
    (unowned / "keep.txt").write_text("owner data")
    try:
        harness_session.reset_owned_harness_session(unowned)
    except RuntimeError:
        pass
    else:
        raise AssertionError("unowned harness reset unexpectedly succeeded")
    assert (unowned / "keep.txt").read_text() == "owner data"

    outside = root / "outside"
    outside.mkdir()
    linked = root / "_harness" / "linked"
    os.symlink(outside, linked)
    try:
        harness_session.reset_owned_harness_session(linked)
    except RuntimeError:
        pass
    else:
        raise AssertionError("symlinked harness reset unexpectedly succeeded")

print("harness-session Python tests passed")
