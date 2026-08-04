#!/usr/bin/env python3
"""FS-K4 — packaging / BOM compliance check for a distributable Mosh.app.

SPEC §5 K1 asks for a scripted, BLOCKING packaging check on the deploy path:

  * no RAVE/anira artifacts or weights in the bundle (SPEC §1.11);
  * every `docs/DEPENDENCY_BOM.md` §1 row that ships carries its REAL notice;
  * "Powered by Stability AI" + "Powered by Tracktion Engine" present;
  * the packaged `service/` payload enumerated — anything shipped needs a BOM row.

The BOM is the single source of truth for the INVENTORY: which dependencies exist, under
what licence, and whether they ship. The notice TEXT is not written here and not written in
the BOM — it is the dependency's own LICENSE/NOTICE file, vendored verbatim under
`docs/licenses/` and named by the §1 "Notice" column. `--emit-notices` concatenates those
files; `--bundle` asserts the shipped bytes still match them.

What the BOM's "Obligations" column is NOT: a notice. It holds internal engineering notes
about what Mosh owes — counsel-check items, open TODOs, a stale-figure correction in bold
markdown. Generating NOTICES.txt from it published all of that to every user while
retaining zero copyright lines and zero licence text, and the check passed because it only
tested that each dependency's NAME appeared somewhere. Both halves of that are fixed here;
see docs/licenses/README.md.

Modes:
  --emit-notices          write the NOTICES body to stdout (run-mosh.sh stages it)
  --bundle <Mosh.app>     the blocking check; non-zero exit + precise reasons on failure
  (no args)               static payload-vs-BOM enumeration of the repo's service/ tree

Fail-closed everywhere: an unreadable/absent BOM, or a §1 table that does not parse, is an
ERROR, never a silent pass. Read-only with respect to the app (it never mutates a bundle);
`--emit-notices` only writes to stdout.
"""
import argparse
import codecs
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_BOM = os.path.join(REPO, "docs", "DEPENDENCY_BOM.md")

# Required by the licences Mosh actually ships under: the Tracktion free tier mandates the
# engine credit, and the Stability AI Community License mandates the SA3 credit. Both are
# emitted into, and then asserted present in, the shipped NOTICES.txt.
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

    def __init__(self, name, license_, ship_status, threshold, obligations, notice=""):
        self.name = name
        self.license = license_
        self.ship_status = ship_status
        self.threshold = threshold
        # INTERNAL engineering notes about what Mosh owes — working notes, open TODOs and
        # counsel-check items. NEVER emitted into the shipped NOTICES.txt: see `notice`.
        self.obligations = obligations
        # The §1 "Notice" cell: `licenses/<file>.txt` (one or more, comma-separated),
        # `not-bundled`, `hosted-service`, or an em-dash for EXCLUDED rows.
        self.notice = notice

    def notice_files(self):
        """The vendored licence files this row ships, as repo-relative paths under docs/.

        Parsed out of the Notice cell's backticked `licenses/…` tokens, so the cell can
        carry more than one file (sentry-native vendors crashpad alongside its own MIT
        text) and can also carry prose without confusing the parser."""
        return re.findall(r"licenses/[A-Za-z0-9._-]+\.txt", self.notice or "")

    def notice_kind(self):
        """'vendored' | 'not-bundled' | 'hosted-service' | 'unset'."""
        if self.notice_files():
            return "vendored"
        cell = (self.notice or "").strip().lower()
        if "not-bundled" in cell:
            return "not-bundled"
        if "hosted-service" in cell:
            return "hosted-service"
        return "unset"

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
        # cells[:6] — the 6th ("Notice") is optional so an older BOM still parses, but a
        # shipping row that lacks it is then reported as 'unset' by check_notices() and
        # fails closed, rather than shipping unattributed. Extra columns are ignored.
        rows.append(BomRow(*cells[:6]))
    return rows


