#!/usr/bin/env python3
"""Grid-truth repair over the recipe library (pack-003 beat 12: "out-of-time elements...
make sure that everything is locked to the grid").

~21% of owner-catalog transcriptions carry off-grid note timing (wrong-BPM transcription
artifacts; worst element: 20% of notes on-grid). Policy, owner-ratified: SNAP starts to
the element's own best grid (1/16 vs 1/12, never a union) when within ±0.06 beats,
PRESERVE consistent swing (never snapped), and DELETE recipes whose every element stays
below the 0.8 post-snap on-grid floor — the unsalvageable wrong-tempo class. Durations
untouched. Same shape as the #206 scale-reference prune (one-time repair + ingest
refusal + generate-time pred as defense in depth). Idempotent: a second run is a no-op.

    python3 service/recipes/repair_grid.py            # dry-run report
    python3 service/recipes/repair_grid.py --write    # snap + prune + rewrite

Summary lands OUTSIDE the library dir (glob-ingestion bug class):
service/recipes/grid_repair_summary.json
"""
from __future__ import annotations

import glob
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(_HERE)
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

from teardown import recipe as R  # noqa: E402
from recipes.generate import GRID_FLOOR, grid_fraction, snap_notes  # noqa: E402
from recipes.ingest_ir import _onset_grid, _syncopation  # noqa: E402

LIB_DIR = os.path.join(_HERE, "library")
SUMMARY = os.path.join(_HERE, "grid_repair_summary.json")


def _note_dicts(el) -> list:
    return [{"start": float(n.start_beats), "length": float(n.duration_beats),
             "pitch": int(n.pitch)} for n in el.midi.notes]


def repair(lib_dir: str = LIB_DIR, write: bool = False) -> dict:
    stats = {"recipes": 0, "snapped_notes": 0, "elements_snapped": 0,
             "deleted_recipes": [], "removed_elements": [], "rewritten": 0}
    for path in sorted(glob.glob(os.path.join(lib_dir, "*.json"))):
        if os.path.basename(path).split(".")[0].endswith(" 2"):
            continue
        rec = R.from_json(open(path).read())
        stats["recipes"] += 1
        changed = False
        keep_elements = []
        for el in rec.elements:
            if not el.midi.notes:
                keep_elements.append(el)
                continue
            # snap to FIXED POINT with the grid PINNED once per element: re-choosing the
            # argmax grid between passes can oscillate on ~50/50 straight/triplet
            # material; with a fixed step, passes are monotone and converge.
            from recipes.generate import _element_grid_step
            step = _element_grid_step(el.midi.notes)
            n_snapped = 0
            for _ in range(8):
                k = snap_notes(el, step=step)
                n_snapped += k
                if k == 0:
                    break
            if n_snapped:
                stats["snapped_notes"] += n_snapped
                stats["elements_snapped"] += 1
                changed = True
                if el.motif is not None:
                    nd = _note_dicts(el)
                    el.motif.onset_grid = _onset_grid(nd)
                    el.motif.syncopation = _syncopation(nd)
            if grid_fraction(el) < GRID_FLOOR:
                stats["removed_elements"].append(
                    {"recipe": rec.source.video_id, "role": el.role.value,
                     "gridFraction": round(grid_fraction(el), 3)})
                changed = True
                continue                      # element dropped from the recipe
            keep_elements.append(el)
        note_bearing = [e for e in keep_elements if e.midi.notes]
        if not note_bearing:
            stats["deleted_recipes"].append(rec.source.video_id)
            if write:
                os.remove(path)
            continue
        if changed and write:
            rec.elements = keep_elements
            with open(path, "w") as f:
                f.write(R.to_json(rec))
            stats["rewritten"] += 1
    return stats


def main(argv=None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    write = "--write" in argv
    stats = repair(write=write)
    print(f"recipes scanned {stats['recipes']}  elements snapped {stats['elements_snapped']} "
          f"({stats['snapped_notes']} notes)  below-floor elements removed "
          f"{len(stats['removed_elements'])}  recipes deleted {len(stats['deleted_recipes'])}"
          f"  rewritten {stats['rewritten']}")
    if write:
        with open(SUMMARY, "w") as f:
            json.dump(stats, f, indent=1)
        print(f"summary → {SUMMARY}")
    else:
        print("dry-run — pass --write to apply")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
