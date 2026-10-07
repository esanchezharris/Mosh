"""Ownership-checked reset and cleanup for Mosh `_harness` sessions.

`reset_owned_harness_session` moves a marker-owned session into a unique
`_harness/.mosh-reset-*` quarantine, then deletes that quarantine. Everything else
(older quarantines left by crashed runs or earlier builds, stale sessions) is only
removed through a reviewed manifest:

    python3 harness_session.py plan --older-than-hours 24 --out manifest.json
    python3 harness_session.py apply manifest.json

`plan --include-mosh-root` also lists the `.mosh-reset-*` quarantines the engine's
auto-session prune used to leave directly under the Mosh data directory
(`<Mosh>/.mosh-reset-<uuid32>/session`). Only those direct children are considered, and
only in that exact layout: nothing else under the Mosh data directory is ever planned.

`plan` is read-only. `apply` deletes exactly the manifest entries that still verify.
Deletion walks descriptors only: symlinks are unlinked, never followed; a directory is
entered only if it is the inode an lstat saw, on the same device. Trees holding model,
adapter, checkpoint or evaluation files, and quarantines of evaluation/adapter-named
sessions, are never deleted.
"""

import argparse
import fnmatch
import json
import os
import re
import stat
import sys
import time
import uuid
from pathlib import Path


MARKER_NAME = ".mosh-harness-owned-v1"
MARKER_CONTENTS = "Mosh isolated harness session v1"

# Quarantine names written by src/engine/SessionOwnership.h (`.mosh-reset-<uuid32>/session`),
# this module (`.mosh-reset-<leaf>-<pid>-<hex8>`) and scripts/lib/harness-session.sh
# (`.mosh-reset.XXXXXX/session`).
QUARANTINE_PREFIXES = (".mosh-reset-", ".mosh-reset.")
# The auto-session prune (src/engine/SessionMaintenance.h) quarantined into the Mosh
# data directory itself, always as `.mosh-reset-<uuid32>/session`.
MOSH_ROOT_QUARANTINE_PREFIX = ".mosh-reset-"
NESTED_SESSION = "session"

# Kept in step with SessionOwnershipPosix.h isModelFileName / isEvidenceDirectoryName.
MODEL_SUFFIXES = (".safetensors", ".ckpt", ".pt", ".pth", ".gguf", ".onnx", ".npz", ".h5",
                  ".tflite", ".mlmodel", ".mlpackage", ".mlmodelc")
EVIDENCE_WORDS = {"adapter", "adapters", "checkpoint", "checkpoints", "lora", "loras",
                  "eval", "evals", "evaluation", "evaluations"}
MAX_DEPTH = 64

_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_DIR_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | _NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
# Deletion needs descriptor-relative calls and no-follow opens. Where they are missing
# (Windows), resets keep their quarantine and plan/apply refuse to run: fail closed.
_FD_WALK = (hasattr(os, "O_DIRECTORY") and hasattr(os, "O_NOFOLLOW")
            and {os.open, os.stat, os.unlink, os.rmdir} <= os.supports_dir_fd
            and os.listdir in os.supports_fd)
_PY_QUARANTINE = re.compile(r"^\.mosh-reset-(?P<leaf>.+)-\d+-[0-9a-f]{8}$")
_UUID_SUFFIX = re.compile(r"^(?P<prefix>.+)-[0-9a-f]{10}$")
_AUTO_TAG = re.compile(r"-auto-\d+-[0-9a-f]{8}$")


def _mosh_base():
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Mosh"
    if sys.platform.startswith("win"):
        return Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming")) / "Mosh"
    return Path.home() / ".local" / "share" / "Mosh"


def _mosh_root():
    return Path(os.path.abspath(_mosh_base()))


def _harness_root():
    return Path(os.path.abspath(_mosh_base() / "_harness"))


def _owned(path):
    marker = path / MARKER_NAME
    if path.is_symlink() or marker.is_symlink() or not path.is_dir() or not marker.is_file():
        return False
    try:
        return marker.read_text() == MARKER_CONTENTS
    except OSError:
        return False


def _is_model_file_name(name):
    return name.lower().endswith(MODEL_SUFFIXES)


def _is_evidence_directory_name(name):
    return any(word in EVIDENCE_WORDS for word in re.split(r"[-_. ]", name.lower()))


