#!/usr/bin/env python3
"""curate_vital.py — W2.4 (produce lane, quality-pivot 2026-09): curate ~60 trap-relevant
Vital presets from the owner's full ~/Music/Vital library into
~/Library/Mosh/presets/vital/, so MoshOps' preset seam picks them up unchanged.

WHY a curated 60 instead of the raw 12.8k: cmdListPresets (src/moshops/MoshOps.Plugins.cpp)
is a NON-recursive per-plugin-dir scan of presets/<pluginKey>/ — every file in
presets/vital/ is one flat listing, so dumping the whole library in would make the
preset seam (and the produce-lane picker, ui/src/agent/loop/drumPalette.ts) choose
blind from thousands of untriaged patches, many placeholders/experiments/duplicates.
Curation is a REVIEWABLE, deterministic filter+score+copy, not a taste model — the
morning owner veto reads provenance.json to strike anything that sounds wrong, which
only works if every pick traces back to its source file, author folder and score.

Recursive scan: ~/Music/Vital/**/*.vital (12,911 files as of 2026-09-01, nested up to
3 deep under User/Presets/<pack>/...). Vital's own patch JSON carries no reliable
"category" field across third-party packs, so role bucketing is a filename+path REGEX
heuristic (checked in priority order, first match wins) against every path segment —
not just the filename — because many packs sort presets into Genre/Type folders
("vital_presets/Drum and Bass/Bass/11893_Campell - Would You.vital" has no "bass" in
its own filename, only its folder).

stdlib only, network-free, runnable as `python3 curate_vital.py` (repo test convention:
service/**/*_test.py is auto-discovered by the gate's py_tests).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Iterator, Optional

DEFAULT_ROOT = Path.home() / "Music" / "Vital"
DEFAULT_OUT = Path.home() / "Library" / "Mosh" / "presets" / "vital"

# Role buckets, checked in this order (first match wins) against the UPPERCASED,
# punctuation-collapsed "<every path segment under root> <filename>" text — so a preset
# classifies by its PACK'S folder taxonomy when its own filename is silent (see module
# docstring). Order matters: bass/lead/pluck/keys/bell/arp/fx are checked before the
# broad pad bucket (Pad|PD|Ambient|Atmos|Drone) so a "Dark Pad" inside a "Bass" folder
# still reads as the folder's bass, and only presets that hit nothing more specific fall
# through to pad.
ROLE_PATTERNS: list[tuple[str, "re.Pattern[str]"]] = [
    ("bass", re.compile(r"\b(BASS|BA|808|SUB)\b")),
    ("lead", re.compile(r"\b(LEAD|LD)\b")),
    ("pluck", re.compile(r"\b(PLUCK|PL)\b")),
    ("keys", re.compile(r"\b(KEYS?|PIANO|RHODES)\b")),
    ("bell", re.compile(r"\bBELLS?\b")),
    ("arp", re.compile(r"\b(ARP|SQ|SEQ)\b")),
    ("fx", re.compile(r"\b(FX|SFX|RISER)\b")),
    ("pad", re.compile(r"\b(PAD|PD|AMBIENT|ATMOS|DRONE)\b")),
]

# lead 10, pluck 8, pad 8, keys 8, bass 6, bell 6, arp 6, fx 8 = 60 (fx's quota also
# covers the "Atmos" hits that the pad regex above already claims first — the picker's
# own role-short fallback lists, e.g. "ambient(atmos|pad)", OR across buckets, so a
# single "pad" role satisfies both).
QUOTAS: dict[str, int] = {
    "lead": 10,
    "pluck": 8,
    "pad": 8,
    "keys": 8,
    "bass": 6,
    "bell": 6,
    "arp": 6,
    "fx": 8,
}
assert sum(QUOTAS.values()) == 60

TRAP_KEYWORDS = ["dark", "trap", "drill", "hyper", "rage", "plugg", "bell", "flute"]

# A pack/preset folder that announces itself as scaffolding, not a real sound.
DISQUALIFY = re.compile(r"\b(TEMPLATE|EXPERIMENT)\b", re.IGNORECASE)

PLACEHOLDER_STEMS = {"init", "new preset", "default", "untitled", "unnamed"}


def _tokenize_upper(text: str) -> str:
    """Collapse to uppercase words on non-alnum boundaries, so "Lucy_Blake-Sanity" and
    "Lead-High" both expose LEAD/BASS/etc. as whole tokens for the \\b-bounded regexes
    above (avoids "BA" matching inside "Databroth")."""
    return re.sub(r"[^A-Za-z0-9]+", " ", text).upper()


def classify_role(path: Path, root: Path) -> Optional[str]:
    rel = path.relative_to(root)
    search = _tokenize_upper(" ".join(rel.parts))
    for role, pattern in ROLE_PATTERNS:
        if pattern.search(search):
            return role
    return None


def preset_style(path: Path, root: Path) -> str:
    """Human-readable style guess: the deepest containing folder that isn't a bare
    "Presets"/"Preset"/"User" container — the closest thing to a genre/pack tag this
    library carries, since Vital's own JSON has no metadata field for it."""
    rel = path.relative_to(root)
    parts = rel.parts[:-1]
    for part in reversed(parts):
        if part.strip().lower() not in ("presets", "preset", "user"):
            return part
    return parts[-1] if parts else "uncategorized"


