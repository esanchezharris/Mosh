"""Keep a lab take: promote an auditioned checkpoint into the real library.

The Lab's takes live in `sa3/lab/` as SYMLINKS into a run directory (see
`training.lab_publish`) — cheap, disposable, and gone the moment the run is
deleted. "Keep" is the verb that turns one of them into a permanent adapter the
producer can reach from the rack menu forever.

## Why this is a COPY and not a link

The promoted adapter must outlive its run. `lab_publish.forget()` deletes a
run's takes, and deleting a run directory strands every link into it — so a
kept adapter that was merely another link would vanish along with the audition
it came from. Deciding to keep something and then losing it because you tidied
up the experiment is the single worst outcome this feature could have, so
promotion resolves the link and copies the real bytes.

`install.install()` does the copy, and it is reused rather than reimplemented
because it already stages through a temp file on the same filesystem and
validates the STAGED copy before `os.replace` makes it visible. That ordering
matters: a half-written or invalid file can never shadow a good adapter of the
same name, even if the process dies mid-promote.

## Fail closed

Validation is `install`'s (`lora_merge.read_safetensors` + `group_lora`:
every module must carry lora_A/lora_B, and magnitude too for DoRA) — strictly
more than the registry's header sniff. If a take does not pass, promotion
raises instead of enrolling it. Promoting something the render path will later
refuse would turn a listening decision into a broken rack entry, discovered
much later and far from its cause.

Stdlib only (plus `install`'s numpy).
"""

from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if os.path.join(HERE, "..") not in sys.path:
    sys.path.insert(0, os.path.join(HERE, ".."))     # service/

from loras import install as INS    # noqa: E402
from loras import registry as REG   # noqa: E402


def _find(source: str) -> dict:
    """The registry record for `source`, by name. Raises ValueError if absent."""
    for rec in REG.list_loras():
        if rec.get("name") == source:
            return rec
    raise ValueError(
        f"no adapter named {source!r} — expected a take from the Lab "
        f"(look in {REG.lab_dir()}) or an adapter in {REG.lora_dir()}")


def promote(source: str, name: str, trigger: str = "", hint: str = "",
            notes: str = "", display: str | None = None) -> dict:
    """Copy lab take `source` into the library as `name`. Returns its record.

    Refuses rather than overwrites when `name` is already taken: a kept adapter
    is something the producer chose deliberately, and silently replacing one
    with a different run's checkpoint destroys a decision without asking. The
    caller renames.
    """
    if not name or not name.strip():
        raise ValueError("a kept adapter needs a name")
    name = name.strip()

    rec = _find(source)
    if not rec.get("valid"):
        raise ValueError(
            f"{source!r} is not a usable adapter: {rec.get('reason') or 'invalid'} "
            "— promoting it would put an entry in the rack the render path refuses")

    src = rec.get("file")
    if not src or not os.path.isfile(src):
        # `isfile` follows a symlink, so this also catches a take whose run dir
        # was deleted out from under it mid-session.
        raise ValueError(f"{source!r} no longer resolves to a file (was its run deleted?)")

    dest = os.path.join(REG.lora_dir(), f"{name}.safetensors")
    if os.path.exists(dest):
        raise ValueError(f"a kept adapter named {name!r} already exists — pick another name")

    if not notes:
        notes = f"Kept from LoRA Lab take {source}."

    out = INS.install(src, name=name, trigger=trigger, hint=hint, notes=notes,
                      display=display or name)
    out["promotedFrom"] = source
    return out