# --- descriptor-relative tree walking ------------------------------------------------

def _lstat_at(parent_fd, name):
    return os.stat(name, dir_fd=parent_fd, follow_symlinks=False)


def _open_child_dir(parent_fd, name, device, expected=None):
    """Open a real child directory on `device`, or return None. Never follows a link."""
    try:
        seen = _lstat_at(parent_fd, name)
    except OSError:
        return None
    if not stat.S_ISDIR(seen.st_mode) or seen.st_dev != device:
        return None
    if expected is not None and (seen.st_dev, seen.st_ino) != tuple(expected):
        return None
    try:
        fd = os.open(name, _DIR_FLAGS, dir_fd=parent_fd)
    except OSError:
        return None
    opened = os.fstat(fd)
    if (opened.st_dev, opened.st_ino) != (seen.st_dev, seen.st_ino):
        os.close(fd)
        return None
    return fd


def _open_root(directory, *ancestors):
    if not _FD_WALK:
        raise RuntimeError("descriptor-relative deletion is unavailable on this platform")
    if any(path.is_symlink() for path in (*ancestors, directory)):
        raise RuntimeError(f"refusing symlinked sweep root: {directory}")
    return os.open(str(directory), _DIR_FLAGS)


def _open_harness_root(harness):
    return _open_root(harness, harness.parent)


def _marker_ok_at(dir_fd):
    try:
        fd = os.open(MARKER_NAME, os.O_RDONLY | _NOFOLLOW, dir_fd=dir_fd)
    except OSError:
        return False
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return False
        return os.read(fd, len(MARKER_CONTENTS) + 1) == MARKER_CONTENTS.encode()
    finally:
        os.close(fd)


def _has_evidence(dir_fd, device, depth=0):
    """True if the tree holds evidence, or could not be fully inspected."""
    if depth > MAX_DEPTH:
        return True
    try:
        names = os.listdir(dir_fd)
    except OSError:
        return True
    for name in names:
        try:
            seen = _lstat_at(dir_fd, name)
        except OSError:
            return True
        if _is_model_file_name(name):
            return True
        if not stat.S_ISDIR(seen.st_mode):
            continue
        child = _open_child_dir(dir_fd, name, device)
        if child is None:
            return True
        try:
            if _is_evidence_directory_name(name):
                if os.listdir(child):
                    return True
            elif _has_evidence(child, device, depth + 1):
                return True
        except OSError:
            return True
        finally:
            os.close(child)
    return False


def _tree_usage(dir_fd, device, seen_inodes, depth=0):
    """(allocated bytes, newest mtime) below a directory, counting each inode once."""
    total, newest = 0, 0.0
    if depth > MAX_DEPTH:
        return total, newest
    for name in os.listdir(dir_fd):
        try:
            st = _lstat_at(dir_fd, name)
        except OSError:
            continue
        newest = max(newest, st.st_mtime)
        if (st.st_dev, st.st_ino) not in seen_inodes:
            seen_inodes.add((st.st_dev, st.st_ino))
            total += st.st_blocks * 512
        if stat.S_ISDIR(st.st_mode):
            child = _open_child_dir(dir_fd, name, device)
            if child is not None:
                try:
                    child_total, child_newest = _tree_usage(child, device, seen_inodes, depth + 1)
                finally:
                    os.close(child)
                total += child_total
                newest = max(newest, child_newest)
    return total, newest


def _remove_tree_contents(dir_fd, device, depth=0):
    """Unlink everything below a directory; False if anything remains."""
    if depth > MAX_DEPTH:
        return False
    try:
        names = os.listdir(dir_fd)
    except OSError:
        return False
    removed_all = True
    for name in names:
        try:
            st = _lstat_at(dir_fd, name)
        except FileNotFoundError:
            continue
        except OSError:
            removed_all = False
            continue
        if stat.S_ISDIR(st.st_mode):
            child = _open_child_dir(dir_fd, name, device)
            if child is None:
                removed_all = False
                continue
            try:
                emptied = _remove_tree_contents(child, device, depth + 1)
            finally:
                os.close(child)
            try:
                if emptied:
                    os.rmdir(name, dir_fd=dir_fd)
                else:
                    removed_all = False
            except OSError:
                removed_all = False
        else:
            try:
                os.unlink(name, dir_fd=dir_fd)
            except FileNotFoundError:
                pass
            except OSError:
                removed_all = False
    return removed_all


