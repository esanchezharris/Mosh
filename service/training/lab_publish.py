"""Publish a run's checkpoints into `sa3/lab/` so they can be auditioned.

A training run drops `step_<N>/mosh_lora.safetensors` under its own run dir.
Nothing renders from there — the render path resolves adapters by NAME through
`loras.registry`, which scans `sa3/` and `sa3/lab/`. This module is the bridge:
it makes each checkpoint visible under a stable name, `<run>@<step>`.

## Why symlinks and not copies

An r16 DoRA over 228 targets is ~20-25MB, and a default run checkpoints six
times. Copying would spend ~150MB per run to duplicate bytes that already exist
two directories away, for artifacts whose whole purpose is to be listened to
once and mostly discarded. Symlinks cost nothing and make "delete the run" a
complete cleanup.

The tradeoff is dangling links when a run dir is deleted, and it is handled
rather than ignored: `registry._scan` gates on `os.path.isfile`, which follows
the link and so skips a dangling one automatically (a deleted run silently
disappears from the sheet, which is right), and `prune()` here removes the
corpses so the directory doesn't accumulate them.

## Idempotence

Called repeatedly DURING a run — once per progress poll — so that a checkpoint
becomes auditionable the moment it lands rather than at the end. Every operation
is therefore skip-if-present, and a link whose target already matches is left
alone rather than relinked.

Stdlib only.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

# A run label becomes a FILENAME, so it may not carry separators or dots that
# could climb out of the lab dir. Anything else collapses to "-".
_UNSAFE = re.compile(r"[^A-Za-z0-9_-]+")


def safe_label(label: str) -> str:
    """A run label reduced to something safe to use as a filename stem.

    Deliberately strict rather than clever: a label is display sugar, and the
    name only has to be stable and unambiguous. `..`, `/`, and NUL all collapse
    to `-`, so no input can escape the lab directory."""
    out = _UNSAFE.sub("-", (label or "").strip()).strip("-")
    return out[:48] or "run"


def _scan_checkpoints(run: Path) -> list[dict[str, Any]]:
    """Delegate to local_pmetal, importable both as a package member (production,
    via trainer_job) and as a bare module (the house test convention imports
    `*_test.py` siblings directly, with only service/training on sys.path). A
    relative-only import works in the first case and raises in the second."""
    try:
        from . import local_pmetal as LP           # package: service.training
    except ImportError:                            # pragma: no cover - bare-module path
        import local_pmetal as LP                  # type: ignore[no-redef]
    return LP._scan_checkpoints(run)


def _lab_dir() -> Path:
    # Imported lazily: registry owns the MOSH_LORA_DIR resolution, and reading it
    # at call time (not import time) keeps tests able to move the root per-case.
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from loras import registry as R
    return Path(R.lab_dir())


def take_name(label: str, step: int | str) -> str:
    """The registry name for one checkpoint: `<run>@<step>`.

    `@` is chosen because it cannot appear in a `safe_label`, so the split back
    into (run, step) is unambiguous and the Lab can group a run's takes without
    a side table."""
    return f"{safe_label(label)}@{step}"


def _write_card(path: Path, display: str, notes: str) -> None:
    """The sidecar the registry reads for human metadata. Written once."""
    if path.exists():
        return
    path.write_text(json.dumps({
        "displayName": display,
        "trigger": "",
        "hint": "",
        "notes": notes,
    }, indent=2) + "\n", encoding="utf-8")


def _link(src: Path, dst: Path) -> bool:
    """Point dst at src. True if it now does. Skip-if-correct, replace-if-wrong."""
    try:
        if dst.is_symlink():
            if os.path.realpath(dst) == os.path.realpath(src):
                return True          # already correct — the common case mid-run
            dst.unlink()             # stale target (a rerun reusing a label)
        elif dst.exists():
            return False             # a real file sits there; never clobber it
        dst.symlink_to(src)
        return True
    except OSError as e:  # noqa: BLE001 — one bad link never kills a run
        print(f"[lab] could not link {dst} -> {src}: {e}", flush=True)
        return False


def publish(run_dir: str | Path, label: str,
            checkpoints: list[dict[str, Any]] | None = None,
            final: bool = True) -> list[dict[str, Any]]:
    """Link every exported checkpoint (and the final adapter) into `sa3/lab/`.

    Returns the takes now auditionable: [{name, step, file, isFinal}]. Safe to
    call on every progress poll — see the idempotence note above.

    `checkpoints` may be passed in when the caller already scanned (avoids a
    second directory walk per poll); omitted, it scans.
    """
    run = Path(run_dir)
    if checkpoints is None:
        checkpoints = _scan_checkpoints(run)

    lab = _lab_dir()
    try:
        lab.mkdir(parents=True, exist_ok=True)
    except OSError as e:  # noqa: BLE001
        print(f"[lab] cannot create {lab}: {e}", flush=True)
        return []

    out: list[dict[str, Any]] = []
    for c in checkpoints:
        src = c.get("moshLora")
        if not src or not Path(src).is_file():
            continue                 # checkpoint dir exists, export not written yet
        step = int(c["step"])
        name = take_name(label, step)
        dst = lab / f"{name}.safetensors"
        if not _link(Path(src), dst):
            continue
        _write_card(lab / f"{name}.json", f"{safe_label(label)} · step {step}",
                    f"LoRA Lab take from run {label}, step {step}. Not kept — audition only.")
        out.append({"name": name, "step": step, "file": str(dst), "isFinal": False})

    # The end-of-run adapter. Named `@final` rather than by step so the Lab can
    # show it as the run's endpoint without knowing the step count, and so it
    # does not collide with the last periodic checkpoint (which is a DIFFERENT
    # file whenever steps isn't a multiple of checkpoint_every).
    fin = run / "mosh_lora.safetensors"
    if final and fin.is_file():
        name = take_name(label, "final")
        dst = lab / f"{name}.safetensors"
        if _link(fin, dst):
            _write_card(lab / f"{name}.json", f"{safe_label(label)} · final",
                        f"LoRA Lab take from run {label}, end of training. Not kept — audition only.")
            out.append({"name": name, "step": -1, "file": str(dst), "isFinal": True})
    return out


def prune() -> int:
    """Remove dangling links (their run dir was deleted). Returns the count.

    Not called automatically on a schedule — a run being deleted is the trigger,
    and until then a dangling link is invisible to the registry anyway."""
    lab = _lab_dir()
    if not lab.is_dir():
        return 0
    n = 0
    for f in sorted(lab.iterdir()):
        if not f.is_symlink() or f.exists():
            continue                 # .exists() follows the link: False = dangling
        stem = f.with_suffix("")
        try:
            f.unlink()
            card = stem.with_suffix(".json")
            if card.is_file():
                card.unlink()
            n += 1
        except OSError as e:  # noqa: BLE001
            print(f"[lab] could not prune {f}: {e}", flush=True)
    return n


def forget(label: str) -> int:
    """Drop every take belonging to one run (links + cards). Returns the count.

    This is the Lab's "delete run" verb. It removes only the LINKS — the run dir
    and its real checkpoints are untouched, and a kept adapter promoted into the
    library is a separate COPY under `sa3/` and so survives. Deleting an
    audition must never be able to delete the thing you decided to keep."""
    lab = _lab_dir()
    if not lab.is_dir():
        return 0
    prefix = safe_label(label) + "@"
    n = 0
    for f in sorted(lab.iterdir()):
        if not f.name.startswith(prefix):
            continue
        if f.suffix not in (".safetensors", ".json"):
            continue
        try:
            f.unlink()
            n += 1
        except OSError as e:  # noqa: BLE001
            print(f"[lab] could not remove {f}: {e}", flush=True)
    return n
