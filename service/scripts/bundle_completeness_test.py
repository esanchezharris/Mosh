#!/usr/bin/env python3
"""Deploy-bundle completeness: every TOP-LEVEL service module that bundled code
imports must itself be bundled by run-mosh.sh's `bundle_service`.

Why: `bundle_service` copies a hand-maintained list of top-level files
(server.py, audio_io.py, ...) plus a whitelist of whole dirs. When a bundled
module grows a NEW top-level dependency, it is easy to add the feature dir to the
whitelist and forget the transitive top-level module — the packaged app then
throws ModuleNotFoundError at runtime (routes 500) even though every dev-tree test
passes, because the dev tree has the module on sys.path. This class has bitten the
repo repeatedly (the FMS route dirs; then brain_client/coverage under the WP-11 /
re-imagine work). run.sh does `cd <bundle>/service && python3 server.py`, and
server.py only puts its own dir on sys.path — so a top-level import resolves ONLY
from the bundle, never the source tree.

The contract this pins: for every non-test .py that `bundle_service` ships, each
`import X` / `from X import ...` whose X is a top-level `service/X.py` module must
have X in the bundle (either copied as a file or, if X were a package, whitelisted
as a dir). Hermetic + static: parses run-mosh.sh + the sources with `ast`, no
execution, no network. Deterministic.
"""
import ast
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SERVICE = os.path.join(REPO, "service")
RUN_MOSH = os.path.join(REPO, "run-mosh.sh")
RUN_MOSH_PS1 = os.path.join(REPO, "run-mosh.ps1")

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def _bundle_service_body() -> str:
    """The text of the bundle_service() shell function."""
    src = open(RUN_MOSH, encoding="utf-8").read()
    start = src.index("bundle_service()")
    # function ends at the first line that is a lone `}` at column 0.
    end = re.search(r"\n\}", src[start:])
    return src[start:start + (end.end() if end else len(src) - start)]


def _bundled(body: str):
    """(top-level file stems, whitelisted dir names) that bundle_service ships."""
    # Top-level files: `$ROOT/service/<name>.py` with no further slash (subdir files
    # like transcribe/transcribe_cli.py are handled by their own dir/whitelist).
    files = {m for m in re.findall(r"service/([A-Za-z0-9_]+)\.py\b", body)}
    dirs: set = set()
    for m in re.finditer(r"for d in ([^;]+); do", body):
        dirs.update(m.group(1).split())
    return files, dirs


def _referenced_dirs(body: str) -> set:
    """Top-level `service/<name>/` dir names the bundle references by LITERAL path —
    a mkdir or an explicit `cp service/<name>/file` (e.g. teardown, transcribe, sketch,
    transform). These ride as PARTIAL dirs (individual files copied), not via the
    `for d in ...` whole-dir whitelist, but the package name still resolves in the
    bundle — so they count as "present" for the package-presence check below."""
    return set(re.findall(r"service/([A-Za-z0-9_]+)/", body))


def _ps1_whitelist():
    """(top-level .py stems, whitelisted dir names) the Windows packager ships.

    run-mosh.ps1's Copy-ServiceBundle bundles the SAME service subtree as bundle_service,
    but hand-maintained separately — this parses its `$topFiles`/`$dirs` arrays so the two
    whitelists can be asserted identical (drift = a route that 500s in the packaged Windows
    app only). `.sh`/`.ps1` entries (run.sh vs run.ps1, setup-sa3.sh) are excluded — only the
    top-level `.py` stems + dir set are compared."""
    src = open(RUN_MOSH_PS1, encoding="utf-8").read()

    def _array(var: str):
        m = re.search(re.escape(var) + r"\s*=\s*@\((.*?)\)", src, re.S)
        return re.findall(r'"([^"]+)"', m.group(1)) if m else []

    files = {t[:-3] for t in _array("$topFiles") if t.endswith(".py")}
    return files, set(_array("$dirs"))


def _top_level_modules() -> set:
    """Top-level service/*.py module names (excluding tests + server itself)."""
    return {f[:-3] for f in os.listdir(SERVICE)
            if f.endswith(".py") and not f.endswith("_test.py")}


def _top_level_packages() -> set:
    """Top-level `service/<pkg>/` directory names that are importable packages
    (contain at least one non-test `.py`). A `from <pkg> import ...` in bundled code
    needs <pkg> shipped — as a whole-dir whitelist entry OR via an explicit file copy —
    or the packaged app throws ModuleNotFoundError. Enumerating only `service/*.py`
    (see `_top_level_modules`) misses this whole class: a package DIR absent from the
    whitelist has no top-level `.py`, so it never trips the file check. (e.g. the
    `from compiler import core` in server.py — `compiler/` is a dir, not a file.)"""
    pkgs = set()
    for name in os.listdir(SERVICE):
        if name.startswith(".") or name == "__pycache__":
            continue
        d = os.path.join(SERVICE, name)
        if os.path.isdir(d) and any(
                f.endswith(".py") and not f.endswith("_test.py") for f in os.listdir(d)):
            pkgs.add(name)
    return pkgs