def _remove_tree_at(parent_fd, name, identity):
    """Delete `name` under parent_fd if it is still the directory `identity` names."""
    device = identity[0]
    fd = _open_child_dir(parent_fd, name, device, expected=identity)
    if fd is None:
        return False
    try:
        if _has_evidence(fd, device) or not _remove_tree_contents(fd, device):
            return False
    finally:
        os.close(fd)
    try:
        current = _lstat_at(parent_fd, name)
        if (current.st_dev, current.st_ino) != tuple(identity):
            return False
        os.rmdir(name, dir_fd=parent_fd)
    except OSError:
        return False
    return True


def _remove_nested_quarantine(parent_fd, name, identity):
    """Delete a `name/session` quarantine through descriptors held on the verified
    directories, like SessionOwnership.h's reclaim: a session that lost its marker,
    holds evidence or was swapped stops it, and anything that appears beside `session`
    keeps the quarantine (its final rmdir fails)."""
    device = identity[0]
    quarantine_fd = _open_child_dir(parent_fd, name, device, expected=identity)
    if quarantine_fd is None:
        return False
    try:
        if os.listdir(quarantine_fd) != [NESTED_SESSION]:
            return False
        session_fd = _open_child_dir(quarantine_fd, NESTED_SESSION, device)
        if session_fd is None:
            return False
        try:
            session = os.fstat(session_fd)
            if not _marker_ok_at(session_fd) or _has_evidence(session_fd, device) \
                    or not _remove_tree_contents(session_fd, device):
                return False
        finally:
            os.close(session_fd)
        current = _lstat_at(quarantine_fd, NESTED_SESSION)
        if (current.st_dev, current.st_ino) != (session.st_dev, session.st_ino):
            return False
        os.rmdir(NESTED_SESSION, dir_fd=quarantine_fd)
    except OSError:
        return False
    finally:
        os.close(quarantine_fd)
    try:
        current = _lstat_at(parent_fd, name)
        if (current.st_dev, current.st_ino) != tuple(identity):
            return False
        os.rmdir(name, dir_fd=parent_fd)
    except OSError:
        return False
    return True


# --- reset ---------------------------------------------------------------------------

def reset_owned_harness_session(path):
    candidate = Path(os.path.abspath(path))
    harness = _harness_root()
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

    before = os.lstat(candidate)
    quarantine = harness / f".mosh-reset-{candidate.name}-{os.getpid()}-{uuid.uuid4().hex[:8]}"
    os.replace(candidate, quarantine)
    if not _owned(quarantine):
        if not os.path.lexists(candidate):
            os.replace(quarantine, candidate)
        raise RuntimeError(f"harness ownership changed during reset: {candidate}")

    # The path is free; reclaiming the quarantine is best effort and never fails the reset.
    # Only the directory that was moved is deleted, and only while it still carries the
    # marker. A leftover quarantine stays for recovery and the manifest sweep.
    if not _is_evidence_directory_name(candidate.name):
        try:
            root_fd = _open_harness_root(harness)
        except (OSError, RuntimeError):
            return True
        try:
            moved = _open_child_dir(root_fd, quarantine.name, before.st_dev,
                                    expected=(before.st_dev, before.st_ino))
            if moved is not None:
                try:
                    owned = _marker_ok_at(moved)
                finally:
                    os.close(moved)
                if owned:
                    _remove_tree_at(root_fd, quarantine.name, (before.st_dev, before.st_ino))
        finally:
            os.close(root_fd)
    return True


# --- manifest sweep ------------------------------------------------------------------

ROOTS = ("harness", "mosh")


def _session_leaf(name, session_fd, base):
    """The session a quarantine came from, when its name or last-project.json says."""
    match = _PY_QUARANTINE.match(name)
    if match:
        return match.group("leaf")
    return _last_project_leaf(session_fd, base)


def _producer(name, session_fd, base):
    if name.startswith(QUARANTINE_PREFIXES):
        name = _session_leaf(name, session_fd, base) or "<unattributed engine/bash reset>"
    name = _AUTO_TAG.sub("-auto-<tag>", name)
    match = _UUID_SUFFIX.match(name)
    return match.group("prefix") + "-<uuid10>" if match else name


