#!/usr/bin/env python3
"""Owner-catalog scrape: importer IR JSON → per-element library recipes.

The highest-leverage corpus bootstrap (2026-07 r8 lane): the producer's OWN
projects, parsed losslessly by the DAW importers (`npm run import -- x.flp
--json ir.json`), become per-element recipes — rights-clean by definition
(License.owner), taste-aligned by construction, with REAL tempo from the
project file (never a CLI default) and key inferred from pitch-class content
when the project doesn't carry one.

  .venv/python service/recipes/ingest_ir.py --ir-dir <dir of IR JSONs> \
      --library service/recipes/library [--limit N] [--min-notes 4]

Mirrors service/teardown/midi_ingest.py's motif/bass construction (the Codex
r7 reference) with the r8 fixes: real metadata + confidence/evidence trails,
clip-pattern dedup (FL playlists place the same pattern dozens of times), and
License.owner provenance. reconstruction_class stays `deterministic` here
because importer note extraction is lossless (100% clean-apply, exact note
counts — docs/MOSHI_IMPORTERS.md), unlike pack ingests or transcriptions.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
from pathlib import Path
from statistics import median

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from teardown import recipe as R  # noqa: E402

# ── role classification (name first, pitch-stats fallback — midi_ingest parity) ──
_NAME_ROLES = [
    (("808", "sub", "bass"), R.Role.r808),
    (("kick",), R.Role.kick),
    (("snare",), R.Role.snare),
    (("clap",), R.Role.clap),
    (("hat", "hihat", "hi_hat", "hi-hat"), R.Role.hat),
    (("perc", "rim", "shaker", "stomp"), R.Role.perc),
    (("chord", "progression", "pad", "keys", "piano", "rhodes"), R.Role.pad),
    (("lead", "melody", "melodic", "pluck", "arp", "synth", "flute", "bell"), R.Role.lead),
    (("vocal", "vox"), R.Role.vocal),
]


def role_for(track_name: str, notes: list[dict]) -> R.Role:
    # TOKEN match, never substring — 'hat' inside 'that'/'hate' shipped 15 melodies as
    # hi-hats (2026-07 audit). Tokens split on non-alphanumerics; compound keys collapse.
    name = track_name.lower()
    tokens = set(re.split(r"[^a-z0-9#]+", name))
    tokens.discard("")
    joined = name.replace(" ", "").replace("-", "").replace("_", "")
    for keys, role in _NAME_ROLES:
        for k in keys:
            flat = k.replace("_", "").replace("-", "")
            if k in tokens or (len(flat) > 4 and flat in joined and flat not in ("melodic",)):
                return role
    pitches = [int(n["pitch"]) for n in notes]
    if not pitches:
        return R.Role.other
    mean_len = sum(float(n["length"]) for n in notes) / max(1, len(notes))
    if max(pitches) <= 51 and mean_len <= 0.75:
        return R.Role.perc
    if median(pitches) <= 45:
        return R.Role.r808
    starts: dict[float, set[int]] = {}
    for n in notes:
        starts.setdefault(round(float(n["start"]), 3), set()).add(int(n["pitch"]))
    if any(len(p) >= 3 for p in starts.values()):
        return R.Role.pad
    return R.Role.lead


# ── key inference: Krumhansl-Schmuckler profiles over pitch classes ──────────────
_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def infer_key(all_notes: list[dict]) -> tuple[str | None, float]:
    if len(all_notes) < 8:
        return None, 0.0
    hist = [0.0] * 12
    for n in all_notes:
        hist[int(n["pitch"]) % 12] += float(n["length"])
    if sum(hist) <= 0:
        return None, 0.0
    def corr(profile: list[float], rot: int) -> float:
        p = profile[-rot:] + profile[:-rot]
        mp, mh = sum(p) / 12, sum(hist) / 12
        num = sum((p[i] - mp) * (hist[i] - mh) for i in range(12))
        den = math.sqrt(sum((x - mp) ** 2 for x in p) * sum((x - mh) ** 2 for x in hist))
        return num / den if den else 0.0
    best = max(
        [(corr(_MAJOR, r), f"{_NAMES[r]} major") for r in range(12)]
        + [(corr(_MINOR, r), f"{_NAMES[r]} minor") for r in range(12)],
        key=lambda t: t[0],
    )
    score, key = best
    return (key, round(min(0.75, max(0.3, score)), 3)) if score > 0.5 else (None, 0.0)


# ── motif features (midi_ingest parity) ──────────────────────────────────────────
def _bars(notes: list[dict]) -> float:
    end = max((float(n["start"]) + float(n["length"]) for n in notes), default=0.0)
    return float(max(1, math.ceil(end / 4.0)))


def _onset_grid(notes: list[dict]) -> str:
    starts = sorted({round(float(n["start"]), 6) for n in notes})
    gaps = [b - a for a, b in zip(starts, starts[1:]) if b - a > 1e-6]
    if not gaps:
        return "single"
    s = min(gaps)
    if abs(s - 1 / 3) < 0.04 or abs(s - 2 / 3) < 0.04:
        return "triplet"
    if s <= 0.25 + 1e-6:
        return "16th"
    if s <= 0.5 + 1e-6:
        return "8th"
    if s <= 1.0 + 1e-6:
        return "4th"
    return "half" if s <= 2.0 + 1e-6 else "whole"


def _register(notes: list[dict]) -> str:
    mid = median(int(n["pitch"]) for n in notes)
    return "sub" if mid <= 43 else "low" if mid <= 55 else "mid" if mid <= 72 else "high"


def _contour(notes: list[dict]) -> list[int]:
    o = sorted(notes, key=lambda n: (float(n["start"]), int(n["pitch"])))
    return [1 if int(b["pitch"]) > int(a["pitch"]) else (-1 if int(b["pitch"]) < int(a["pitch"]) else 0) for a, b in zip(o, o[1:33])]


def _syncopation(notes: list[dict]) -> float:
    off = sum(1 for n in notes if abs(float(n["start"]) - round(float(n["start"]))) > 0.05)
    return round(off / len(notes), 4) if notes else 0.0


def _bass(notes: list[dict]) -> R.Bass:
    starts = sorted(float(n["start"]) for n in notes)
    gaps = [b - a for a, b in zip(starts, starts[1:])] or [1.0]
    mean_len = sum(float(n["length"]) for n in notes) / max(1, len(notes))
    return R.Bass(sustain_ratio=round(min(1.0, mean_len / max(0.25, sum(gaps) / len(gaps))), 4), root_follows=False)


def _slug(v: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", v.lower()).strip("_")[:48] or "x"


DRUMISH = {R.Role.kick, R.Role.snare, R.Role.hat, R.Role.clap, R.Role.perc}


def recipes_from_ir(ir_path: Path, min_notes: int, max_elements: int) -> list[R.Recipe]:
    doc = json.loads(ir_path.read_text())
    ir = doc.get("ir") or doc
    session = ir["session"]
    tempo = session.get("tempo")
    project = _slug(ir_path.stem.split("_", 1)[-1])
    src_hash = hashlib.sha256(ir_path.read_bytes()).hexdigest()

    all_notes = [n for t in session["tracks"] for c in t["clips"] for n in (c.get("notes") or [])]
    key_val, key_conf = infer_key(all_notes)
    ir_key = session.get("key")
    if ir_key:
        key_val, key_conf, key_evidence = str(ir_key), 0.95, ["project file key"]
    else:
        key_evidence = ["pitch-class inference (Krumhansl)"] if key_val else []

    # Rank tracks so scarce roles survive the per-project cap: 808/bass first, then
    # drums, then harmonic/melodic — the audit found first-N-in-track-order dropped ALL
    # drum DNA (31 projects lost their only 808; library had zero kick/snare recipes).
    def _track_priority(t):
        notes_all = [n for c in t["clips"] for n in (c.get("notes") or [])]
        r = role_for(t.get("name") or "", notes_all) if notes_all else R.Role.other
        order = {R.Role.r808: 0, R.Role.bass: 0, R.Role.kick: 1, R.Role.snare: 1,
                 R.Role.clap: 1, R.Role.hat: 2, R.Role.perc: 2, R.Role.pad: 3, R.Role.lead: 4}
        return (order.get(r, 5), -len(notes_all))

    out: list[R.Recipe] = []
    for t in sorted(session["tracks"], key=_track_priority):
        # dedupe repeated pattern placements → distinct patterns, keep the densest
        patterns: dict[str, tuple[int, list[dict]]] = {}
        name_l = (t.get("name") or "").lower()
        drum_named = any(k in re.split(r"[^a-z0-9#]+", name_l) for k in
                         ("kick", "snare", "clap", "hat", "hihat", "perc", "rim", "shaker"))
        floor = 2 if drum_named else min_notes  # 2-hit snare/clap patterns are real trap DNA
        for c in t["clips"]:
            notes = c.get("notes") or []
            if len(notes) < floor:
                continue
            sig = hashlib.sha1(json.dumps(sorted([(n["pitch"], n["start"], n["length"]) for n in notes]), sort_keys=True).encode()).hexdigest()
            cnt, _ = patterns.get(sig, (0, notes))
            patterns[sig] = (cnt + 1, notes)
        if not patterns:
            continue
        # the most-placed distinct pattern is the track's signature motif
        placements, notes = max(patterns.values(), key=lambda x: (x[0], len(x[1])))
        role = role_for(t.get("name") or "", notes)
        rid = f"owner_{project}_{_slug(t.get('name') or 'track')}_{role.value}"
        motif = R.Motif(
            bars=_bars(notes),
            onset_grid=_onset_grid(notes),
            density=round(len(notes) / max(1.0, _bars(notes)), 4),
            syncopation=_syncopation(notes),
            contour=_contour(notes),
            register_band="perc" if role in DRUMISH else _register(notes),
            harmonic_function="progression" if role == R.Role.pad else ("root-candidate" if role in (R.Role.r808, R.Role.bass) else ""),
        )
        element = R.Element(
            element_id=rid,
            role=role,
            label=f"{project} · {t.get('name') or 'track'} ({role.value})",
            midi=R.Midi(
                status=R.MidiStatus.extracted,
                notes=[R.NoteEvent(pitch=int(n["pitch"]), start_beats=round(float(n["start"]), 6), duration_beats=round(max(float(n["length"]), 0.001), 6), velocity=max(1, min(127, int(n.get("velocity", 100))))) for n in notes],
                note_count=len(notes),
                confidence=1.0,
            ),
            motif=motif,
            bass=_bass(notes) if role in (R.Role.r808, R.Role.bass) else None,
            confidence=0.9,
        )
        rec = R.Recipe(
            recipe_id=rid,
            source=R.Source(platform="owner-catalog", video_id=rid, title=ir_path.stem, license=R.License.owner, content_hash=src_hash),
            meta=R.Meta(
                daw=R.MetaField(value="flstudio", confidence=0.95, evidence=["importer format"]),
                tempo_bpm=R.MetaField(value=int(round(float(tempo))) if tempo else None, confidence=0.95 if tempo else 0.0, evidence=["project file tempo"] if tempo else []),
                key=R.MetaField(value=key_val, confidence=key_conf, evidence=key_evidence),
                time_signature=R.MetaField(value="4/4", confidence=0.6),
            ),
            arrangement=R.Arrangement(sections=[R.Section(name="loop", start_s=0.0, end_s=_bars(notes) * 4.0 * 60.0 / max(1.0, float(tempo or 120)), confidence=0.5)]),
            elements=[element],
            reconstruction_class=R.ReconstructionClass.deterministic,
            yield_=R.YieldBlock(predicted=R.YieldScores(midi=1.0, arrangement=0.5, overall=0.7)),
        )
        out.append(rec)
        if len(out) >= max_elements:
            break
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ir-dir", required=True)
    ap.add_argument("--library", required=True)
    ap.add_argument("--limit", type=int, default=0, help="cap total recipes")
    ap.add_argument("--min-notes", type=int, default=4)
    ap.add_argument("--max-elements", type=int, default=10, help="per project (role-priority ranked)")
    a = ap.parse_args()

    lib = Path(a.library)
    lib.mkdir(parents=True, exist_ok=True)
    total = 0
    by_role: dict[str, int] = {}
    summary = []
    seen_content: set[str] = set()  # cross-project dedupe: multi-save FLPs ship identical elements
    for ir_path in sorted(Path(a.ir_dir).glob("*.json")):
        try:
            recs = recipes_from_ir(ir_path, a.min_notes, a.max_elements)
        except Exception as e:  # a bad IR must not sink the batch
            summary.append({"ir": ir_path.name, "error": str(e)[:200]})
            continue
        for rec in recs:
            if a.limit and total >= a.limit:
                break
            el0 = rec.elements[0]
            sig = hashlib.sha1((el0.role.value + "|" + "|".join(
                f"{n.pitch},{n.start_beats},{n.duration_beats}" for n in el0.midi.notes)).encode()).hexdigest()
            if sig in seen_content:
                continue  # a re-save of the same project (audit: 'ok' ingested 4x)
            seen_content.add(sig)
            digest = (rec.source.content_hash or "")[:8]
            (lib / f"{rec.recipe_id}_{digest}.json").write_text(R.to_json(rec) + "\n")
            total += 1
            by_role[rec.elements[0].role.value] = by_role.get(rec.elements[0].role.value, 0) + 1
            summary.append({"ir": ir_path.name, "recipe": rec.recipe_id, "role": rec.elements[0].role.value, "notes": rec.elements[0].midi.note_count, "tempo": rec.meta.tempo_bpm.value, "key": rec.meta.key.value})
    # summary lives OUTSIDE the library dir — load_library() globs *.json and would
    # otherwise ingest it as a recipe (the moshfx " 2.json" double-load bug class)
    (lib.parent / "owner_ingest_summary.json").write_text(json.dumps({"total": total, "byRole": by_role, "items": summary}, indent=2) + "\n")
    print(f"owner-catalog ingest: {total} recipe(s) → {lib}  roles={by_role}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
