#!/usr/bin/env python3
"""packaging_check.py — the blocking licence/packaging gate for a distributable Mosh.app.

FS-K4. Wires `docs/DEPENDENCY_BOM.md` §4's enforcement hooks into something a script
can fail on, instead of a table nobody re-reads:

  1. no RAVE/anira model or runtime artifacts in the bundle (SPEC §1.11);
  2. a NOTICE for every BOM §1 row that actually ships, plus the two mandatory
     "Powered by …" lines;
  3. an enumeration of the packaged payload — anything shipped must map to a §1 row.

Three modes:

  --emit-notices          print the NOTICES.txt body, generated FROM the BOM table
  --bundle <Mosh.app>     the blocking check; non-zero exit with a precise reason
  (no args)               the static payload↔BOM enumeration, no bundle required

Sited under service/scripts/ ON PURPOSE: scripts/auto-loop/gate.sh's run_py_tests
discovers exactly `service/**/*_test.py` and `service/scripts/*test*.py`. A test under
top-level scripts/ would be invisible to the loop, and the gate rulebook may not be
edited. Same precedent as service/scripts/bundle_completeness_test.py.

Read-only with respect to the app: this never calls into MoshOps, never launches the
binary, and only writes when explicitly asked to emit NOTICES.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
BOM_PATH = REPO_ROOT / "docs" / "DEPENDENCY_BOM.md"

# The two attributions that are licence CONDITIONS, not politeness: Tracktion's free
# tiers require "Powered by Tracktion Engine", and the Stability AI Community License
# requires "Powered by Stability AI". Both are quoted in the BOM §1 Obligations column.
REQUIRED_ATTRIBUTIONS = (
    "Powered by Tracktion Engine",
    "Powered by Stability AI",
)

NOTICES_RELPATH = "Contents/Resources/NOTICES.txt"


# ── the BOM ───────────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class BomRow:
    name: str
    license: str
    ship: str
    obligations: str


def parse_bom(path: Path = BOM_PATH) -> list[BomRow]:
    """Parse the §1 inventory table. Fail-closed: an unreadable or unrecognisable BOM
    is an error, never an empty list that would make every downstream check vacuous."""
    if not path.is_file():
        raise SystemExit(
            f"packaging_check: BOM not found at {path}.\n"
            "  The licence obligations are generated FROM that file — without it this\n"
            "  check would pass by having nothing to check. Refusing."
        )
    text = path.read_text(encoding="utf-8")
    if "## §1" not in text:
        raise SystemExit(f"packaging_check: no '## §1' inventory section in {path}")
    section = text.split("## §1", 1)[1].split("\n## ", 1)[0]

    rows: list[BomRow] = []
    for line in section.splitlines():
        line = line.strip()
        if not line.startswith("|") or re.fullmatch(r"\|[\s\-:|]+\|", line):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) < 5 or cells[0].lower() == "dependency":
            continue
        rows.append(BomRow(cells[0], cells[1], cells[2], cells[4]))

    if not rows:
        raise SystemExit(f"packaging_check: parsed zero rows from {path} §1 — refusing")
    return rows


def bom_row(rows: list[BomRow], name: str) -> BomRow:
    for r in rows:
        if r.name == name:
            return r
    raise SystemExit(
        f"packaging_check: this check maps a shipped component to BOM row '{name}', "
        f"but {BOM_PATH.name} §1 has no such row. Either the row was renamed (update "
        f"PAYLOAD below) or a dependency is shipping unrecorded."
    )


# ── what the bundle is allowed to contain ─────────────────────────────────────────
@dataclass(frozen=True)
class Payload:
    """One top-level thing that ships, and the reason it is allowed to.

    `bom` lists the §1 rows it carries. An EMPTY list means "no third-party payload" —
    which must be justified in `why`, because BOM §4 hook 2 says anything shipped needs
    a row, and "it's ours" is the only honest way to be exempt from that."""

    relpath: str
    bom: tuple[str, ...]
    why: str
    optional: bool = False


PAYLOAD: tuple[Payload, ...] = (
    Payload(
        "Contents/MacOS/Mosh",
        ("JUCE 8", "Tracktion Engine"),
        "the app binary; JUCE and Tracktion are STATICALLY linked into it, which is "
        "exactly why both attributions have to appear in NOTICES — there is no dylib "
        "to point at.",
    ),
    Payload(
        "Contents/Frameworks/Sparkle.framework",
        ("Sparkle 2",),
        "the auto-updater (FS-K2). The only third-party BINARY that ships. Re-signed "
        "with our Developer ID at release time; upstream ships it ad-hoc signed.",
    ),
    Payload(
        "Contents/Resources/service",
        (),
        "Mosh's own Python service tree. Verified to carry no third-party payload: no "
        "dylibs, no venvs, no model weights — the SA3/whisper/RAVE venvs live outside "
        "the bundle under ~/Library/Mosh/venvs and the weights under ~/AI. The forbidden"
        "-artifact scan below is what keeps that true.",
    ),
    Payload(
        "Contents/Resources/drumkits",
        (),
        "Mosh's own default kit. The eight one-shots are SYNTHESISED by "
        "resources/drumkits/generate_kit.py (sines + seeded noise + envelopes, stdlib "
        "only) — nothing is sampled from a third party, so the kit is rights-clean. "
        "See resources/drumkits/README.md.",
    ),
    Payload(
        "Contents/Resources/companion",
        (),
        "Mosh's own phone-companion page (built from companion/, no third-party runtime).",
    ),
    Payload(
        "Contents/Resources/ui",
        (),
        "the built React UI. KNOWN BOM GAP, deliberately recorded rather than hidden: "
        "Vite inlines the third-party JS runtime (React et al.) into index.html, so "
        "third-party code DOES ship here with no §1 row. Those deps are MIT/BSD and "
        "carry no threshold or attribution condition, which is why the BOM's authors "
        "scoped §1 to the licence-risky deps — but hook 2 says 'anything shipped must "
        "have a §1 row', and this does not. Adding an npm-inventory row is BOM work "
        "(FS-000's owner), not this check's.",
    ),
    Payload("Contents/Resources/AppIcon.icns", (), "Mosh's own icon."),
    Payload("Contents/Resources/RecentFilesMenuTemplate.nib", (), "JUCE-generated menu nib."),
    Payload(
        "Contents/Resources/brain.env",
        (),
        "the owner's provider key, sealed in by explicit standing decision "
        "(CLAUDE.md § Standing policy). Not a dependency; carries no licence obligation.",
        optional=True,
    ),
    Payload(NOTICES_RELPATH, (), "this check's own output.", optional=True),
    # Bundle metadata macOS/JUCE/codesign create. Present in every .app, no payload.
    *(
        Payload(p, (), "bundle metadata (macOS/JUCE/codesign).", optional=True)
        for p in (
            "Contents/Info.plist",
            "Contents/PkgInfo",
            "Contents/CodeResources",
            "Contents/_CodeSignature",
            "Contents/Frameworks",  # the dir itself; its children are checked above
        )
    ),
)


# ── forbidden artifacts (SPEC §1.11) ──────────────────────────────────────────────
# RAVE code + official weights are CC BY-NC 4.0. In-tree and undistributed creates no
# obligation; SHIPPING them does. So the bundle must contain neither the anira/LibTorch
# runtime nor any TorchScript weight.
#
# DO NOT match on the substring "rave". service/recipes/library/ legitimately ships
# owner beat recipes named for the music genre — owner_newage_rave_*.json and friends.
# A naive grep false-fails every distributable bundle, permanently, for nothing.
FORBIDDEN_NAME_PATTERNS = (
    re.compile(r"^libanira.*\.dylib$", re.I),
    re.compile(r"^libtorch.*\.(dylib|so|a)$", re.I),
    re.compile(r"^libc10.*\.(dylib|so|a)$", re.I),
    re.compile(r"^libomp\.dylib$", re.I),  # rides along with the LibTorch distribution
)

# TorchScript weights are ZIP archives. Detecting them by MAGIC rather than extension
# matters both ways: `.ts` is also the TypeScript extension (a source `.ts` must not
# trip the check), and a weight renamed to `.bin`/`.pt`/anything must still trip it.
_ZIP_MAGIC = b"PK\x03\x04"
_WEIGHT_SUFFIXES = {".ts", ".pt", ".pth", ".bin", ".safetensors", ".ckpt"}


def _is_macho(path: Path) -> bool:
    try:
        with path.open("rb") as fh:
            magic = fh.read(4)
    except OSError:
        return False
    return magic in (
        b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe",   # 64/32-bit little-endian
        b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca",   # universal (fat)
    )


def _links_libtorch(path: Path) -> bool:
    """A self-contained anira build links LibTorch into the binary itself, so a name
    scan alone would miss it."""
    try:
        out = subprocess.run(
            ["/usr/bin/otool", "-L", str(path)],
            capture_output=True, text=True, timeout=30,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return bool(re.search(r"lib(torch|c10|anira)", out, re.I))


def find_forbidden(bundle: Path) -> list[str]:
    hits: list[str] = []
    for path in sorted(bundle.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        rel = path.relative_to(bundle).as_posix()
        name = path.name

        if any(p.match(name) for p in FORBIDDEN_NAME_PATTERNS):
            hits.append(f"{rel} — anira/LibTorch runtime artifact")
            continue

        if path.suffix.lower() in _WEIGHT_SUFFIXES:
            try:
                head = path.open("rb").read(4)
            except OSError:
                head = b""
            if head == _ZIP_MAGIC:
                hits.append(f"{rel} — TorchScript weight (ZIP magic)")
                continue

        if _is_macho(path) and _links_libtorch(path):
            hits.append(f"{rel} — Mach-O linking LibTorch/anira")
    return hits


# ── NOTICES ───────────────────────────────────────────────────────────────────────
def shipping_rows(rows: list[BomRow]) -> list[BomRow]:
    """The §1 rows that are actually IN the bundle — derived from PAYLOAD, not from the
    Ship-status column.

    This distinction is the whole point. "Ship status: OK" means "legally clear to
    ship", not "is in the bundle": Qwen3-30B-A3B's own row says it is *not* bundled,
    ACE-Step and SoulX are parked, sentry-native is not built yet. Generating NOTICES
    from every OK row would attribute code we do not distribute — false attribution,
    which is worse than a missing notice."""
    names: list[str] = []
    for p in PAYLOAD:
        for n in p.bom:
            if n not in names:
                names.append(n)
    return [bom_row(rows, n) for n in names]


def emit_notices(rows: list[BomRow]) -> str:
    ship = shipping_rows(rows)
    out: list[str] = [
        "Mosh — third-party notices",
        "=" * 72,
        "",
        "Mosh is built on the work below. This file is GENERATED from",
        "docs/DEPENDENCY_BOM.md §1 by service/scripts/packaging_check.py — do not edit",
        "it by hand; edit the BOM and rebuild, or the two will drift.",
        "",
        "It lists what actually ships inside this application bundle. Components Mosh",
        "talks to but does not distribute (model weights, cloud APIs) are not listed.",
        "",
    ]
    for line in REQUIRED_ATTRIBUTIONS:
        out.append(line)
    out += ["", "-" * 72, ""]
    for r in ship:
        out += [r.name, f"  License:     {r.license}", f"  Obligations: {r.obligations}", ""]
    return "\n".join(out).rstrip() + "\n"


# ── the checks ────────────────────────────────────────────────────────────────────
@dataclass
class Result:
    failures: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.failures


def check_notices(bundle: Path, rows: list[BomRow]) -> Result:
    res = Result()
    path = bundle / NOTICES_RELPATH
    if not path.is_file():
        res.failures.append(
            f"missing {NOTICES_RELPATH} — every BOM §1 row that ships needs a notice. "
            "Regenerate with: packaging_check.py --emit-notices"
        )
        return res
    body = path.read_text(encoding="utf-8", errors="replace")
    for line in REQUIRED_ATTRIBUTIONS:
        if line not in body:
            res.failures.append(f"{NOTICES_RELPATH} is missing the required attribution {line!r}")
    for r in shipping_rows(rows):
        if r.name not in body:
            res.failures.append(f"{NOTICES_RELPATH} has no block for shipped dependency {r.name!r}")
    return res


def check_payload(bundle: Path, rows: list[BomRow]) -> Result:
    """BOM §4 hook 2: enumerate what ships; anything unmapped fails."""
    res = Result()
    known = {p.relpath for p in PAYLOAD}
    # Dirs we descend INTO. They must be skipped when they turn up as children of a
    # shallower level, or the walk reports 'Contents/Resources' itself as unmapped
    # payload alongside the entries it contains.
    containers = {"Contents", "Contents/Resources", "Contents/Frameworks", "Contents/MacOS"}

    seen: list[str] = []
    for parent in sorted(containers):
        d = bundle / parent
        if not d.is_dir():
            continue
        for child in sorted(d.iterdir()):
            rel = child.relative_to(bundle).as_posix()
            if rel in containers:
                continue
            # Only classify the level PAYLOAD talks about: a Resources child is a unit,
            # its contents are not separately enumerated.
            if any(rel.startswith(k + "/") for k in known):
                continue
            seen.append(rel)

    for rel in seen:
        if rel not in known:
            res.failures.append(
                f"unmapped payload {rel!r} — it ships but no PAYLOAD entry in "
                "service/scripts/packaging_check.py accounts for it. Add an entry naming "
                "its BOM §1 row, or an explicit reason it carries no third-party code. "
                "(BOM §4 hook 2: anything shipped must have a §1 row.)"
            )

    for p in PAYLOAD:
        if p.optional or p.relpath in ("Contents/Frameworks",):
            continue
        if not (bundle / p.relpath).exists():
            res.notes.append(f"expected payload absent (not fatal): {p.relpath}")

    for r in shipping_rows(rows):
        res.notes.append(f"ships: {r.name} — {r.ship}")
    return res


def check_bundle(bundle: Path, rows: list[BomRow]) -> Result:
    res = Result()
    if not bundle.is_dir():
        res.failures.append(f"not a bundle directory: {bundle}")
        return res

    forbidden = find_forbidden(bundle)
    for hit in forbidden:
        res.failures.append(
            f"RAVE/anira artifact in a distributable bundle: {hit}. SPEC §1.11 — RAVE "
            "code and official weights are CC BY-NC 4.0 and are EXCLUDED from every "
            "distributed build."
        )

    for sub in (check_notices(bundle, rows), check_payload(bundle, rows)):
        res.failures += sub.failures
        res.notes += sub.notes
    return res


# ── CLI ───────────────────────────────────────────────────────────────────────────
def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--emit-notices", action="store_true", help="print the NOTICES.txt body and exit")
    ap.add_argument("--bundle", metavar="APP", help="blocking check against a built Mosh.app")
    ap.add_argument("--warn-only", action="store_true",
                    help="report but always exit 0 — for the non-distributable deploy-anira path")
    args = ap.parse_args(argv)

    rows = parse_bom()

    if args.emit_notices:
        sys.stdout.write(emit_notices(rows))
        return 0

    if not args.bundle:
        # Static enumeration — no bundle needed. Reused by the test.
        print("packaging_check: static payload ↔ BOM §1 enumeration\n")
        for p in PAYLOAD:
            if p.optional:
                continue
            tag = ", ".join(p.bom) if p.bom else "(no third-party payload)"
            print(f"  {p.relpath}\n      → {tag}\n      {p.why}\n")
        return 0

    res = check_bundle(Path(args.bundle).expanduser().resolve(), rows)
    for n in res.notes:
        print(f"packaging_check:   {n}")
    sys.stdout.flush()   # keep the notes above the stderr failures, not interleaved
    if res.ok:
        print(f"packaging_check: OK — {args.bundle} is distributable "
              f"(no RAVE/anira artifacts, NOTICES complete, payload fully mapped)")
        return 0

    for f in res.failures:
        print(f"packaging_check: FAIL — {f}", file=sys.stderr)
    if args.warn_only:
        print("packaging_check: --warn-only, exiting 0 (NON-DISTRIBUTABLE bundle)", file=sys.stderr)
        return 0
    print("packaging_check: refusing to treat this bundle as distributable.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
