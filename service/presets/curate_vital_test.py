#!/usr/bin/env python3
"""Tests for curate_vital.py (W2.4). Hermetic and network-free: builds a synthetic
"Vital library" of .vital files under a tempdir (never touches the owner's real
~/Music/Vital or ~/Library/Mosh/presets), so this proves the CURATION LOGIC
(role classification, scoring, quota-capping, diversity, provenance shape, disqualify/
placeholder filtering, output naming) rather than depending on the size or contents of
the real library on this machine.

Runnable directly: `python3 curate_vital_test.py` (repo convention — the gate's py_tests
auto-discovers service/**/*_test.py).
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import curate_vital as cv  # noqa: E402

FAILURES = []


def check(cond, label):
    if cond:
        print(f"  ok  {label}")
    else:
        print(f"  FAIL {label}")
        FAILURES.append(label)


def _touch(root: Path, rel: str, content: bytes = b"{}"):
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(content)
    return p


def _build_synthetic_library(root: Path):
    # bass — folder-only signal (no keyword in the filename itself), plus a filename hit.
    _touch(root, "User/Presets/PackA/Bass/11893_Campell - Would You.vital")
    _touch(root, "User/Presets/PackA/Bass/Dark Sub Wobble.vital")
    _touch(root, "User/Presets/PackA/Bass/808 Slide.vital")
    _touch(root, "User/Presets/PackB/BA - Trap Hitter.vital")
    _touch(root, "User/Presets/PackB/BA - Rage Growl.vital")
    _touch(root, "User/Presets/PackC/Sub Drone Low.vital")
    # a 7th bass candidate to prove the quota CAPS at 6, not "however many exist".
    _touch(root, "User/Presets/PackC/Bass Extra.vital")

    # lead — exactly enough to hit quota (10).
    for i in range(10):
        _touch(root, f"User/Presets/PackD/Lead/LD Lead {i}.vital")
    # one more lead than the quota, scored LOWER (placeholder name) so it must lose out.
    _touch(root, "User/Presets/PackD/Lead/Init.vital")

    # pluck, keys, bell, arp, fx, pad — just enough to exercise each bucket + quota cap.
    for i in range(8):
        _touch(root, f"User/Presets/PackE/Pluck/PL Pluck {i}.vital")
    for i in range(8):
        _touch(root, f"User/Presets/PackE/Keys/Rhodes {i}.vital")
    for i in range(6):
        _touch(root, f"User/Presets/PackE/Bell/Bell {i}.vital")
    for i in range(6):
        _touch(root, f"User/Presets/PackE/Arp/SEQ Arp {i}.vital")
    for i in range(8):
        _touch(root, f"User/Presets/PackE/FX/FX Riser {i}.vital")
    for i in range(8):
        _touch(root, f"User/Presets/PackE/Ambient/Pad Atmos {i}.vital")

    # disqualified: Template/Experiment folders never surface even though the filename
    # would otherwise classify (e.g. "Lead").
    _touch(root, "User/Presets/PackF/Template/LD Scratch Lead.vital")
    _touch(root, "User/Presets/PackF/Experiment/BA Test Bass.vital")

    # unclassifiable (no role keyword anywhere) — must be skipped entirely, not dumped
    # into some default bucket.
    _touch(root, "User/Presets/PackG/Mystery Sound.vital")


def test_role_classification():
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        _build_synthetic_library(root)

        bass_path = root / "User/Presets/PackA/Bass/11893_Campell - Would You.vital"
        check(cv.classify_role(bass_path, root) == "bass", "a folder-only bass hit (no keyword in the filename) classifies as bass")

        mystery = root / "User/Presets/PackG/Mystery Sound.vital"
        check(cv.classify_role(mystery, root) is None, "a preset with no role keyword anywhere classifies as None")

        ba_path = root / "User/Presets/PackB/BA - Trap Hitter.vital"
        check(cv.classify_role(ba_path, root) == "bass", "the short 'BA' token matches as a whole word")

        # "Databroth" must NOT false-positive on "BA" as a substring.
        false_pos_dir = root / "User/Presets/Databroth"
        false_pos_dir.mkdir(parents=True, exist_ok=True)
        fp = false_pos_dir / "Warm Chord.vital"
        fp.write_bytes(b"{}")
        check(cv.classify_role(fp, root) is None, "'BA' does not false-positive as a substring of 'Databroth'")


def test_disqualify_and_placeholder_scoring():
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        _build_synthetic_library(root)
        cands = dict(cv.find_candidates(root))
        template_hit = root / "User/Presets/PackF/Template/LD Scratch Lead.vital"
        experiment_hit = root / "User/Presets/PackF/Experiment/BA Test Bass.vital"
        check(template_hit not in cands, "a Template-folder preset is disqualified even though its name would classify")
        check(experiment_hit not in cands, "an Experiment-folder preset is disqualified even though its name would classify")

        init_path = root / "User/Presets/PackD/Lead/Init.vital"
        named_path = root / "User/Presets/PackD/Lead/LD Lead 0.vital"
        init_score = cv.score_candidate(init_path, root)
        named_score = cv.score_candidate(named_path, root)
        check(init_score < named_score, "a placeholder-named preset ('Init') scores below a normally-named one")


def test_quota_capping_and_output():
    with tempfile.TemporaryDirectory() as td:
        root = Path(td) / "vital-src"
        out = Path(td) / "curated-out"
        _build_synthetic_library(root)

        provenance = cv.curate(root, out, cv.QUOTAS, dry_run=False)

        check(len(provenance) == 60, f"total picks hit the full 60-preset target ({len(provenance)})")

        by_role = {}
        for row in provenance:
            by_role.setdefault(row["role"], 0)
            by_role[row["role"]] += 1
        for role, quota in cv.QUOTAS.items():
            check(by_role.get(role, 0) == quota, f"role '{role}' picks exactly its quota ({quota})")

        # The 7th bass candidate existed but the quota is 6 — capping, not "everything".
        check(by_role.get("bass", 0) == 6, "bass quota caps at 6 even though 7 bass candidates exist")

        # Files actually landed on disk, flat (no subdirectories under out/), matching
        # cmdListPresets' non-recursive per-plugin-dir scan.
        copied = sorted(p.name for p in out.iterdir() if p.suffix == ".vital")
        check(len(copied) == 60, "60 .vital files were actually copied")
        check(all("/" not in n for n in copied), "every copied file is FLAT under the output dir (no subfolders)")
        check(all(n.split("-", 1)[0] in cv.QUOTAS for n in copied), "every filename is prefixed with its role")

        prov_file = out / "provenance.json"
        check(prov_file.exists(), "provenance.json was written")
        data = json.loads(prov_file.read_text(encoding="utf-8"))
        check(data.get("count") == 60, "provenance.json's count matches the actual pick count")
        check(len(data.get("presets", [])) == 60, "provenance.json lists all 60 picks")
        row0 = data["presets"][0]
        for key in ("dest", "role", "source_path", "author", "style", "score"):
            check(key in row0, f"provenance row carries '{key}'")


def test_dry_run_copies_nothing():
    with tempfile.TemporaryDirectory() as td:
        root = Path(td) / "vital-src"
        out = Path(td) / "curated-out"
        _build_synthetic_library(root)

        provenance = cv.curate(root, out, cv.QUOTAS, dry_run=True)
        check(len(provenance) == 60, "dry-run still scores and reports the same 60 picks")
        check(not out.exists(), "dry-run creates no output directory at all")


def test_limit_and_roles_filters():
    with tempfile.TemporaryDirectory() as td:
        root = Path(td) / "vital-src"
        out = Path(td) / "curated-out"
        _build_synthetic_library(root)

        provenance = cv.curate(root, out, cv.QUOTAS, dry_run=True, limit=2)
        check(len(provenance) == 2 * len(cv.QUOTAS), "--limit caps every role's quota uniformly")

        provenance_bass_only = cv.curate(root, out, cv.QUOTAS, dry_run=True, roles={"bass"})
        check(
            len(provenance_bass_only) == cv.QUOTAS["bass"] and all(r["role"] == "bass" for r in provenance_bass_only),
            "--roles restricts curation to the requested role subset",
        )


def test_author_diversity_prefers_spreading_picks():
    with tempfile.TemporaryDirectory() as td:
        root = Path(td) / "vital-src"
        out = Path(td) / "curated-out"
        # One pack with 6 near-identically (high) scored bass presets, one pack with a
        # single, slightly lower-scored bass preset. A pure top-score sort would fill the
        # whole bass quota (6) from PackBig alone; the diversity penalty should let
        # PackSmall's one preset in ahead of at least one PackBig entry.
        for i in range(6):
            _touch(root, f"User/Presets/PackBig/Bass/Dark Trap Bass {i}.vital")
        _touch(root, "User/Presets/PackSmall/Bass/Dark Trap Sub.vital")

        provenance = cv.curate(root, out, {"bass": 6}, dry_run=True)
        authors = {row["author"] for row in provenance}
        check("PackSmall" in authors, "author-diversity scoring lets a smaller pack's preset in over a saturated pack")


def main() -> int:
    test_role_classification()
    test_disqualify_and_placeholder_scoring()
    test_quota_capping_and_output()
    test_dry_run_copies_nothing()
    test_limit_and_roles_filters()
    test_author_diversity_prefers_spreading_picks()

    print()
    if FAILURES:
        print(f"✗ curate_vital_test: {len(FAILURES)} failure(s)")
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    print("✓ curate_vital_test: all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