def _last_project_leaf(session_fd, base):
    try:
        fd = os.open("last-project.json", os.O_RDONLY | _NOFOLLOW, dir_fd=session_fd)
    except OSError:
        return None
    try:
        data = json.loads(os.read(fd, 1 << 20) or b"{}")
    except (OSError, ValueError):
        return None
    finally:
        os.close(fd)
    if not isinstance(data, dict):
        return None
    prefix = str(base) + "/"
    for path in [data.get("last")] + list(data.get("recent") or []):
        if not isinstance(path, str):
            continue
        if "/_harness/" in path:
            return path.split("/_harness/", 1)[1].split("/", 1)[0]
        if path.startswith(prefix):
            return path[len(prefix):].split("/", 1)[0]
    return None


def _inspect(root_fd, device, name, quarantine, nested_only=False):
    """(layout, directory fd holding the marker, fds to close) or (reason, None, fds)."""
    fd = _open_child_dir(root_fd, name, device)
    if fd is None:
        return "not a real directory on the sweep volume", None, []
    if _marker_ok_at(fd):
        if nested_only:
            return "not the auto-session prune's <quarantine>/session layout", None, [fd]
        return "flat", fd, [fd]
    if not quarantine:
        return "no ownership marker", None, [fd]
    try:
        children = os.listdir(fd)
    except OSError:
        return "unreadable", None, [fd]
    if children != [NESTED_SESSION]:
        reason = "no ownership marker" if NESTED_SESSION not in children else \
            "unexpected entries beside the quarantined session"
        return reason, None, [fd]
    session = _open_child_dir(fd, NESTED_SESSION, device)
    if session is None:
        return "quarantined session is not a real directory", None, [fd]
    if not _marker_ok_at(session):
        return "no ownership marker", None, [fd, session]
    return "nested", session, [fd, session]


def _last_activity(top, marked_fd, newest):
    # ctime cannot be set from user space, so a touched or renamed entry always reads as
    # recent. A nested quarantine also counts its session directory.
    marked = os.fstat(marked_fd)
    return max(top.st_mtime, top.st_ctime, marked.st_mtime, marked.st_ctime, newest)


def _plan_entry(plan, root, root_fd, device, name, quarantine, min_age, now, base):
    def skip(reason):
        plan["skip"].append({"root": root, "name": name, "reason": reason})

    try:
        top = _lstat_at(root_fd, name)
    except OSError:
        return
    layout, marked_fd, to_close = _inspect(root_fd, device, name, quarantine,
                                           nested_only=root == "mosh")
    try:
        if marked_fd is None:
            skip(layout)
            return
        entry_fd = to_close[0]
        if _has_evidence(entry_fd, device):
            skip("holds model/adapter/checkpoint/evaluation files")
            return
        if quarantine and _is_evidence_directory_name(
                _session_leaf(name, marked_fd, base) or ""):
            skip("quarantined session's name marks it as evaluation/adapter evidence")
            return
        size, newest = _tree_usage(entry_fd, device, {(top.st_dev, top.st_ino)})
        size += top.st_blocks * 512
        age = now - _last_activity(top, marked_fd, 0.0 if quarantine else newest)
        if age < min_age:
            skip(f"active within the last {min_age / 3600:g} h")
            return
        plan["delete"].append({
            "root": root,
            "name": name,
            "kind": "quarantine" if quarantine else "session",
            "layout": layout,
            "producer": _producer(name, marked_fd, base),
            "identity": [top.st_dev, top.st_ino],
            "bytes": size,
            "age_hours": round(age / 3600, 1),
            "min_age_seconds": min_age,
        })
    finally:
        for fd in reversed(to_close):
            os.close(fd)


