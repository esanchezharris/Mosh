#!/usr/bin/env python3
"""r8 MIDI-pack ingester: purchased/royalty-free .mid packs → per-element library recipes.

    service/teardown/.venv/bin/python service/recipes/ingest_midi.py \
        --packs ~/Downloads/musica --library service/recipes/library [--write]

Rights: the packs were confirmed purchased/royalty-free by the owner (2026-07-02) —
recipes are tagged License.licensed_pack. r8 spec order for key/tempo:
  tempo:  SMF meta (FF 51) → filename convention → REFUSE the file (never guess 120);
  key:    SMF meta (FF 59) → filename → Krumhansl inference from the notes themselves —
          and when a label DISAGREES with the notes' own inference, the notes win
          (r8 item 9: labeled keys are the proven-unreliable link; evidence records both).
Notes are parsed losslessly (reconstruction_class stays deterministic — honest here,
unlike r7's inferred corpora). " 2." iCloud duplicates are never read. Dry-run by default.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_SERVICE = _HERE.parent
if str(_SERVICE) not in sys.path:
    sys.path.insert(0, str(_SERVICE))

from teardown import recipe as R  # noqa: E402
from teardown.render.midi_read import read_midi, read_midi_meta  # noqa: E402
from recipes.ingest_ir import (  # noqa: E402
    DRUMISH, _bars, _bass, _contour, _onset_grid, _register, _slug, _syncopation,
    infer_key, role_for,
)

_KEY_RE = re.compile(r"(?<![a-z0-9])([a-g](?:#|b)?)\s*(min(?:or)?|maj(?:or)?|m\b)", re.IGNORECASE)
_BPM_RE = re.compile(r"(?<!\d)(\d{2,3})\s*bpm|[_\s(](\d{2,3})[_\s).]", re.IGNORECASE)
_FLAT = {"db": "C#", "eb": "D#", "gb": "F#", "ab": "G#", "bb": "A#"}


def key_from_name(name: str):
    m = _KEY_RE.search(name)
    if not m:
        return None
    tonic = m.group(1).lower()
    tonic = _FLAT.get(tonic, tonic.upper().replace("B#", "B"))
    mode = "minor" if m.group(2).lower().startswith(("m",)) and not m.group(2).lower().startswith("maj") else "major"
    return f"{tonic.upper() if len(tonic) == 1 else tonic} {mode}"


def bpm_from_name(name: str):
    for m in _BPM_RE.finditer(name):
        v = int(m.group(1) or m.group(2))
        if 60 <= v <= 200:
            return v
    return None


def _same_key(a: str, b: str) -> bool:
    return bool(a) and bool(b) and a.strip().lower() == b.strip().lower()


def ingest_file(path: Path, pack: str):
    """(.mid → Recipe, reason) — Recipe None when refused; reason explains."""
    notes = read_midi(path)
    if not (4 <= len(notes) <= 2000):
        return None, f"note-count {len(notes)}"
    # chord/scale REFERENCE dumps (every note at one instant, e.g. "MIDI Scales
    # Reference" folders) are not phrases — they carry no rhythm to copy, and one as a
    # pad source is an every-bar chord blast (pack-002 audition: "all the notes hitting
    # at once on the downbeat"; 277 of them poisoned the r8 ingest).
    if len(notes) >= 6 and len({round(n["start"], 4) for n in notes}) < 2:
        return None, "no rhythm (single-instant chord/scale reference) — refused"
    meta = read_midi_meta(path)
    name = path.stem

    tempo = meta["tempo"] or bpm_from_name(name) or bpm_from_name(pack)
    if tempo is None:
        return None, "no tempo (meta or filename) — refused per r8"
    tempo_src = ("SMF meta" if meta["tempo"] else "filename")

    role = role_for(name, notes)
    labeled = meta["key"] or key_from_name(name) or key_from_name(pack)
    inferred, inf_conf = infer_key(notes)
    if role in DRUMISH:
        key_val, key_conf, key_ev = None, 0.0, []
    elif labeled and inferred and not _same_key(labeled, inferred):
        # the notes win over the label — record the disagreement for the r8 report
        key_val, key_conf = inferred, 0.6
        key_ev = [f"notes (Krumhansl) — label said {labeled!r}, notes disagree"]
    elif labeled:
        key_val, key_conf = labeled, (0.9 if meta["key"] else 0.8)
        key_ev = ["SMF key signature" if meta["key"] else "filename convention",
                  "verified against notes" if inferred and _same_key(labeled, inferred) else "unverified (thin notes)"]
    elif inferred:
        key_val, key_conf, key_ev = inferred, inf_conf, ["pitch-class inference (Krumhansl)"]
    else:
        key_val, key_conf, key_ev = None, 0.0, []

    rid = f"pack_{_slug(pack)[:24]}_{_slug(name)[:40]}_{role.value}"
    motif = R.Motif(
        bars=_bars(notes), onset_grid=_onset_grid(notes),
        density=round(len(notes) / max(1.0, _bars(notes)), 4),
        syncopation=_syncopation(notes), contour=_contour(notes),
        register_band="perc" if role in DRUMISH else _register(notes),
        harmonic_function=("progression" if role == R.Role.pad
                           else "root-candidate" if role in (R.Role.r808, R.Role.bass) else ""),
    )
    element = R.Element(
        element_id=rid, role=role, label=f"{pack[:22]} · {name[:34]} ({role.value})",
        midi=R.Midi(status=R.MidiStatus.extracted,
                    notes=[R.NoteEvent(pitch=int(n["pitch"]),
                                       start_beats=round(float(n["start"]), 6),
                                       duration_beats=round(max(float(n["length"]), 0.001), 6),
                                       velocity=max(1, min(127, int(n.get("velocity", 100)))))
                           for n in notes],
                    note_count=len(notes), confidence=1.0),
        motif=motif,
        bass=_bass(notes) if role in (R.Role.r808, R.Role.bass) else None,
        confidence=0.9,
    )
    rec = R.Recipe(
        recipe_id=rid,
        source=R.Source(platform="midi-pack", video_id=rid, title=f"{pack}/{path.name}",
                        license=R.License.licensed_pack,
                        content_hash=hashlib.sha256(path.read_bytes()).hexdigest()),
        meta=R.Meta(
            tempo_bpm=R.MetaField(value=int(round(float(tempo))), confidence=0.9,
                                  evidence=[tempo_src]),
            key=R.MetaField(value=key_val, confidence=key_conf, evidence=key_ev),
            time_signature=R.MetaField(value="4/4", confidence=0.6),
        ),
        arrangement=R.Arrangement(sections=[R.Section(
            name="loop", start_s=0.0,
            end_s=_bars(notes) * 4.0 * 60.0 / max(1.0, float(tempo)), confidence=0.5)]),
        elements=[element],
        reconstruction_class=R.ReconstructionClass.deterministic,
        yield_=R.YieldBlock(predicted=R.YieldScores(midi=1.0, arrangement=0.4, overall=0.6)),
    )
    return rec, tempo_src


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--packs", default="~/Downloads/musica")
    ap.add_argument("--library", default=str(_HERE / "library"))
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()

    root = Path(a.packs).expanduser()
    lib = Path(a.library)
    stats = {"written": 0, "dup": 0, "refused": 0, "error": 0, "keyDisagree": 0}
    by_role: dict[str, int] = {}
    items = []
    seen: set = set()
    # pre-seed dedupe with the EXISTING library's content signatures
    for p in sorted(lib.glob("*.json")):
        if p.stem.endswith(" 2"):
            continue
        try:
            rec = R.from_json(p.read_text())
            el0 = rec.elements[0]
            seen.add(hashlib.sha1((el0.role.value + "|" + "|".join(
                f"{n.pitch},{n.start_beats},{n.duration_beats}" for n in el0.midi.notes)).encode()).hexdigest())
        except Exception:
            continue

    mids = [p for p in sorted(root.rglob("*.mid")) if " 2" not in p.stem]
    for path in mids:
        if a.limit and stats["written"] >= a.limit:
            break
        pack = path.relative_to(root).parts[0] if path.relative_to(root).parts else "pack"
        try:
            rec, why = ingest_file(path, pack)
        except Exception as e:  # one bad file must not sink the batch
            stats["error"] += 1
            items.append({"file": str(path.name), "error": str(e)[:160]})
            continue
        if rec is None:
            stats["refused"] += 1
            items.append({"file": str(path.name), "refused": why})
            continue
        el0 = rec.elements[0]
        sig = hashlib.sha1((el0.role.value + "|" + "|".join(
            f"{n.pitch},{n.start_beats},{n.duration_beats}" for n in el0.midi.notes)).encode()).hexdigest()
        if sig in seen:
            stats["dup"] += 1
            continue
        seen.add(sig)
        if any("notes disagree" in e for e in rec.meta.key.evidence):
            stats["keyDisagree"] += 1
        if a.write:
            digest = (rec.source.content_hash or "")[:8]
            (lib / f"{rec.recipe_id}_{digest}.json").write_text(R.to_json(rec) + "\n")
        stats["written"] += 1
        by_role[el0.role.value] = by_role.get(el0.role.value, 0) + 1
        items.append({"file": path.name, "recipe": rec.recipe_id, "role": el0.role.value,
                      "notes": el0.midi.note_count, "tempo": rec.meta.tempo_bpm.value,
                      "key": rec.meta.key.value, "keyConf": rec.meta.key.confidence})

    # summary OUTSIDE the library dir (load_library globs *.json)
    (lib.parent / "pack_ingest_summary.json").write_text(
        json.dumps({"stats": stats, "byRole": by_role, "items": items}, indent=1) + "\n")
    print(f"pack ingest{' (DRY RUN)' if not a.write else ''}: "
          f"{stats['written']} recipe(s), roles={by_role}, dup={stats['dup']}, "
          f"refused={stats['refused']}, errors={stats['error']}, keyDisagree={stats['keyDisagree']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
