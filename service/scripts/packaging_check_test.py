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


# ── fixtures ────────────────────────────────────────────────────────────────────────

# A miniature BOM with the same table shape as docs/DEPENDENCY_BOM.md §1, so parsing is
# exercised without coupling this test to the real document's exact row set.
FIXTURE_BOM = """# BOM

## §1. Verified inventory

| Dependency | License (source read) | Ship status | Threshold trigger | Obligations |
|---|---|---|---|---|
| Tracktion Engine | Dual GPLv3 / commercial EULA | OK — Personal tier (<=$50K) | >=$50K -> Indie | Free tiers require "Powered by Tracktion Engine" display |
| RAVE (code + official weights) | CC BY-NC 4.0 | **EXCLUDED from all distributed builds** (spec §1.11) | n/a | None while undistributed |
| Stable Audio 3 (small / medium / sfx) | Stability AI Community License | OK, with obligations met | Revenue-only > $1M | display "Powered by Stability AI" |
| Opus (libopus) | 3-clause BSD | OK | none | Notice retention |

## §2. Funding-trigger math

nothing here
"""


def make_bundle(tmp, notices=None, extra_files=()):
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
        notices = pc.emit_notices(pc.parse_bom_rows(FIXTURE_BOM))
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


def problems_for(app, bom=FIXTURE_BOM):
    return pc.check_bundle(app, pc.parse_bom_rows(bom))


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

notices = pc.emit_notices(rows)
check("emits a block for every shipping row",
      all(r.name in notices for r in rows if r.ships()))
check("never attributes the EXCLUDED row (it must not ship at all)",
      "RAVE (code + official weights)" not in notices)
for s in pc.REQUIRED_ATTRIBUTIONS:
    check(f"emits the mandatory attribution {s!r}", s in notices)

# The real BOM must also be emittable — this is what actually ships.
real_rows = pc.parse_bom_rows(open(os.path.join(REPO, "docs", "DEPENDENCY_BOM.md")).read())
check("the REAL docs/DEPENDENCY_BOM.md §1 parses", len(real_rows) >= 10, f"{len(real_rows)} rows")
real_notices = pc.emit_notices(real_rows)
check("real BOM emits both mandatory attributions",
      all(s in real_notices for s in pc.REQUIRED_ATTRIBUTIONS))
check("real BOM marks RAVE excluded",
      any("RAVE" in r.name and not r.ships() for r in real_rows))

# ── the clean bundle PASSES ─────────────────────────────────────────────────────────

tmp = tempfile.mkdtemp()
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
                          notices=pc.emit_notices(rows).replace("Powered by Stability AI", "Powered by Nobody"))
p = problems_for(nostability)
check("NOTICES missing 'Powered by Stability AI' FAILS",
      any("Powered by Stability AI" in x for x in p), f"{p}")

notracktion = make_bundle(os.path.join(tmp, "notracktion"),
                          notices=pc.emit_notices(rows).replace("Powered by Tracktion Engine", "Powered by Nobody"))
p = problems_for(notracktion)
check("NOTICES missing 'Powered by Tracktion Engine' FAILS",
      any("Powered by Tracktion Engine" in x for x in p), f"{p}")

# A shipping row with no acknowledgement block — the "every §1 row that ships has a NOTICE" leg.
dropped = pc.emit_notices(rows)
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

# ── a missing/uncommitted BOM fails closed ─────────────────────────────────────────

check("an absent BOM path fails closed rather than passing",
      pc.load_bom(os.path.join(tmp, "nope.md")) is None)

shutil.rmtree(tmp, ignore_errors=True)

print(f"\n{len(fails)} failures")
sys.exit(1 if fails else 0)