def plan_harness_cleanup(older_than_hours=24, sessions_older_than_days=None, keep=(),
                         now=None, include_mosh_root=False):
    """Read-only. Lists quarantines (and optionally sessions) that are safe to delete.

    With include_mosh_root, also lists the auto-session prune's quarantines: direct
    `.mosh-reset-*` children of the Mosh data directory, nested layout only."""
    now = time.time() if now is None else now
    harness = _harness_root()
    base = _mosh_root()
    keep = set(keep)
    plan = {"harness": str(harness), "mosh_root": str(base) if include_mosh_root else None,
            "created": now, "older_than_hours": older_than_hours,
            "sessions_older_than_days": sessions_older_than_days, "delete": [], "skip": []}

    if os.path.lexists(harness):
        root_fd = _open_harness_root(harness)
        try:
            device = os.fstat(root_fd).st_dev
            for name in sorted(os.listdir(root_fd)):
                quarantine = name.startswith(QUARANTINE_PREFIXES)
                if not quarantine and sessions_older_than_days is None:
                    continue
                if not quarantine and any(fnmatch.fnmatchcase(name, pattern) for pattern in keep):
                    plan["skip"].append({"root": "harness", "name": name,
                                         "reason": "on the keep list"})
                    continue
                if not quarantine and _is_evidence_directory_name(name):
                    plan["skip"].append({"root": "harness", "name": name,
                                         "reason": "name marks it as evaluation/adapter evidence"})
                    continue
                min_age = older_than_hours * 3600 if quarantine else sessions_older_than_days * 86400
                _plan_entry(plan, "harness", root_fd, device, name, quarantine, min_age, now, base)
        finally:
            os.close(root_fd)

    if include_mosh_root and os.path.lexists(base):
        root_fd = _open_root(base)
        try:
            device = os.fstat(root_fd).st_dev
            for name in sorted(os.listdir(root_fd)):
                if name.startswith(MOSH_ROOT_QUARANTINE_PREFIX):
                    _plan_entry(plan, "mosh", root_fd, device, name, True,
                                older_than_hours * 3600, now, base)
        finally:
            os.close(root_fd)
    return plan


def _entry_name_problem(root, entry):
    name = entry.get("name")
    if not isinstance(name, str) or not name or "/" in name or name in (".", ".."):
        return "not a direct child name"
    identity = entry.get("identity")
    if entry.get("layout") not in ("flat", "nested") or not isinstance(identity, list) \
            or len(identity) != 2 or not all(isinstance(value, int) for value in identity) \
            or not isinstance(entry.get("min_age_seconds"), (int, float)) \
            or not isinstance(entry.get("bytes"), int):
        return "malformed manifest entry"
    quarantine = entry.get("kind") == "quarantine"
    if root == "mosh":
        if not quarantine or entry.get("layout") != "nested" \
                or not name.startswith(MOSH_ROOT_QUARANTINE_PREFIX):
            return "not an auto-session prune quarantine"
    elif quarantine != name.startswith(QUARANTINE_PREFIXES):
        return "not a harness entry name"
    return None


def apply_harness_cleanup(plan, now=None):
    """Deletes exactly the planned entries that still verify; refuses the rest."""
    now = time.time() if now is None else now
    harness = _harness_root()
    base = _mosh_root()
    if plan.get("harness") != str(harness):
        raise RuntimeError(f"manifest is for {plan.get('harness')}, not {harness}")
    result = {"deleted": [], "refused": [], "freed_bytes": 0}
    by_root = {root: [] for root in ROOTS}
    for entry in plan["delete"]:
        root = entry.get("root", "harness")
        if root in by_root:
            by_root[root].append(entry)
        else:
            result["refused"].append({"name": entry.get("name"), "reason": "unknown root"})
    if by_root["mosh"] and plan.get("mosh_root") != str(base):
        raise RuntimeError(f"manifest is for Mosh root {plan.get('mosh_root')}, not {base}")

    for root in ROOTS:
        if not by_root[root]:
            continue
        root_fd = _open_harness_root(harness) if root == "harness" else _open_root(base)
        try:
            device = os.fstat(root_fd).st_dev
            for entry in by_root[root]:
                _apply_entry(result, root, root_fd, device, entry, now, base)
        finally:
            os.close(root_fd)
    return result