def author_key(path: Path, root: Path) -> str:
    """A coarse "pack" identity for diversity scoring: the first real path segment
    under root (skipping a constant User/Presets prefix, which every file shares and so
    carries no diversity signal)."""
    rel = path.relative_to(root)
    parts = rel.parts
    idx = 0
    while idx < len(parts) - 1 and parts[idx].strip().lower() in ("user", "presets"):
        idx += 1
    return parts[idx] if idx < len(parts) else (parts[0] if parts else "unknown")


def score_candidate(path: Path, root: Path) -> float:
    rel_lower = str(path.relative_to(root)).lower()
    score = 10.0
    for kw in TRAP_KEYWORDS:
        if kw in rel_lower:
            score += 3.0
    stem_lower = path.stem.lower().strip()
    normalized = re.sub(r"^[0-9_\-\s]+", "", stem_lower).strip()
    if not normalized or normalized in PLACEHOLDER_STEMS:
        score -= 20.0
    # A purely numeric stem (a raw pack ID with no name at all) reads as the least
    # curated of a bank's own entries.
    if re.fullmatch(r"[0-9]+", path.stem):
        score -= 5.0
    return score


def find_candidates(root: Path) -> Iterator[tuple[Path, str]]:
    for path in sorted(root.rglob("*.vital")):
        if not path.is_file():
            continue
        if DISQUALIFY.search(str(path)):
            continue
        role = classify_role(path, root)
        if role is None:
            continue
        yield path, role


def curate(
    root: Path,
    out_dir: Path,
    quotas: dict[str, int],
    dry_run: bool = False,
    limit: Optional[int] = None,
    roles: Optional[set] = None,
) -> list[dict]:
    scored: dict[str, list[tuple[float, Path]]] = defaultdict(list)
    for path, role in find_candidates(root):
        if role not in quotas:
            continue
        if roles and role not in roles:
            continue
        scored[role].append((score_candidate(path, root), path))

    picks: list[tuple[str, Path, float, str, str]] = []
    for role in sorted(scored):
        cands = scored[role]
        quota = quotas.get(role, 0)
        if limit is not None:
            quota = min(quota, limit)
        # Greedy selection with a LIVE author-diversity penalty: each already-picked
        # author makes further picks from that same author less attractive without a
        # hard ban, so one exceptional pack may still fill a small bucket if nothing
        # else scores close.
        pool = sorted(cands, key=lambda t: t[0], reverse=True)
        author_counts: dict[str, int] = defaultdict(int)
        picked_this_role: list[tuple[str, Path, float, str, str]] = []
        while len(picked_this_role) < quota and pool:
            best_idx = 0
            best_adjusted = None
            for i, (base_score, cand_path) in enumerate(pool):
                a = author_key(cand_path, root)
                adjusted = base_score - 2.0 * author_counts[a]
                if best_adjusted is None or adjusted > best_adjusted:
                    best_adjusted = adjusted
                    best_idx = i
            base_score, chosen_path = pool.pop(best_idx)
            a = author_key(chosen_path, root)
            author_counts[a] += 1
            picked_this_role.append((role, chosen_path, base_score, a, preset_style(chosen_path, root)))
        picks.extend(picked_this_role)

    if not dry_run:
        out_dir.mkdir(parents=True, exist_ok=True)

    provenance: list[dict] = []
    used_names: set = set()
    for role, path, score, author, style in picks:
        slug = re.sub(r"[^a-z0-9]+", "-", path.stem.lower()).strip("-") or "preset"
        dest_name = f"{role}-{slug}.vital"
        n = 2
        while dest_name in used_names:
            dest_name = f"{role}-{slug}-{n}.vital"
            n += 1
        used_names.add(dest_name)
        if not dry_run:
            (out_dir / dest_name).write_bytes(path.read_bytes())
        provenance.append(
            {
                "dest": dest_name,
                "role": role,
                "source_path": str(path),
                "author": author,
                "style": style,
                "score": round(score, 2),
            }
        )

    if not dry_run:
        (out_dir / "provenance.json").write_text(
            json.dumps({"version": 1, "count": len(provenance), "presets": provenance}, indent=2) + "\n",
            encoding="utf-8",
        )

    return provenance


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root", default=str(DEFAULT_ROOT), help="Vital library root (default ~/Music/Vital)")
    p.add_argument("--out", default=str(DEFAULT_OUT), help="curated output dir (default ~/Library/Mosh/presets/vital)")
    p.add_argument("--dry-run", action="store_true", help="score and report, copy nothing")
    p.add_argument("--limit", type=int, default=None, help="cap every role's quota (testing)")
    p.add_argument("--roles", default=None, help="comma-separated role subset, e.g. bass,lead")
    args = p.parse_args(argv)

    root = Path(args.root).expanduser()
    out_dir = Path(args.out).expanduser()
    roles = set(r.strip() for r in args.roles.split(",")) if args.roles else None

    if not root.is_dir():
        print(f"curate_vital: root not found: {root}", file=sys.stderr)
        return 1

    provenance = curate(root, out_dir, QUOTAS, dry_run=args.dry_run, limit=args.limit, roles=roles)
    by_role: dict[str, int] = defaultdict(int)
    for row in provenance:
        by_role[row["role"]] += 1

    dest_desc = "(dry-run, nothing copied)" if args.dry_run else f"-> {out_dir}"
    print(f"curate_vital: {len(provenance)} presets {dest_desc}")
    for role in sorted(by_role):
        print(f"  {role}: {by_role[role]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
