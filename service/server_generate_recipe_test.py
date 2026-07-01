#!/usr/bin/env python3
import os
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from teardown import recipe as R  # noqa: E402
from server import _generate_recipe_payload  # noqa: E402

fails: list[str] = []


def check(name, cond, extra=""):
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond or not extra else f"  [{extra}]"))
    if not cond:
        fails.append(name)


def write_recipe(root: str, slug: str, role: R.Role, pitch: int) -> None:
    rec = R.Recipe(
        recipe_id=slug,
        source=R.Source(platform="test", video_id=slug),
        meta=R.Meta(tempo_bpm=R.MetaField(value=140), key=R.MetaField(value="F minor")),
        elements=[R.Element(
            element_id=slug,
            role=role,
            label=role.value,
            midi=R.Midi(status="extracted", note_count=1,
                        notes=[R.NoteEvent(pitch=pitch, start_beats=0, duration_beats=1)]),
        )],
        reconstruction_class="deterministic",
    )
    with open(os.path.join(root, f"{slug}.json"), "w", encoding="utf-8") as f:
        f.write(R.to_json(rec))


with tempfile.TemporaryDirectory() as td:
    write_recipe(td, "kick_ing", R.Role.kick, 36)
    write_recipe(td, "snare_ing", R.Role.snare, 38)
    write_recipe(td, "hat_ing", R.Role.hat, 42)
    write_recipe(td, "pad_ing", R.Role.pad, 48)
    write_recipe(td, "bass_ing", R.Role.r808, 29)
    payload = _generate_recipe_payload({
        "libraryDir": td,
        "tempo": 142,
        "key": "G minor",
        "seed": 3,
    })
    program = payload["program"]
    commands = program["commands"]

    check("service recipe generator returns ok", payload["ok"] is True)
    check("request fields are forwarded", payload["request"]["tempo"] == 142 and payload["request"]["key"] == "G minor")
    check("compiled program contains create_track commands", any(c["command"] == "create_track" for c in commands))
    check("compiled program preserves capture refs", any(c.get("capture") for c in commands))
    check("compiled program has dependent ref args", any("${T" in str(c.get("args", {})) for c in commands))
    check("payload reports command count", payload["commandCount"] == len(commands))

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