def load_bom(path=DEFAULT_BOM):
    """Read + parse the BOM. Returns None if missing/unparseable — the caller must treat
    that as a hard failure (FS-000 landing the BOM is a prerequisite of this check)."""
    if not os.path.isfile(path):
        return None
    rows = parse_bom_rows(open(path, encoding="utf-8").read())
    return rows or None


def plain(s):
    """BOM cell → plain text. NOTICES.txt is read in a text editor, not rendered, so
    markdown emphasis has to come off or it ships as literal `**` (it did)."""
    s = re.sub(r"\*\*(.+?)\*\*", r"\1", s or "")
    s = re.sub(r"`([^`]+)`", r"\1", s)
    return s.strip()


def licence_line(s):
    """The licence identifier + its source citation — the FIRST sentence of the BOM's
    License cell, markdown stripped.

    Trailing sentences there are internal commentary of the same family as the Obligations
    column ("that sweep belongs to K1's acknowledgements surface and is only owed if a
    Sentry-ON build ever ships"), and a user's acknowledgements file is not where a reader
    should meet Mosh's internal lane planning. The first sentence is the part that says
    what licence applies, which is the part that belongs to them.
    """
    s = plain(s)
    m = re.search(r"\.\s+(?=[A-Z(])", s)
    return s[:m.start()] if m else s


NOT_BUNDLED_TEXT = (
    "Not distributed with Mosh. This dependency is used by in-repo tooling, or is "
    "supplied by the user and loaded from outside the application bundle, so no "
    "notice-retention obligation attaches to what you received."
)
HOSTED_SERVICE_TEXT = (
    "Reached over the network as a hosted service. No third-party code from this "
    "provider is distributed with Mosh, so no notice-retention obligation attaches "
    "to what you received."
)


def read_notice_file(rel, repo=REPO):
    """Read one vendored licence text. Returns None when it is missing — the caller
    turns that into a hard error rather than emitting a gap."""
    path = os.path.join(repo, "docs", rel)
    try:
        return open(path, encoding="utf-8").read().rstrip("\n")
    except OSError:
        return None


def emit_notices(rows, repo=REPO):
    """Generate the NOTICES body: the VERBATIM upstream licence text for everything Mosh
    distributes, and an accurate statement for everything it does not.

    The BOM's "Obligations" column is deliberately NOT a source here. It holds internal
    engineering notes about what Mosh owes ("counsel-check (§5)", "keep a voice-consent
    line in the tester agreement", a stale-figure correction in bold markdown) — reader-
    facing only by accident. Emitting it published working notes and unfinished TODOs to
    every user while retaining ZERO copyright lines and ZERO licence text, which is the
    exact obligation this file exists to discharge. What ships is the upstream text.

    Raises ValueError if a shipping row's vendored file is missing, so a broken release
    fails at generation instead of shipping a gap.
    """
    out = [
        "Mosh — third-party acknowledgements",
        "",
        "This file is GENERATED from docs/DEPENDENCY_BOM.md §1 by",
        "service/scripts/packaging_check.py --emit-notices. Do not edit by hand:",
        "the packaging check regenerates and verifies it on every deploy/release.",
        "",
        "Each entry below reproduces the dependency's own LICENSE/NOTICE file verbatim,",
        "copied from the source tree Mosh builds against (see docs/licenses/README.md).",
        "",
    ]
    out += list(REQUIRED_ATTRIBUTIONS)
    missing = []
    for r in rows:
        if not r.ships():
            continue
        out += ["", "=" * 72, "", plain(r.name), f"  License: {licence_line(r.license)}", ""]
        kind = r.notice_kind()
        if kind == "vendored":
            for rel in r.notice_files():
                body = read_notice_file(rel, repo)
                if body is None:
                    missing.append(f"{r.name}: docs/{rel}")
                    continue
                out += [f"  --- {rel} ---", "", body, ""]
        elif kind == "not-bundled":
            out += [NOT_BUNDLED_TEXT, ""]
        elif kind == "hosted-service":
            out += [HOSTED_SERVICE_TEXT, ""]
        else:
            missing.append(f"{r.name}: BOM §1 'Notice' cell is empty or unrecognised")
    if missing:
        raise ValueError(
            "cannot generate NOTICES.txt — every shipping BOM §1 row needs a Notice: "
            + "; ".join(missing))
    return "\n".join(out) + "\n"