def _apply_entry(result, root, root_fd, device, entry, now, base):
    name = entry.get("name")

    def refuse(reason):
        result["refused"].append({"root": root, "name": name, "reason": reason})

    problem = _entry_name_problem(root, entry)
    if problem:
        refuse(problem)
        return
    identity = tuple(entry["identity"])
    quarantine = entry["kind"] == "quarantine"
    try:
        top = _lstat_at(root_fd, name)
    except OSError:
        refuse("gone")
        return
    if (top.st_dev, top.st_ino) != identity or top.st_dev != device:
        refuse("replaced since the plan")
        return
    layout, marked_fd, to_close = _inspect(root_fd, device, name, quarantine,
                                           nested_only=root == "mosh")
    try:
        last_activity = evidence_name = None
        if marked_fd is not None:
            newest = 0.0 if quarantine else _tree_usage(to_close[0], device, set())[1]
            last_activity = _last_activity(top, marked_fd, newest)
            evidence_name = quarantine and _is_evidence_directory_name(
                _session_leaf(name, marked_fd, base) or "")
    finally:
        for fd in reversed(to_close):
            os.close(fd)
    if last_activity is None or layout != entry["layout"]:
        refuse(f"no longer verifies ({layout})")
        return
    if evidence_name:
        refuse("quarantined session's name marks it as evaluation/adapter evidence")
        return
    if now - last_activity < entry["min_age_seconds"]:
        refuse("changed since the plan")
        return
    remove = _remove_nested_quarantine if layout == "nested" else _remove_tree_at
    if remove(root_fd, name, identity):
        result["deleted"].append(name)
        result["freed_bytes"] += entry["bytes"]
    else:
        refuse("could not be removed completely")


def _summarize(entries):
    by = {}
    for entry in entries:
        key = (entry["kind"], entry["producer"])
        count, size = by.get(key, (0, 0))
        by[key] = (count + 1, size + entry["bytes"])
    return sorted(by.items(), key=lambda item: -item[1][1])


def _print_plan(plan):
    for root in ROOTS:
        directory = plan["harness"] if root == "harness" else plan.get("mosh_root")
        if directory is None:
            continue
        delete = [entry for entry in plan["delete"] if entry.get("root", "harness") == root]
        skip = [entry for entry in plan["skip"] if entry.get("root", "harness") == root]
        total = sum(entry["bytes"] for entry in delete)
        print(f"{directory}: {len(delete)} entries, {total} bytes ({total / 2**30:.2f} GiB) "
              f"would be deleted; {len(skip)} kept")
        for (kind, producer), (count, size) in _summarize(delete):
            print(f"  {kind:10s} {count:6d} {size / 2**20:10.1f} MiB  {producer}")
        reasons = {}
        for entry in skip:
            reasons[entry["reason"]] = reasons.get(entry["reason"], 0) + 1
        for reason, count in sorted(reasons.items(), key=lambda item: -item[1]):
            print(f"  kept {count:6d}  {reason}")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    plan_cmd = commands.add_parser("plan", help="list what a cleanup would delete (read-only)")
    plan_cmd.add_argument("--older-than-hours", type=float, default=24)
    plan_cmd.add_argument("--sessions-older-than-days", type=float, default=None,
                          help="also plan owned sessions idle this long (off by default)")
    plan_cmd.add_argument("--include-mosh-root", action="store_true",
                          help="also plan the auto-session prune's .mosh-reset-* quarantines "
                               "directly under the Mosh data directory (off by default)")
    plan_cmd.add_argument("--keep-file", help="session names or globs never to plan, one per line")
    plan_cmd.add_argument("--out", help="write the manifest here")
    apply_cmd = commands.add_parser("apply", help="delete exactly a reviewed manifest")
    apply_cmd.add_argument("manifest")
    args = parser.parse_args(argv)

    if args.command == "plan":
        keep = set()
        if args.keep_file:
            keep = {line.strip() for line in Path(args.keep_file).read_text().splitlines()
                    if line.strip() and not line.startswith("#")}
        plan = plan_harness_cleanup(args.older_than_hours, args.sessions_older_than_days, keep,
                                    include_mosh_root=args.include_mosh_root)
        _print_plan(plan)
        if args.out:
            Path(args.out).write_text(json.dumps(plan, indent=1) + "\n")
            print(f"manifest: {args.out}")
        return 0

    plan = json.loads(Path(args.manifest).read_text())
    result = apply_harness_cleanup(plan)
    print(f"deleted {len(result['deleted'])} entries, freed about "
          f"{result['freed_bytes'] / 2**30:.2f} GiB; refused {len(result['refused'])}")
    for entry in result["refused"]:
        print(f"  refused {entry['name']}: {entry['reason']}")
    return 0 if not result["refused"] else 1


if __name__ == "__main__":
    sys.exit(main())