def _imported_roots(path: str):
    """Root module names imported by a python file (absolute imports only)."""
    roots = set()
    tree = ast.parse(open(path, encoding="utf-8").read(), filename=path)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                roots.add(a.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            roots.add(node.module.split(".")[0])
    return roots


def _bundled_py_files(files: set, dirs: set):
    """Every non-test .py that bundle_service ships (top-level files + dir trees)."""
    for stem in files:
        p = os.path.join(SERVICE, stem + ".py")
        if os.path.isfile(p):
            yield p
    for d in dirs:
        root = os.path.join(SERVICE, d)
        for base, _, names in os.walk(root):
            for n in names:
                if n.endswith(".py") and not n.endswith("_test.py") and not n.startswith("test_"):
                    yield os.path.join(base, n)


def _missing_imports(py_files, top_level: set, present: set):
    """{module -> sorted importer relpaths} for every top-level service module — a
    `service/X.py` FILE *or* a `service/X/` PACKAGE dir — imported by `py_files` but
    absent from `present`. Pure over its args so a synthetic `present`/`top_level`
    drives the RED-prove below without touching run-mosh.sh."""
    missing: dict = {}
    for py in py_files:
        for root in _imported_roots(py):
            if root in top_level and root not in present:
                missing.setdefault(root, []).append(os.path.relpath(py, REPO))
    return {m: sorted(set(v)) for m, v in missing.items()}


body = _bundle_service_body()
bundled_files, bundled_dirs = _bundled(body)
bundled = bundled_files | bundled_dirs
top_level_files = _top_level_modules()
top_level_pkgs = _top_level_packages()
top_level = top_level_files | top_level_pkgs
# A package is "present" if it rides as a whole-dir whitelist entry OR via explicit
# file copies (teardown/recipe.py, transcribe/transcribe_cli.py, ...) — both make its
# top-level name resolvable in the bundle.
present = bundled | _referenced_dirs(body)

check("parsed a non-empty bundle whitelist", bool(bundled_files) and bool(bundled_dirs),
      f"files={sorted(bundled_files)} dirs={sorted(bundled_dirs)}")

# The heart: no bundled module may import a top-level service module — a top-level
# `service/X.py` FILE *or* a `service/X/` PACKAGE dir — that is absent from the bundle.
py_files = list(_bundled_py_files(bundled_files, bundled_dirs))
missing = _missing_imports(py_files, top_level, present)

detail = "; ".join(f"{m} <- {v}" for m, v in sorted(missing.items())) or "none"
check("every top-level module imported by bundled code is bundled", not missing, detail)

# RED-prove the DIR half of that guard hermetically (no run-mosh.sh edit): a top-level
# PACKAGE imported by bundled code but absent from the whitelist MUST be flagged — and
# the pre-enhancement files-only enumeration (`_top_level_modules`) would have MISSED it,
# because a package dir has no top-level `.py`. `compiler` (imported by server.py) is the
# fixture; simulate dropping it from the whitelist.
probe = "compiler"
if probe in top_level_pkgs and probe in present:
    dropped = present - {probe}
    caught_new = probe in _missing_imports(py_files, top_level, dropped)        # files + pkgs
    caught_old = probe in _missing_imports(py_files, top_level_files, dropped)  # files only (pre-fix)
    check("DIR guard flags a whitelist-absent imported package (files-only missed it)",
          caught_new and not caught_old, f"caught_new={caught_new} caught_old={caught_old}")
else:
    check("DIR guard RED-prove fixture available", False,
          f"{probe}: pkg={probe in top_level_pkgs} present={probe in present}")

# The Windows packager (run-mosh.ps1) must ship the SAME service subtree, or the packaged
# Windows app 500s where the packaged mac app works. Assert the two whitelists are identical.
if os.path.isfile(RUN_MOSH_PS1):
    ps1_files, ps1_dirs = _ps1_whitelist()
    check("run-mosh.ps1 exposes a parseable Copy-ServiceBundle whitelist",
          bool(ps1_files) and bool(ps1_dirs),
          f"files={sorted(ps1_files)} dirs={sorted(ps1_dirs)}")
    check("run-mosh.ps1 top-level .py whitelist == run-mosh.sh",
          ps1_files == bundled_files,
          f"ps1-only={sorted(ps1_files - bundled_files)} sh-only={sorted(bundled_files - ps1_files)}")
    check("run-mosh.ps1 dir whitelist == run-mosh.sh",
          ps1_dirs == bundled_dirs,
          f"ps1-only={sorted(ps1_dirs - bundled_dirs)} sh-only={sorted(bundled_dirs - ps1_dirs)}")
else:
    check("run-mosh.ps1 exists (Windows packaging whitelist mirror)", False, "run-mosh.ps1 missing")

print(f"\n{len(fails)} failures")
sys.exit(1 if fails else 0)
