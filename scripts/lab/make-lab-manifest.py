#!/usr/bin/env python3
"""make-lab-manifest.py — W2.3 lab source (produce lane, quality-pivot 2026-09): a
second, LAB-ONLY palette manifest built from the owner's actual Live-set drum kit
("15drtt Maniac Vol.1 Kit", staged under ~/Downloads/newdrummer/…) instead of the
curated palette-v2 library. Its whole purpose is the A/B sound-matched replay
(scripts/produce-lane/*, ui/scripts/produceReplay.mts --swap): the SAME notes the
picker/model wrote, rendered with the owner's own Live-set wavs in place, so the
overnight package can compare "the product's palette" against "his actual sounds"
without ever writing into palette-v2 itself.

Shape: identical to a real list_palette manifest ({items: [{path, role_guess,
root_note?, root_source?, content_hash, kind}]}) — MoshOps' cmdListPalette (W2.2) reads
either indifferently via MOSH_PALETTE_MANIFEST / {manifest} arg.

Ten drum-rack pads + two 808s = 12 items, matching
ui/src/agent/loop/drumPalette.ts's fixed W2.3 lane map exactly:
  36 kick · 38 snare · 37 snare2 · 39 clap · 40 clap2 · 42 hat · 46 openhat ·
  41 perc · 43 fx · 44 roll         (role_guess only — a drum pad's pitch comes from
                                      the LANE, not a measured root_note)
  808 x2                            (role_guess "bass", root_note MEASURED — see below)
No dedicated "drum roll" one-shot exists in this pack; a rim hit (perc/rims) stands in
for the "roll" pad — the closest thing this kit offers to a fill/roll accent.

808 pitch: both 808 one-shots in this kit measure to MIDI 24 (C1) — confirmed by ear/
inspection and re-verified here programmatically via
service/recipes/measure_palette_pitch.py::measure_f0 (autocorrelation + spectral-peak
cross-check) WHEN that module's dependencies (numpy, soundfile) are importable on this
machine; when they are not, this script falls back to the pre-measured constant 24 and
tags the row root_source:"measured-2026-09-02" so a later re-run on a fuller machine can
tell a REAL measurement from this fallback.

808 sub energy (R2.6, correction note 6 — "808 / low end weak or wrong"): each 808 also
gets `sub_energy_db`/`rms_db` from service/presets/measure_sub.py's 30-120 Hz band-RMS
measurement, the SAME field drumPalette.ts's pickDrumPalette (W2.3) reads to prefer the
loudest-sub 808 over the pre-round-2 nearest-root-to-60 fallback. measure_sub is
stdlib(+numpy)-only — no soundfile/librosa dependency chain to fail — but the call is
still wrapped defensively: a lab manifest must never fail to generate over a
measurement hiccup, same as the pitch fallback above.

Run: `python3 scripts/lab/make-lab-manifest.py` (writes
~/Library/Mosh/lab-manifests/15drtt-jerk-r0.json). `--dry-run` prints without writing;
`--out` overrides the destination (tests use a tempdir).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Optional

REPO_ROOT = Path(__file__).resolve().parents[2]
MEASURE_MODULE_DIR = REPO_ROOT / "service" / "recipes"
MEASURE_SUB_MODULE_DIR = REPO_ROOT / "service" / "presets"

KIT_ROOT = (
    Path.home()
    / "Downloads"
    / "newdrummer"
    / "drive-download-20260901T045650Z-1-001"
    / "15drtt Maniac Vol.1 Kit"
)

DEFAULT_OUT = Path.home() / "Library" / "Mosh" / "lab-manifests" / "15drtt-jerk-r0.json"

FALLBACK_808_ROOT_NOTE = 24
FALLBACK_808_ROOT_SOURCE = "measured-2026-09-02"

# (role_guess, relative path under KIT_ROOT). Order matches the W2.3 pad map
# (36/38/37/39/40/42/46/41/43/44), then the two 808 bass items.
LAB_ITEMS: list[tuple[str, str]] = [
    ("kick", "kicks/@15drtt hard kick.wav"),
    ("snare", "snares/@15drtt crack snare.wav"),
    ("snare2", "snares/@15drtt full snare.wav"),
    ("clap", "claps/@15drtt classicone clap.wav"),
    ("clap2", "claps/@15drtt classictwo clap.wav"),
    ("hat", "hhats/@15drtt boss hhat.wav"),
    ("openhat", "ohats & cymbals/@15drtt cool ohat.wav"),
    ("perc", "perc/@15drtt bestclick perc.wav"),
    ("fx", "fx/@15drtt scratch fx.wav"),
    ("roll", "perc/rims/@15drtt forever rim.wav"),  # no dedicated roll one-shot — see docstring
    ("bass", "808s/@15drtt boss 808.wav"),
    ("bass", "808s/@15drtt trapp 808.wav"),
]

BASS_ROLE = "bass"


def content_hash_of(path: Path) -> str:
    """16-hex-char sha256 prefix of the RAW file bytes — matches the observed
    content_hash length in the real palette-v2 manifest (a dedup/provenance key, not a
    cryptographic one, so no need for the full digest or an audio decode)."""
    h = hashlib.sha256(path.read_bytes()).hexdigest()
    return h[:16]


def _try_import_measure_f0():
    """Return measure_f0 if service/recipes/measure_palette_pitch.py and its deps
    (numpy, soundfile) import cleanly on this machine, else None. Import errors from
    EITHER the module or its runtime deps must not crash manifest generation — the
    fallback constant exists exactly for this."""
    sys.path.insert(0, str(MEASURE_MODULE_DIR))
    try:
        import measure_palette_pitch  # type: ignore

        import numpy  # noqa: F401  — measure_f0 imports these lazily; probe eagerly here
        import soundfile  # noqa: F401

        return measure_palette_pitch.measure_f0
    except Exception:
        return None
    finally:
        if str(MEASURE_MODULE_DIR) in sys.path:
            sys.path.remove(str(MEASURE_MODULE_DIR))


def measure_808_root(path: Path, measure_f0) -> tuple[int, str]:
    """(root_note, root_source) for one 808 one-shot. Falls back to the pre-measured
    constant on any failure (missing deps, unmeasurable audio) — a lab manifest must
    never fail to generate over a pitch-measurement hiccup."""
    if measure_f0 is None:
        return FALLBACK_808_ROOT_NOTE, FALLBACK_808_ROOT_SOURCE
    try:
        midi_float, confidence, _detail = measure_f0(str(path))
    except Exception:
        return FALLBACK_808_ROOT_NOTE, FALLBACK_808_ROOT_SOURCE
    if midi_float is None or confidence == "unmeasurable":
        return FALLBACK_808_ROOT_NOTE, FALLBACK_808_ROOT_SOURCE
    return int(round(midi_float)), "measured"


def _try_import_measure_sub():
    """Return measure_sub.measure_band_energy if service/presets/measure_sub.py imports
    cleanly on this machine, else None. Unlike measure_palette_pitch, measure_sub has no
    soundfile/librosa dependency chain to fail on (stdlib, numpy optional) — but the
    import is still guarded the same defensive way as _try_import_measure_f0 above, so
    a broken/missing module can never crash manifest generation."""
    sys.path.insert(0, str(MEASURE_SUB_MODULE_DIR))
    try:
        import measure_sub  # type: ignore

        return measure_sub.measure_band_energy
    except Exception:
        return None
    finally:
        if str(MEASURE_SUB_MODULE_DIR) in sys.path:
            sys.path.remove(str(MEASURE_SUB_MODULE_DIR))


def measure_808_sub_energy(path: Path, measure_band_energy) -> Optional[dict]:
    """{"sub_energy_db": ..., "rms_db": ...} for one 808 one-shot, or None on any
    failure (module unavailable, unreadable/corrupt audio) — R2.6 (correction note 6),
    consumed by drumPalette.ts's pickDrumPalette to prefer the loudest-sub 808 over the
    pre-round-2 nearest-root-to-60 fallback. Never raises."""
    if measure_band_energy is None:
        return None
    try:
        result = measure_band_energy(path)
    except Exception:
        return None
    return {"sub_energy_db": result["sub_energy_db"], "rms_db": result["rms_db"]}


def build_manifest(kit_root: Path = KIT_ROOT, items: list[tuple[str, str]] = LAB_ITEMS) -> dict:
    measure_f0 = _try_import_measure_f0()
    measure_band_energy = _try_import_measure_sub()
    bass_seen = 0
    out_items = []
    for role, rel in items:
        path = kit_root / rel
        if not path.is_file():
            raise FileNotFoundError(f"make-lab-manifest: expected lab source file missing: {path}")
        entry = {
            "content_hash": content_hash_of(path),
            "kind": "oneshot",
            "path": str(path),
            "role_guess": role,
        }
        if role == BASS_ROLE:
            bass_seen += 1
            root_note, root_source = measure_808_root(path, measure_f0)
            entry["root_note"] = root_note
            entry["root_source"] = root_source
            sub_energy = measure_808_sub_energy(path, measure_band_energy)
            if sub_energy is not None:
                entry["sub_energy_db"] = sub_energy["sub_energy_db"]
                entry["rms_db"] = sub_energy["rms_db"]
        out_items.append(entry)

    if bass_seen != 2:
        raise ValueError(f"make-lab-manifest: expected exactly 2 bass(808) items, found {bass_seen}")
    if len(out_items) != 12:
        raise ValueError(f"make-lab-manifest: expected exactly 12 items, built {len(out_items)}")

    return {
        "version": 1,
        "source": "lab (owner's Live-set kit, NOT palette-v2 — see module docstring)",
        "kit": "15drtt Maniac Vol.1 Kit",
        "count": len(out_items),
        "items": out_items,
    }


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--kit-root", default=str(KIT_ROOT))
    p.add_argument("--out", default=str(DEFAULT_OUT))
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args(argv)

    kit_root = Path(args.kit_root)
    if not kit_root.is_dir():
        print(f"make-lab-manifest: kit root not found: {kit_root}", file=sys.stderr)
        return 1

    try:
        manifest = build_manifest(kit_root, LAB_ITEMS)
    except (FileNotFoundError, ValueError) as e:
        print(f"make-lab-manifest: {e}", file=sys.stderr)
        return 1

    text = json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    if args.dry_run:
        print(text)
        return 0

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(text, encoding="utf-8")

    by_role: dict[str, int] = {}
    for row in manifest["items"]:
        by_role[row["role_guess"]] = by_role.get(row["role_guess"], 0) + 1
    print(f"make-lab-manifest: wrote {out_path} ({manifest['count']} items)")
    for role in sorted(by_role):
        print(f"  {role}: {by_role[role]}")
    for row in manifest["items"]:
        if row["role_guess"] == BASS_ROLE:
            sub_desc = (
                f"sub_energy_db={row['sub_energy_db']} rms_db={row['rms_db']}"
                if "sub_energy_db" in row
                else "sub_energy_db=<unmeasured>"
            )
            print(f"  bass root_note={row['root_note']} root_source={row['root_source']} {sub_desc} <- {row['path']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
