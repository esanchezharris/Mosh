#!/usr/bin/env python3
"""FS-K4 — packaging / BOM compliance check for a distributable Mosh.app.

SPEC §5 K1 asks for a scripted, BLOCKING packaging check on the deploy path:

  * no RAVE/anira artifacts or weights in the bundle (SPEC §1.11);
  * every `docs/DEPENDENCY_BOM.md` §1 row that ships has a NOTICE;
  * "Powered by Stability AI" + "Powered by Tracktion Engine" present;
  * the packaged `service/` payload enumerated — anything shipped needs a BOM row.

The BOM is the single source of truth: NOTICES.txt is GENERATED from its §1 table
(`--emit-notices`) and then VERIFIED against that same table (`--bundle`), so the shipped
acknowledgements cannot drift from the inventory.

Modes:
  --emit-notices          write the NOTICES body to stdout (run-mosh.sh stages it)
  --bundle <Mosh.app>     the blocking check; non-zero exit + precise reasons on failure
  (no args)               static payload-vs-BOM enumeration of the repo's service/ tree

Fail-closed everywhere: an unreadable/absent BOM, or a §1 table that does not parse, is an
ERROR, never a silent pass. Read-only with respect to the app (it never mutates a bundle);
`--emit-notices` only writes to stdout.
"""
import argparse
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_BOM = os.path.join(REPO, "docs", "DEPENDENCY_BOM.md")

# Required by the licences Mosh actually ships under: the Tracktion free tier mandates the
# engine credit, and the Stability AI Community License mandates the SA3 credit. Both are
# asserted present in the shipped NOTICES (BOM §1 "Obligations" column).
REQUIRED_ATTRIBUTIONS = ("Powered by Stability AI", "Powered by Tracktion Engine")

# ── forbidden artifacts (SPEC §1.11: RAVE/anira never ship) ─────────────────────────
#
# CRITICAL: do NOT match the bare substring "rave". `service/recipes/library/` contains
# real owner beat recipes named owner_*ravelover*/owner_*rave_party*.json (the music genre)
# which DO ship, and Mosh's own service/transform/transform_cli.py ships too. Only the
# neural RUNTIME and MODEL artifacts are forbidden — never Mosh's own source, never names.
FORBIDDEN_LIB_PATTERNS = (
    re.compile(r"^libanira[.\d]*\.(dylib|so|a)$", re.I),
    re.compile(r"^libtorch.*\.(dylib|so)$", re.I),
    re.compile(r"^libc10.*\.(dylib|so)$", re.I),
    re.compile(r"^libomp\.dylib$", re.I),          # ships only alongside LibTorch here
)

# Model-weight containers. A shipped one needs a BOM row; a TorchScript one is additionally
# a §1.11 violation (that is how RAVE weights would arrive).
WEIGHT_EXTS = (".safetensors", ".bin", ".pt", ".pth", ".ckpt", ".onnx", ".gguf", ".npz", ".ts")

# First-party artifacts that legitimately ride along in the whole-dir copies and are NOT
# third-party payload, so they need no BOM row. Kept as an explicit, reviewed list — the
# alternative (widening WEIGHT_EXTS' exclusions) would silently blind the enumeration.
FIRST_PARTY_PAYLOAD = (
    "service/scripts/golden/",   # Mosh-authored test goldens (lora_dora_fixture.npz)
    "service/sketch/fixtures/",  # Mosh-authored beatbox fixtures
)


class BomRow:
    """One row of the BOM §1 inventory table."""

    def __init__(self, name, license_, ship_status, threshold, obligations):
        self.name = name
        self.license = license_
        self.ship_status = ship_status
        self.threshold = threshold
        self.obligations = obligations

    def ships(self):
        """True unless the row is explicitly EXCLUDED from distributed builds.

        Deliberately inclusive: any row not marked EXCLUDED gets an acknowledgement. Over-
        attributing is harmless; under-attributing is a licence breach, and the ship-status
        prose varies ("OK", "OK — Personal tier", "OK, with obligations met", ...), so
        keying on the one unambiguous negative is the robust rule.
        """
        return "EXCLUDED" not in self.ship_status.upper()

    def __repr__(self):
        return f"BomRow({self.name!r})"