def _is_torchscript(path):
    """True for a `.ts` that is a serialised model rather than TypeScript source.

    `torch.jit.save` has written ZIP archives since torch 1.6, so ZIP magic is the primary
    tell and it cleanly separates a RAVE model from a TypeScript file sharing the extension
    (matching the extension alone would false-fail every bundle carrying UI sources).

    But ZIP magic ALONE was a hole in a rule whose whole purpose is "RAVE weights must never
    ship": a legacy pre-1.6 export, or any other non-ZIP serialisation, sailed through both
    this rule and the payload enumeration, which explicitly `continue`s on a non-TorchScript
    `.ts`. So anything that is not decodable as UTF-8 text is treated as a model too —
    TypeScript source is text by definition, and a binary blob named `.ts` is not something
    a bundle should carry unexamined either way.
    """
    try:
        with open(path, "rb") as f:
            head = f.read(4096)
    except OSError:
        return False
    if head[:4] == b"PK\x03\x04":
        return True
    # Incremental, NOT head.decode(): a fixed-size read lands mid-character on any UTF-8
    # file with a multibyte glyph near the boundary, and a plain decode would call that
    # binary — false-flagging a perfectly ordinary TypeScript source with a — or an emoji
    # in it. final=False tolerates exactly that truncated tail and nothing else.
    try:
        codecs.getincrementaldecoder("utf-8")().decode(head, False)
    except UnicodeDecodeError:
        return True                        # binary payload wearing a source-file extension
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


def find_unattributed_payload(bundle, path_prefix=""):
    """Third-party payload shipped in the bundle that no BOM row covers.

    'Payload' means vendored binaries, model weights and venvs — NOT Mosh's own .py/.sh
    source, which is what most of Contents/Resources/service is.

    `path_prefix` names where the walk root sits relative to the repo, and exists because
    FIRST_PARTY_PAYLOAD is written in repo-relative terms ("service/scripts/golden/").
    In --bundle mode the split on "Contents/Resources/" already recovers that form. In the
    documented no-argument STATIC mode the root is <repo>/service, so there is no such
    segment to split on, `after` stayed as "scripts/golden/…", the "service/scripts/golden/"
    prefix never matched, and the mode reported a permanent false failure naming the exact
    file the allowlist was added for. Passing the prefix back in is what makes the two modes
    agree about what a path means.
    """
    problems = []
    for path in _walk(bundle):
        rel = _rel(bundle, path)
        norm = rel.replace(os.sep, "/")
        if "Contents/Resources/" in norm:
            after = norm.split("Contents/Resources/", 1)[1]
        else:
            after = (path_prefix + norm) if path_prefix else norm
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


