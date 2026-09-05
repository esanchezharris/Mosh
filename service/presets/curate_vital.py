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

# R2.2 (produce-r1-2026-09-02.meta.json note 2): the round's arp preset
# ("arp-lucy-blake-dpo-broken-wings-sq-1", an SQ/sequence patch with its own baked-in
# motion) sounds identical whatever notes the model writes — fine for the `arp` role,
# where that self-playing character is the point, but exactly wrong for anything else. A
# sequenced/arpeggiated patch is disqualified from every OTHER role even when its folder
# taxonomy or filename would otherwise classify it as e.g. "lead" or "pad" (first-match
# in ROLE_PATTERNS only picks the BUCKET; this is an independent, role-blind veto).
SEQUENCE_PATTERN = re.compile(r"\b(SQ|SEQ|SEQUENCE|ARP)\b")

# R2.2 (note 2): the round's stab preset, "keys-10924-cowbell-trap-6", is a COWBELL one-
# shot that only landed in the `keys` role because its PACK folder was named "Keys" —
# classify_role has no way to see past that. A percussive/drum-family preset must never
# fill a melodic role (bells are the one exception: they belong in the dedicated `bell`
# role, never here).
PERCUSSIVE_PATTERN = re.compile(r"\b(COWBELLS?|BELLS?|PERCS?|DRUMS?|KICKS?|SNARES?|HATS?|808)\b")
PERCUSSIVE_EXCLUDE_ROLES = {"keys", "lead", "pad", "pluck"}


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


def is_sequence_patch(path: Path, root: Path) -> bool:
    """True if this preset carries a sequence/arpeggiator marker (filename OR any
    containing folder) — the R2.2 role-blind veto: such patches only ever belong in the
    `arp` role, regardless of what bucket classify_role would otherwise pick."""
    rel = path.relative_to(root)
    search = _tokenize_upper(" ".join(rel.parts))
    if SEQUENCE_PATTERN.search(search):
        return True
    return preset_style(path, root).strip().lower() == "sequence"


def is_offrole_percussive(path: Path, root: Path, role: Optional[str]) -> bool:
    """True if `role` is one of the melodic roles a drum/perc-family preset must never
    fill (R2.2: "keys-10924-cowbell-trap-6" landed in `keys` purely from its pack's
    folder name). Bells are exempt in the dedicated `bell` role only."""
    if role not in PERCUSSIVE_EXCLUDE_ROLES:
        return False
    rel = path.relative_to(root)
    search = _tokenize_upper(" ".join(rel.parts))
    return bool(PERCUSSIVE_PATTERN.search(search))


def score_candidate(path: Path, root: Path) -> tuple[float, list[str]]:
    """(score, reasons) — reasons is a short, owner-readable audit trail of every
    adjustment folded into the score, carried through to provenance.json and REVIEW.md
    so a veto decision doesn't require re-deriving why a pick scored the way it did."""
    rel_lower = str(path.relative_to(root)).lower()
    score = 10.0
    reasons = ["base 10.0"]
    hit_keywords = [kw for kw in TRAP_KEYWORDS if kw in rel_lower]
    if hit_keywords:
        score += 3.0 * len(hit_keywords)
        reasons.append(f"trap keyword(s) {', '.join(hit_keywords)} (+3.0 each)")
    stem_lower = path.stem.lower().strip()
    normalized = re.sub(r"^[0-9_\-\s]+", "", stem_lower).strip()
    if not normalized or normalized in PLACEHOLDER_STEMS:
        score -= 20.0
        reasons.append("placeholder-looking name (-20.0)")
    # A purely numeric stem (a raw pack ID with no name at all) reads as the least
    # curated of a bank's own entries.
    if re.fullmatch(r"[0-9]+", path.stem):
        score -= 5.0
        reasons.append("purely numeric filename, no name at all (-5.0)")
    return score, reasons


