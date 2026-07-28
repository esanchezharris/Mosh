#!/usr/bin/env python3
"""Hermetic tests for service/scripts/packaging_check.py — the FS-K4 licence gate.

Auto-discovered by scripts/auto-loop/gate.sh's run_py_tests (`service/scripts/*test*.py`),
which is why the check lives under service/scripts/ rather than top-level scripts/.
No build, no network, no real bundle: every fixture is a throwaway .app-shaped dir in a
tmp dir. Deterministic.

The point of a check like this is that it FAILS on a bad bundle, and a check that
cannot fail looks exactly like one that passes. So every poisoned variant below is
asserted RED, not just the clean one asserted GREEN:

  · a planted libanira dylib
  · a planted TorchScript weight (by ZIP magic, under a non-obvious extension)
  · NOTICES missing a mandatory "Powered by …" line
  · NOTICES missing a block for a dependency that ships
  · an unmapped payload directory
  · a source .ts file, which must NOT be mistaken for a TorchScript weight
  · a *rave*-named beat recipe, which must NOT trip the RAVE artifact scan
"""
import os
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import packaging_check as pc  # noqa: E402

fails: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'ok  ' if ok else 'FAIL'}  {name}" + (f"   [{detail}]" if detail and not ok else ""))
    if not ok:
        fails.append(name)


ROWS = pc.parse_bom()


def make_bundle(tmp: Path, name: str = "Mosh.app") -> Path:
    """A minimal bundle carrying exactly the PAYLOAD entries a real one has."""
    app = tmp / name
    for d in ("Contents/MacOS", "Contents/Resources", "Contents/Frameworks"):
        (app / d).mkdir(parents=True, exist_ok=True)
    (app / "Contents/Info.plist").write_text("<plist/>", encoding="utf-8")
    (app / "Contents/MacOS/Mosh").write_bytes(b"\xcf\xfa\xed\xfe" + b"\0" * 64)  # Mach-O magic
    for d in ("service", "drumkits", "companion", "ui"):
        (app / "Contents/Resources" / d).mkdir(parents=True, exist_ok=True)
    (app / "Contents/Resources/AppIcon.icns").write_bytes(b"icns")
    (app / "Contents/Resources/RecentFilesMenuTemplate.nib").write_bytes(b"nib")
    fw = app / "Contents/Frameworks/Sparkle.framework/Versions/B"
    fw.mkdir(parents=True, exist_ok=True)
    (fw / "Sparkle").write_bytes(b"\xcf\xfa\xed\xfe" + b"\0" * 64)
    write_notices(app)
    return app


def write_notices(app: Path, body: str | None = None) -> None:
    p = app / pc.NOTICES_RELPATH
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(body if body is not None else pc.emit_notices(ROWS), encoding="utf-8")


def run(app: Path) -> pc.Result:
    return pc.check_bundle(app, ROWS)