def _split_row(line):
    # A markdown table row: | a | b | c |  → [a, b, c] (drops the empty edge cells).
    cells = [c.strip() for c in line.strip().strip("|").split("|")]
    return cells


def parse_bom_rows(text):
    """Parse the §1 inventory table. Returns [] when the table is absent (fail-closed:
    callers treat an empty row set as an error, never as 'nothing to check')."""
    rows = []
    in_section = False
    seen_header = False
    for line in text.splitlines():
        if line.startswith("## "):
            if in_section:
                break                      # §1 ended
            in_section = "§1" in line or line.lower().startswith("## 1.")
            continue
        if not in_section:
            continue
        if not line.lstrip().startswith("|"):
            continue
        cells = _split_row(line)
        if len(cells) < 5:
            continue
        if not seen_header:                # the header row, then the |---|---| separator
            seen_header = True
            continue
        if set("".join(cells)) <= set("-: "):
            continue
        rows.append(BomRow(*cells[:5]))
    return rows


def load_bom(path=DEFAULT_BOM):
    """Read + parse the BOM. Returns None if missing/unparseable — the caller must treat
    that as a hard failure (FS-000 landing the BOM is a prerequisite of this check)."""
    if not os.path.isfile(path):
        return None
    rows = parse_bom_rows(open(path, encoding="utf-8").read())
    return rows or None


def emit_notices(rows):
    """Generate the NOTICES body from the BOM §1 table."""
    out = [
        "Mosh — third-party acknowledgements",
        "",
        "This file is GENERATED from docs/DEPENDENCY_BOM.md §1 by",
        "service/scripts/packaging_check.py --emit-notices. Do not edit by hand:",
        "the packaging check regenerates and verifies it on every deploy/release.",
        "",
    ]
    for s in REQUIRED_ATTRIBUTIONS:
        out.append(s)
    out += ["", "-" * 72, ""]
    for r in rows:
        if not r.ships():
            continue
        out.append(r.name)
        out.append(f"  License: {r.license}")
        if r.obligations and r.obligations.lower() not in ("none", "n/a", ""):
            out.append(f"  Notice:  {r.obligations}")
        out.append("")
    return "\n".join(out) + "\n"


def _is_torchscript(path):
    """TorchScript archives are ZIPs. That magic is what distinguishes a RAVE `.ts` model
    from a TypeScript source file, which shares the extension — matching on the extension
    alone would false-fail any bundle carrying UI sources."""
    try:
        with open(path, "rb") as f:
            return f.read(4) == b"PK\x03\x04"
    except OSError:
        return False


def _rel(bundle, path):
    return os.path.relpath(path, bundle)


def _walk(bundle):
    for root, dirs, files in os.walk(bundle):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for fn in files:
            yield os.path.join(root, fn)


def find_forbidden_artifacts(bundle):
    """RAVE/anira runtime + model artifacts (SPEC §1.11). Names/sources are never matched."""
    problems = []
    for path in _walk(bundle):
        base = os.path.basename(path)
        rel = _rel(bundle, path)
        for pat in FORBIDDEN_LIB_PATTERNS:
            if pat.match(base):
                problems.append(f"forbidden neural runtime artifact in bundle: {rel} "
                                f"(SPEC §1.11 — RAVE/anira must not ship)")
                break
        if base.endswith(".ts") and _is_torchscript(path):
            problems.append(f"forbidden TorchScript model weight in bundle: {rel} "
                            f"(SPEC §1.11 — RAVE weights must not ship)")
    return problems


