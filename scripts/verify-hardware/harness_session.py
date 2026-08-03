import os
import sys
import uuid
from pathlib import Path


MARKER_NAME = ".mosh-harness-owned-v1"
MARKER_CONTENTS = "Mosh isolated harness session v1"


def _mosh_base():
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Mosh"
    if sys.platform.startswith("win"):
        return Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming")) / "Mosh"
    return Path.home() / ".local" / "share" / "Mosh"


def _owned(path):
    marker = path / MARKER_NAME
    if path.is_symlink() or marker.is_symlink() or not path.is_dir() or not marker.is_file():
        return False
    try:
        return marker.read_text() == MARKER_CONTENTS
    except OSError:
        return False


def reset_owned_harness_session(path):
    candidate = Path(os.path.abspath(path))
    harness = Path(os.path.abspath(_mosh_base() / "_harness"))
    try:
        if os.path.commonpath((harness, candidate)) != str(harness) or candidate == harness:
            raise RuntimeError(f"refusing non-harness session reset: {candidate}")
    except ValueError as exc:
        raise RuntimeError(f"refusing non-harness session reset: {candidate}") from exc

    current = candidate
    while current != harness:
        if os.path.lexists(current) and current.is_symlink():
            raise RuntimeError(f"refusing symlinked harness session reset: {candidate}")
        if current.parent == current:
            raise RuntimeError(f"refusing unsafe harness session reset: {candidate}")
        current = current.parent

    if not os.path.lexists(candidate):
        return False
    if not _owned(candidate):
        raise RuntimeError(f"refusing unowned harness session reset: {candidate}")

    quarantine = harness / f".mosh-reset-{candidate.name}-{os.getpid()}-{uuid.uuid4().hex[:8]}"
    os.replace(candidate, quarantine)
    if not _owned(quarantine):
        if not os.path.lexists(candidate):
            os.replace(quarantine, candidate)
        raise RuntimeError(f"harness ownership changed during reset: {candidate}")
    return True