def check_notices(bundle, rows, repo=REPO):
    """NOTICES.txt exists, carries both mandatory attributions, and — for every shipping
    row — carries the ACTUAL notice, not merely a mention of the dependency's name.

    The name-only test this replaced is why the original could report
    `OK — 12 shipping BOM rows acknowledged` for a file with zero copyright lines and zero
    licence text in it: a row whose only "acknowledgement" was the string `Notice retention`
    still contained its own name, so it passed. A licence text is the thing that has to
    ship, so a licence text is the thing that gets verified — byte for byte against the
    vendored copy.
    """
    # macOS ships an .app (Contents/Resources/); the Windows packager ships a flat dist
    # directory. Accept either, so the same blocking check can gate both platforms —
    # run-mosh.ps1 does not call it yet, and that gap is the reason to look here first.
    candidates = [os.path.join(bundle, "Contents", "Resources", "NOTICES.txt"),
                  os.path.join(bundle, "NOTICES.txt")]
    notices_path = next((p for p in candidates if os.path.isfile(p)), None)
    if notices_path is None:
        return [f"NOTICES.txt missing from bundle (expected "
                f"{_rel(bundle, candidates[0])} or {_rel(bundle, candidates[1])})"]
    body = open(notices_path, encoding="utf-8").read()
    problems = []
    for s in REQUIRED_ATTRIBUTIONS:
        if s not in body:
            problems.append(f"NOTICES.txt is missing the required attribution {s!r}")
    for r in rows:
        if not r.ships():
            if plain(r.name) in body:
                problems.append(f"NOTICES.txt attributes {r.name!r}, which is EXCLUDED from "
                                f"distributed builds — it must not ship at all")
            continue
        if plain(r.name) not in body:
            problems.append(f"NOTICES.txt has no acknowledgement for shipping BOM row: {r.name}")
            continue
        kind = r.notice_kind()
        if kind == "vendored":
            for rel in r.notice_files():
                vendored = read_notice_file(rel, repo)
                if vendored is None:
                    problems.append(f"BOM §1 row {r.name!r} names docs/{rel}, which does not "
                                    f"exist — vendor the upstream LICENSE/NOTICE there")
                elif vendored not in body:
                    problems.append(f"NOTICES.txt does not carry the verbatim text of "
                                    f"docs/{rel} for {r.name!r} — regenerate it with "
                                    f"--emit-notices (a paraphrase or a summary is not a notice)")
        elif kind == "unset":
            problems.append(f"BOM §1 row {r.name!r} has no 'Notice' cell — it must name a "
                            f"licenses/<file>.txt, or 'not-bundled', or 'hosted-service'")
    problems += check_no_internal_prose_leaked(body, rows)
    return problems


# Substrings that only ever appear in the BOM's INTERNAL Obligations/threshold prose. Their
# presence in a shipped NOTICES.txt means the generator has regressed to emitting that
# column — the original defect. Chosen to be unmistakable rather than exhaustive: markdown
# emphasis and a counsel-check pointer cannot occur in an upstream licence text.
INTERNAL_PROSE_MARKERS = (
    "counsel-check",
    "tester agreement",
    "revenue-or-funding",
    "re-check the license field",
)


def check_no_internal_prose_leaked(body, rows):
    """Guard the exact regression: internal BOM prose published to every user.

    Two independent tests, because either alone is weak. (1) Known internal phrases that
    cannot occur in an upstream licence. (2) A whole Obligations cell reproduced verbatim —
    which catches new internal prose this list has never seen, the case a fixed keyword
    list can never cover on its own.
    """
    problems = []
    for marker in INTERNAL_PROSE_MARKERS:
        if marker in body:
            problems.append(f"NOTICES.txt contains internal BOM prose {marker!r} — the "
                            f"Obligations column is engineering notes, never a notice")
    for r in rows:
        ob = (r.obligations or "").strip()
        # Short cells ("None", "§3", "Nothing unusual") are too generic to test on.
        if len(ob) > 60 and ob in body:
            problems.append(f"NOTICES.txt reproduces the BOM Obligations cell for {r.name!r} "
                            f"verbatim — that column is internal engineering notes")
    return problems


def check_bundle(bundle, rows, repo=REPO):
    """Every rule, as a flat list of human-readable problems. Empty ⇒ compliant."""
    return (find_forbidden_artifacts(bundle)
            + check_notices(bundle, rows, repo)
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
        try:
            sys.stdout.write(emit_notices(rows))
        except ValueError as e:
            print(f"packaging-check: FAIL — {e}", file=sys.stderr)
            return 2
        return 0

    if not args.bundle:
        # Static mode: enumerate the repo's service payload without needing a bundle. The
        # prefix restores repo-relative paths, which is what FIRST_PARTY_PAYLOAD speaks.
        problems = find_unattributed_payload(os.path.join(REPO, "service"), "service/")
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