def find_unattributed_payload(bundle):
    """Third-party payload shipped in the bundle that no BOM row covers.

    'Payload' means vendored binaries, model weights and venvs — NOT Mosh's own .py/.sh
    source, which is what most of Contents/Resources/service is."""
    problems = []
    for path in _walk(bundle):
        rel = _rel(bundle, path)
        norm = rel.replace(os.sep, "/")
        after = norm.split("Contents/Resources/", 1)[-1]
        if any(fp in after for fp in FIRST_PARTY_PAYLOAD):
            continue
        if "site-packages/" in norm or "/.venv/" in norm:
            problems.append(f"vendored venv/site-packages shipped: {rel} "
                            f"(third-party payload needs a BOM §1 row, and venvs are never bundled)")
            continue
        ext = os.path.splitext(rel)[1].lower()
        if ext in WEIGHT_EXTS:
            if ext == ".ts" and not _is_torchscript(path):
                continue                    # TypeScript source, not a weight
            problems.append(f"third-party model payload shipped with no BOM §1 row: {rel}")
    # Dedupe while keeping order (a TorchScript weight trips both rules by design).
    return list(dict.fromkeys(problems))


def check_notices(bundle, rows):
    """NOTICES.txt exists, carries both mandatory attributions, and covers every shipping row."""
    notices_path = os.path.join(bundle, "Contents", "Resources", "NOTICES.txt")
    if not os.path.isfile(notices_path):
        return [f"NOTICES.txt missing from bundle (expected {_rel(bundle, notices_path)})"]
    body = open(notices_path, encoding="utf-8").read()
    problems = []
    for s in REQUIRED_ATTRIBUTIONS:
        if s not in body:
            problems.append(f"NOTICES.txt is missing the required attribution {s!r}")
    for r in rows:
        if r.ships() and r.name not in body:
            problems.append(f"NOTICES.txt has no acknowledgement for shipping BOM row: {r.name}")
        if not r.ships() and r.name in body:
            problems.append(f"NOTICES.txt attributes {r.name!r}, which is EXCLUDED from "
                            f"distributed builds — it must not ship at all")
    return problems


def check_bundle(bundle, rows):
    """Every rule, as a flat list of human-readable problems. Empty ⇒ compliant."""
    return (find_forbidden_artifacts(bundle)
            + check_notices(bundle, rows)
            + find_unattributed_payload(bundle))


def main(argv=None):
    ap = argparse.ArgumentParser(description="Mosh packaging / BOM compliance check")
    ap.add_argument("--bundle", help="path to a built Mosh.app — runs the blocking check")
    ap.add_argument("--emit-notices", action="store_true", help="print the NOTICES body to stdout")
    ap.add_argument("--bom", default=DEFAULT_BOM, help="path to DEPENDENCY_BOM.md")
    ap.add_argument("--warn-only", action="store_true",
                    help="report problems but exit 0 (the non-distributable deploy-anira path)")
    args = ap.parse_args(argv)

    rows = load_bom(args.bom)
    if rows is None:
        print(f"packaging-check: FAIL — no parseable BOM §1 inventory at {args.bom}.\n"
              f"  docs/DEPENDENCY_BOM.md must be committed (FS-000) before packaging.",
              file=sys.stderr)
        return 2

    if args.emit_notices:
        sys.stdout.write(emit_notices(rows))
        return 0

    if not args.bundle:
        # Static mode: enumerate the repo's service payload without needing a bundle.
        problems = find_unattributed_payload(os.path.join(REPO, "service"))
        for p in problems:
            print(f"packaging-check: {p}")
        print(f"packaging-check: {len(problems)} problem(s) in the static service/ enumeration")
        return 1 if problems and not args.warn_only else 0

    if not os.path.isdir(args.bundle):
        print(f"packaging-check: FAIL — no bundle at {args.bundle}", file=sys.stderr)
        return 2

    problems = check_bundle(args.bundle, rows)
    if not problems:
        print(f"packaging-check: OK — {os.path.basename(args.bundle)} is compliant "
              f"({len([r for r in rows if r.ships()])} shipping BOM rows acknowledged, "
              f"no RAVE/anira artifacts, no unattributed payload).")
        return 0

    label = "WARN" if args.warn_only else "FAIL"
    print(f"packaging-check: {label} — {len(problems)} problem(s) in {args.bundle}:", file=sys.stderr)
    for p in problems:
        print(f"  - {p}", file=sys.stderr)
    if args.warn_only:
        print("packaging-check: warn-only (non-distributable build) — NOT blocking.", file=sys.stderr)
        return 0
    print("packaging-check: refusing to ship this bundle.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