with tempfile.TemporaryDirectory() as td:
    tmp = Path(td)

    # ── the clean bundle must PASS, or every RED below is meaningless ─────────────
    clean = make_bundle(tmp / "clean")
    res = run(clean)
    check("a clean bundle passes", res.ok, "; ".join(res.failures))

    # ── RAVE / anira artifacts (SPEC §1.11) ──────────────────────────────────────
    # Planted INSIDE an already-mapped payload dir, and asserted on the artifact
    # message specifically. Both matter: dropped at Contents/Resources/ the dylib is
    # also an *unmapped payload*, so a `"anira" in failure` assertion passes even with
    # find_forbidden() stubbed to return [] — it was reading the enumeration's failure
    # text. Caught by sabotaging the detector; the test was green for the wrong reason.
    app = make_bundle(tmp / "anira")
    (app / "Contents/Resources/service/libanira.2.dylib").write_bytes(b"\xcf\xfa\xed\xfe")
    res = run(app)
    check("planted libanira dylib FAILS",
          not res.ok and any("RAVE/anira artifact" in f for f in res.failures),
          "; ".join(res.failures))

    app = make_bundle(tmp / "torchweight")
    # A TorchScript weight is a ZIP. Give it a NON-obvious extension: extension-based
    # detection would sail past this, magic-based detection must not.
    weight = app / "Contents/Resources/service/model.bin"
    with zipfile.ZipFile(weight, "w") as z:
        z.writestr("constants.pkl", "x")
    res = run(app)
    check("planted TorchScript weight (ZIP magic, .bin) FAILS",
          not res.ok and any("TorchScript" in f for f in res.failures),
          "; ".join(res.failures))

    # Not covered hermetically: a Mach-O that LINKS LibTorch (the self-contained
    # deploy-anira build). find_forbidden() detects it with `otool -L`, but forging a
    # binary with a real LC_LOAD_DYLIB entry here would test the forgery, not the check.
    # The two name/magic paths above are what a stray artifact actually trips.

    # ── the two documented FALSE-POSITIVE traps ──────────────────────────────────
    app = make_bundle(tmp / "raverecipe")
    (app / "Contents/Resources/service/recipes").mkdir(parents=True, exist_ok=True)
    (app / "Contents/Resources/service/recipes/owner_newage_rave_beno_lead.json").write_text(
        '{"name":"newage rave"}', encoding="utf-8")
    res = run(app)
    check("a *rave*-NAMED beat recipe still PASSES (genre, not the model)",
          res.ok, "; ".join(res.failures))

    app = make_bundle(tmp / "sourcets")
    (app / "Contents/Resources/ui/helper.ts").write_text(
        "export const x = 1;\n", encoding="utf-8")
    res = run(app)
    check("a TypeScript .ts source still PASSES (not a TorchScript weight)",
          res.ok, "; ".join(res.failures))

    # ── NOTICES completeness ─────────────────────────────────────────────────────
    app = make_bundle(tmp / "nonotices")
    (app / pc.NOTICES_RELPATH).unlink()
    res = run(app)
    check("missing NOTICES.txt FAILS", not res.ok and any("NOTICES" in f for f in res.failures))

    for attribution in pc.REQUIRED_ATTRIBUTIONS:
        app = make_bundle(tmp / ("noattr" + attribution.split()[-1]))
        write_notices(app, pc.emit_notices(ROWS).replace(attribution, "(removed)"))
        res = run(app)
        check(f"NOTICES missing {attribution!r} FAILS",
              not res.ok and any(attribution in f for f in res.failures))

    shipped = pc.shipping_rows(ROWS)
    check("at least two dependencies are recorded as shipping", len(shipped) >= 2,
          f"{[r.name for r in shipped]}")
    app = make_bundle(tmp / "nodepblock")
    victim = shipped[0].name
    write_notices(app, pc.emit_notices(ROWS).replace(victim, "(removed)"))
    res = run(app)
    check(f"NOTICES missing the {victim!r} block FAILS",
          not res.ok and any(victim in f for f in res.failures))

    # ── payload enumeration (BOM §4 hook 2) ──────────────────────────────────────
    app = make_bundle(tmp / "unmapped")
    (app / "Contents/Resources/vendored-thing").mkdir(parents=True, exist_ok=True)
    res = run(app)
    check("an unmapped payload dir FAILS",
          not res.ok and any("unmapped payload" in f for f in res.failures))

    # ── NOTICES generation is driven by the BOM, and only by what ships ──────────
    body = pc.emit_notices(ROWS)
    for attribution in pc.REQUIRED_ATTRIBUTIONS:
        check(f"emitted NOTICES carries {attribution!r}", attribution in body)
    for r in shipped:
        check(f"emitted NOTICES has a block for {r.name!r}", r.name in body)

    # The distinction the whole design turns on: "Ship status: OK" in the BOM means
    # "legally clear to ship", NOT "is in the bundle". Attributing something we do not
    # distribute is false attribution, which is worse than a missing notice.
    ok_but_not_shipped = [
        r.name for r in ROWS
        if r.ship.startswith("OK") and r.name not in {s.name for s in shipped}
    ]
    check("some BOM rows are OK-to-ship but NOT bundled (the fixture is meaningful)",
          len(ok_but_not_shipped) >= 3, f"{ok_but_not_shipped}")
    leaked = [n for n in ok_but_not_shipped if n in body]
    check("NOTICES does NOT attribute dependencies that are not in the bundle",
          not leaked, f"leaked={leaked}")

    # ── the BOM parse itself must fail closed ────────────────────────────────────
    missing = tmp / "no-such-bom.md"
    try:
        pc.parse_bom(missing)
        closed = False
    except SystemExit:
        closed = True
    check("a missing BOM fails closed rather than parsing to zero rows", closed)

    empty = tmp / "empty-bom.md"
    empty.write_text("# nothing here\n", encoding="utf-8")
    try:
        pc.parse_bom(empty)
        closed = False
    except SystemExit:
        closed = True
    check("a BOM with no §1 section fails closed", closed)

print(f"\n{len(fails)} failures")
sys.exit(1 if fails else 0)
