#!/usr/bin/env python3
"""FS-K4 — hermetic self-test for the packaging/BOM compliance check.

Why this shape: `scripts/auto-loop/gate.sh` (forbidden to edit) discovers exactly
`service/**/*_test.py` + `service/scripts/*test*.py`, and only when the diff touches
`^(relay|service)/`. Siting the check and this test under `service/scripts/` — beside the
existing `bundle_completeness_test.py`, which uses the same static-parse-of-run-mosh.sh
technique — makes both auto-discovered with ZERO rulebook edit.

The load-bearing property of a compliance gate is that it FAILS on a non-compliant bundle.
A check that only ever passes is indistinguishable from no check at all, so every rule here
is proved twice: a clean fixture bundle PASSES, and one poisoned variant per rule FAILS with
that specific reason. Builds fixture bundles in a tmp dir; no network, no real Mosh.app, no
build. Deterministic.
"""
import os
import shutil
import sys
import tempfile
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import packaging_check as pc  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def _raise_of(fn):
    """The exception fn() raises, or None. Lets a 'must fail closed' case be asserted
    positively instead of with a bare try/except that could swallow the wrong error."""
    try:
        fn()
    except Exception as e:      # noqa: BLE001 — the type is what we assert on
        return e
    return None


# ── fixtures ────────────────────────────────────────────────────────────────────────

# A miniature BOM with the same table shape as docs/DEPENDENCY_BOM.md §1, so parsing is
# exercised without coupling this test to the real document's exact row set.
FIXTURE_BOM = """# BOM

## §1. Verified inventory

| Dependency | License (source read) | Ship status | Threshold trigger | Obligations | Notice |
|---|---|---|---|---|---|
| Tracktion Engine | Dual GPLv3 / commercial EULA | OK — Personal tier (<=$50K) | >=$50K -> Indie | Free tiers require "Powered by Tracktion Engine" display, and remember the counsel-check before any raise closes | `licenses/fixture-tracktion.txt` |
| RAVE (code + official weights) | CC BY-NC 4.0 | **EXCLUDED from all distributed builds** (spec §1.11) | n/a | None while undistributed | — |
| Stable Audio 3 (small / medium / sfx) | Stability AI Community License | OK, with obligations met | Revenue-only > $1M | display "Powered by Stability AI" | not-bundled |
| Opus (libopus) | 3-clause BSD | OK | none | Notice retention | hosted-service |

## §2. Funding-trigger math

nothing here
"""

# The Obligations cell above is deliberately >60 chars and carries the word "counsel-check",
# so it can actually TRIP both halves of check_no_internal_prose_leaked. A fixture that
# carried only short, innocuous obligations would let that guard pass while doing nothing —
# the "a guard that suppresses something needs a fixture that carries it" trap.
FIXTURE_TRACKTION_LICENCE = (
    "Copyright (c) 2000-2026 Fixture Software Corporation.\n"
    "\n"
    "Permission is hereby granted, free of charge, to any person obtaining a copy\n"
    "of this fixture licence text, for the sole purpose of proving that the shipped\n"
    "NOTICES.txt carries a verbatim upstream licence body and not a paraphrase.\n"
)


def make_repo(tmp, licences=(("fixture-tracktion.txt", FIXTURE_TRACKTION_LICENCE),)):
    """A stand-in repo root carrying docs/licenses/. Hermetic: emit_notices/check_notices
    both take `repo`, so nothing here reads the real tree."""
    root = os.path.join(tmp, "repo")
    lic = os.path.join(root, "docs", "licenses")
    os.makedirs(lic, exist_ok=True)
    for name, body in licences:
        with open(os.path.join(lic, name), "w") as f:
            f.write(body)
    return root