def find_candidates(root: Path) -> Iterator[tuple[Path, str]]:
    for path in sorted(root.rglob("*.vital")):
        if not path.is_file():
            continue
        if DISQUALIFY.search(str(path)):
            continue
        role = classify_role(path, root)
        if role is None:
            continue
        if role != "arp" and is_sequence_patch(path, root):
            continue
        if is_offrole_percussive(path, root, role):
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
    scored: dict[str, list[tuple[float, list[str], Path]]] = defaultdict(list)
    for path, role in find_candidates(root):
        if role not in quotas:
            continue
        if roles and role not in roles:
            continue
        score, reasons = score_candidate(path, root)
        scored[role].append((score, reasons, path))

    picks: list[tuple[str, Path, float, list[str], str, str]] = []
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
        picked_this_role: list[tuple[str, Path, float, list[str], str, str]] = []
        while len(picked_this_role) < quota and pool:
            best_idx = 0
            best_adjusted = None
            for i, (base_score, _reasons, cand_path) in enumerate(pool):
                a = author_key(cand_path, root)
                adjusted = base_score - 2.0 * author_counts[a]
                if best_adjusted is None or adjusted > best_adjusted:
                    best_adjusted = adjusted
                    best_idx = i
            base_score, base_reasons, chosen_path = pool.pop(best_idx)
            a = author_key(chosen_path, root)
            author_counts[a] += 1
            picked_this_role.append(
                (role, chosen_path, base_score, base_reasons, a, preset_style(chosen_path, root))
            )
        picks.extend(picked_this_role)

    # REVIEW.md and provenance.json are always written (dry-run included) — they're the
    # owner's veto surface, cheap text, and exactly what a "preview before I copy 60
    # files" run needs to show. Only the actual .vital binary copies are dry-run-gated.
    out_dir.mkdir(parents=True, exist_ok=True)

    provenance: list[dict] = []
    used_names: set = set()
    for role, path, score, reasons, author, style in picks:
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
                "reasons": reasons,
            }
        )

    (out_dir / "provenance.json").write_text(
        json.dumps({"version": 1, "count": len(provenance), "presets": provenance}, indent=2) + "\n",
        encoding="utf-8",
    )
    (out_dir / "REVIEW.md").write_text(_render_review_md(provenance), encoding="utf-8")

    return provenance


def _render_review_md(provenance: list[dict]) -> str:
    """role -> preset file -> source pack/author -> one-line why, grouped by role so the
    owner can scan a bucket at a time and veto by name before the next curation run
    overwrites this file (deterministic — a veto has to happen out-of-band, e.g. by
    telling the next run's operator which dest/source to drop)."""
    by_role: dict[str, list[dict]] = defaultdict(list)
    for row in provenance:
        by_role[row["role"]].append(row)

    lines = [
        "# Vital preset curation review",
        "",
        "Auto-generated by `service/presets/curate_vital.py` — deterministic, and",
        "OVERWRITTEN on every run. To veto a pick, tell the owner which `preset file` to",
        "exclude before the next run (the exclusion itself is a manual step outside this",
        "script today); `provenance.json` in this same directory carries the full",
        "score + reasons trail behind the one-line `why` below.",
        "",
    ]
    for role in sorted(by_role):
        rows = by_role[role]
        lines.append(f"## {role} ({len(rows)})")
        lines.append("")
        lines.append("| preset file | source pack/author | why |")
        lines.append("|---|---|---|")
        for row in rows:
            why = "; ".join(row.get("reasons") or []) or f"score {row['score']}"
            source_label = f"{row['author']} — {row['style']}"
            lines.append(f"| `{row['dest']}` | {source_label} | {why} |")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


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

    dest_desc = (
        f"(dry-run, no .vital copied; REVIEW.md/provenance.json -> {out_dir})"
        if args.dry_run
        else f"-> {out_dir}"
    )
    print(f"curate_vital: {len(provenance)} presets {dest_desc}")
    for role in sorted(by_role):
        print(f"  {role}: {by_role[role]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