def make_bundle(tmp, notices=None, extra_files=(), repo=None):
    """A minimally realistic Mosh.app: Contents/{MacOS,Resources/service}."""
    app = os.path.join(tmp, "Mosh.app")
    res = os.path.join(app, "Contents", "Resources")
    os.makedirs(os.path.join(app, "Contents", "MacOS"), exist_ok=True)
    os.makedirs(os.path.join(res, "service", "transform"), exist_ok=True)
    os.makedirs(os.path.join(res, "service", "recipes", "library"), exist_ok=True)

    with open(os.path.join(app, "Contents", "MacOS", "Mosh"), "wb") as f:
        f.write(b"\xcf\xfa\xed\xfe fake mach-o")
    # Mosh's own RAVE-transform CLI legitimately ships (weights never do).
    with open(os.path.join(res, "service", "transform", "transform_cli.py"), "w") as f:
        f.write("# mosh's own cli\n")
    # The naive-grep trap: real owner beat recipes with 'rave' in the NAME that do ship.
    for n in ("owner_core_cust_ravelover_beno_lead_b700d596.json",
              "owner_mill9ion_rave_party_sound_beno_lead_ceaa5f49.json"):
        with open(os.path.join(res, "service", "recipes", "library", n), "w") as f:
            f.write("{}\n")

    if notices is None:
        notices = pc.emit_notices(pc.parse_bom_rows(FIXTURE_BOM), repo or FIXTURE_REPO)
    if notices is not False:
        with open(os.path.join(res, "NOTICES.txt"), "w") as f:
            f.write(notices)

    for rel, payload in extra_files:
        dest = os.path.join(app, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as f:
            f.write(payload)
    return app


def torchscript_bytes():
    """A real TorchScript archive is a ZIP — that magic is what tells it apart from a
    TypeScript source file sharing the '.ts' extension."""
    buf = os.path.join(tempfile.mkdtemp(), "m.ts")
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("model/constants.pkl", "x")
    with open(buf, "rb") as f:
        return f.read()


def problems_for(app, bom=FIXTURE_BOM, repo=None):
    return pc.check_bundle(app, pc.parse_bom_rows(bom), repo or FIXTURE_REPO)


# One tmp root for the whole run; FIXTURE_REPO stands in for the repo so nothing below
# reads docs/licenses/ out of the real tree.
tmp = tempfile.mkdtemp()
FIXTURE_REPO = make_repo(tmp)


# ── BOM parsing ─────────────────────────────────────────────────────────────────────

rows = pc.parse_bom_rows(FIXTURE_BOM)
check("parses every §1 row and stops at §2", len(rows) == 4, f"{[r.name for r in rows]}")
check("reads the ship status verbatim",
      any(r.name == "Opus (libopus)" and r.ship_status == "OK" for r in rows))
check("classifies an EXCLUDED row as not-shipping",
      [r.name for r in rows if not r.ships()] == ["RAVE (code + official weights)"],
      f"{[r.name for r in rows if not r.ships()]}")
check("a BOM with no §1 table fails closed (never silently passes)",
      pc.parse_bom_rows("# nothing here") == [])

# ── NOTICES emission ────────────────────────────────────────────────────────────────

notices = pc.emit_notices(rows, FIXTURE_REPO)
check("emits a block for every shipping row",
      all(r.name in notices for r in rows if r.ships()))
check("never attributes the EXCLUDED row (it must not ship at all)",
      "RAVE (code + official weights)" not in notices)
for s in pc.REQUIRED_ATTRIBUTIONS:
    check(f"emits the mandatory attribution {s!r}", s in notices)

# The real BOM must also be emittable — this is what actually ships.
real_rows = pc.parse_bom_rows(open(os.path.join(REPO, "docs", "DEPENDENCY_BOM.md")).read())
check("the REAL docs/DEPENDENCY_BOM.md §1 parses", len(real_rows) >= 10, f"{len(real_rows)} rows")
real_notices = pc.emit_notices(real_rows)   # real repo on purpose: this is what ships
check("real BOM emits both mandatory attributions",
      all(s in real_notices for s in pc.REQUIRED_ATTRIBUTIONS))
check("real BOM marks RAVE excluded",
      any("RAVE" in r.name and not r.ships() for r in real_rows))

# ── the clean bundle PASSES ─────────────────────────────────────────────────────────

clean = make_bundle(os.path.join(tmp, "clean"))
check("a compliant bundle passes", problems_for(clean) == [], f"{problems_for(clean)}")

# THE false-positive guard: the clean fixture deliberately contains 'rave'-named recipes
# and Mosh's own transform CLI. If this ever fails, the check is substring-matching.
check("legit 'rave'-named beat recipes + the transform CLI do NOT trip the check",
      problems_for(clean) == [])

# ── each rule FAILS on its own poison (RED-proof per rule) ──────────────────────────

anira = make_bundle(os.path.join(tmp, "anira"),
                    extra_files=[("Contents/Frameworks/libanira.2.dylib", b"\xcf\xfa\xed\xfe")])
p = problems_for(anira)
check("a planted libanira dylib FAILS", any("libanira" in x for x in p), f"{p}")

torch = make_bundle(os.path.join(tmp, "torch"),
                    extra_files=[("Contents/Frameworks/libtorch_cpu.dylib", b"\xcf\xfa\xed\xfe")])
p = problems_for(torch)
check("a planted LibTorch dylib FAILS", any("libtorch" in x.lower() for x in p), f"{p}")

weights = make_bundle(os.path.join(tmp, "weights"),
                      extra_files=[("Contents/Resources/service/transform/vintage.ts", torchscript_bytes())])
p = problems_for(weights)
check("a planted RAVE TorchScript weight FAILS", any("vintage.ts" in x for x in p), f"{p}")

# ...but a TypeScript source sharing the extension must NOT trip it.
tsrc = make_bundle(os.path.join(tmp, "tsrc"),
                   extra_files=[("Contents/Resources/ui/main.ts", b"export const x = 1;\n")])
check("a .ts TypeScript SOURCE does not trip the weight rule", problems_for(tsrc) == [],
      f"{problems_for(tsrc)}")

nonotices = make_bundle(os.path.join(tmp, "nonotices"), notices=False)
p = problems_for(nonotices)
check("a missing NOTICES.txt FAILS", any("NOTICES.txt" in x for x in p), f"{p}")

nostability = make_bundle(os.path.join(tmp, "nostability"),
                          notices=pc.emit_notices(rows, FIXTURE_REPO).replace("Powered by Stability AI", "Powered by Nobody"))
p = problems_for(nostability)
check("NOTICES missing 'Powered by Stability AI' FAILS",
      any("Powered by Stability AI" in x for x in p), f"{p}")

notracktion = make_bundle(os.path.join(tmp, "notracktion"),
                          notices=pc.emit_notices(rows, FIXTURE_REPO).replace("Powered by Tracktion Engine", "Powered by Nobody"))
p = problems_for(notracktion)
check("NOTICES missing 'Powered by Tracktion Engine' FAILS",
      any("Powered by Tracktion Engine" in x for x in p), f"{p}")

# A shipping row with no acknowledgement block — the "every §1 row that ships has a NOTICE" leg.
dropped = pc.emit_notices(rows, FIXTURE_REPO)
dropped = "\n".join(l for l in dropped.splitlines() if "Opus (libopus)" not in l)
missingrow = make_bundle(os.path.join(tmp, "missingrow"), notices=dropped)
p = problems_for(missingrow)
check("a shipping BOM row with no NOTICE block FAILS", any("Opus" in x for x in p), f"{p}")

# The enumeration leg: third-party payload with no BOM row.
payload = make_bundle(os.path.join(tmp, "payload"),
                      extra_files=[("Contents/Resources/service/soulx/model.safetensors", b"\x00" * 32)])
p = problems_for(payload)
check("shipped third-party payload with no BOM row FAILS",
      any("model.safetensors" in x for x in p), f"{p}")

# A vendored venv is payload too (torch et al ride inside one).
venv = make_bundle(os.path.join(tmp, "venv"),
                   extra_files=[("Contents/Resources/service/.venv/lib/python3.11/site-packages/torch/__init__.py", b"x")])
p = problems_for(venv)
check("a vendored venv/site-packages FAILS", any("site-packages" in x for x in p), f"{p}")

# First-party test goldens ride along in the whole-dir `scripts` copy and are NOT
# third-party payload — they must not become a permanent false failure.
golden = make_bundle(os.path.join(tmp, "golden"),
                     extra_files=[("Contents/Resources/service/scripts/golden/lora_dora_fixture.npz", b"\x00" * 16)])
check("a first-party test golden does NOT trip the enumeration", problems_for(golden) == [],
      f"{problems_for(golden)}")

# ── the notice must be the REAL licence text, not a mention of the name ────────────
#
# This is the rule the original check did not have, and its absence is why a NOTICES.txt
# with zero copyright lines and zero licence text reported "OK — 12 shipping BOM rows
# acknowledged": a row whose entire acknowledgement was the string "Notice retention"
# still contained its own name, so a name-only test passed it.

check("the emitted NOTICES carries the vendored licence body verbatim",
      FIXTURE_TRACKTION_LICENCE.rstrip("\n") in notices)
check("...and a real copyright line reaches the user",
      "Copyright (c) 2000-2026 Fixture Software Corporation." in notices)

# RED-proof: keep the dependency's NAME but strip its licence BODY — exactly the shape of
# the original bug. A name-only check passes this; the new one must not.
gutted = notices.replace(FIXTURE_TRACKTION_LICENCE.rstrip("\n"), "  Notice:  Notice retention")
check("a NOTICES.txt naming the dep but carrying NO licence text FAILS",
      any("verbatim text" in x and "fixture-tracktion" in x
          for x in problems_for(make_bundle(os.path.join(tmp, "gutted"), notices=gutted))),
      f"{problems_for(make_bundle(os.path.join(tmp, 'gutted2'), notices=gutted))}")

# ── the internal-prose regression guard ────────────────────────────────────────────
#
# Both halves are proved, because either alone is weak: the keyword list cannot see NEW
# internal prose, and the whole-cell test cannot see prose that was edited before shipping.

leaked_kw = notices + "\n\nNotice: remember the counsel-check before any raise closes\n"
check("NOTICES containing a known internal phrase FAILS",
      any("counsel-check" in x for x in
          problems_for(make_bundle(os.path.join(tmp, "leakkw"), notices=leaked_kw))),
      f"{problems_for(make_bundle(os.path.join(tmp, 'leakkw2'), notices=leaked_kw))}")

full_cell = next(r.obligations for r in rows if r.name == "Tracktion Engine")
leaked_cell = notices.replace("Powered by Tracktion Engine",
                              "Powered by Tracktion Engine\n  Notice:  " + full_cell)
check("NOTICES reproducing a whole Obligations cell FAILS",
      any("Obligations cell" in x for x in
          problems_for(make_bundle(os.path.join(tmp, "leakcell"), notices=leaked_cell))),
      f"{problems_for(make_bundle(os.path.join(tmp, 'leakcell2'), notices=leaked_cell))}")

# The clean fixture must NOT trip either half — otherwise the guard is a permanent red.
check("a clean NOTICES does not trip the internal-prose guard",
      pc.check_no_internal_prose_leaked(notices, rows) == [],
      f"{pc.check_no_internal_prose_leaked(notices, rows)}")

# ── a shipping row whose Notice cell is missing or dangling fails closed ────────────

NO_NOTICE_BOM = FIXTURE_BOM.replace(" | `licenses/fixture-tracktion.txt` |", " |")
check("a shipping row with NO Notice cell cannot even be emitted",
      isinstance(_raise_of(lambda: pc.emit_notices(pc.parse_bom_rows(NO_NOTICE_BOM),
                                                   FIXTURE_REPO)), ValueError))

DANGLING_BOM = FIXTURE_BOM.replace("licenses/fixture-tracktion.txt", "licenses/does-not-exist.txt")
check("a Notice cell naming a MISSING licence file cannot be emitted",
      isinstance(_raise_of(lambda: pc.emit_notices(pc.parse_bom_rows(DANGLING_BOM),
                                                   FIXTURE_REPO)), ValueError))
check("...and is reported against a bundle rather than silently skipped",
      any("does not exist" in x for x in
          problems_for(make_bundle(os.path.join(tmp, "dangle")), bom=DANGLING_BOM)),
      f"{problems_for(make_bundle(os.path.join(tmp, 'dangle2')), bom=DANGLING_BOM)}")

# ── the .ts hole: a NON-ZIP model must not sail through ────────────────────────────
#
# torch.jit.save has written ZIPs since 1.6, so ZIP magic was the only test. A legacy or
# otherwise non-ZIP serialisation was skipped by BOTH the forbidden-artifact rule and the
# payload enumeration (which explicitly `continue`s on a non-TorchScript .ts) — a silent
# hole in a rule whose whole purpose is "RAVE weights must never ship".
legacy = make_bundle(os.path.join(tmp, "legacyts"),
                     extra_files=[("Contents/Resources/service/transform/old.ts",
                                   b"\x80\x02}q\x00(X\x07\x00\x00\x00weightsq\x01\x00\xff\xfe")])
check("a NON-ZIP binary .ts model FAILS too",
      any("old.ts" in x for x in problems_for(legacy)), f"{problems_for(legacy)}")

# ...and the false-positive side still holds, including multibyte source. A fixed-size read
# lands mid-character on any UTF-8 file with a wide glyph near the boundary, so a plain
# .decode() here would call ordinary TypeScript "binary".
wide = ("// " + "é" * 3000 + "\nexport const x = 1;\n").encode("utf-8")
utf8src = make_bundle(os.path.join(tmp, "utf8ts"),
                      extra_files=[("Contents/Resources/ui/wide.ts", wide)])
check("a multibyte-UTF-8 TypeScript source still does NOT trip the weight rule",
      problems_for(utf8src) == [], f"{problems_for(utf8src)}")

# ── the documented static mode works on a clean tree ───────────────────────────────
#
# The allowlist is written repo-relative ("service/scripts/golden/"), but the static walk
# roots at <repo>/service, so there was no "Contents/Resources/" to split on and the prefix
# never matched: the mode reported a permanent false failure naming the exact file the
# allowlist exists for.
static_problems = pc.find_unattributed_payload(os.path.join(REPO, "service"), "service/")
check("static mode passes on the real service/ tree",
      static_problems == [], f"{static_problems}")
check("...and the first-party golden is what it would otherwise have flagged",
      pc.find_unattributed_payload(os.path.join(REPO, "service")) != [],
      "no-prefix call should still mis-flag — proving the prefix is what fixes it")

# ── the Windows layout (flat dist, no Contents/Resources) is gateable too ──────────
#
# run-mosh.ps1 does not call this check yet — `grep -c NOTICES run-mosh.ps1` is 0 — so a
# Windows build ships with no acknowledgements at all. Wiring that up needs a Windows box
# to verify; making the check layout-agnostic is the half that can be proved here, so the
# remaining work is one call site rather than a redesign.
flatdist = os.path.join(tmp, "winflat", "Mosh")
os.makedirs(os.path.join(flatdist, "service", "transform"), exist_ok=True)
with open(os.path.join(flatdist, "service", "transform", "transform_cli.py"), "w") as f:
    f.write("# mosh's own cli\n")
with open(os.path.join(flatdist, "NOTICES.txt"), "w") as f:
    f.write(notices)
check("a flat (Windows) dist with NOTICES.txt at its root passes",
      problems_for(flatdist) == [], f"{problems_for(flatdist)}")

os.remove(os.path.join(flatdist, "NOTICES.txt"))
check("...and the same dist WITHOUT it still fails",
      any("NOTICES.txt missing" in x for x in problems_for(flatdist)),
      f"{problems_for(flatdist)}")

# ── a missing/uncommitted BOM fails closed ─────────────────────────────────────────

check("an absent BOM path fails closed rather than passing",
      pc.load_bom(os.path.join(tmp, "nope.md")) is None)

shutil.rmtree(tmp, ignore_errors=True)

print(f"\n{len(fails)} failures")
sys.exit(1 if fails else 0)
