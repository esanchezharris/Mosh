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


def _top_level_modules() -> set:
    """Top-level service/*.py module names (excluding tests + server itself)."""
    return {f[:-3] for f in os.listdir(SERVICE)
            if f.endswith(".py") and not f.endswith("_test.py")}


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


body = _bundle_service_body()
bundled_files, bundled_dirs = _bundled(body)
bundled = bundled_files | bundled_dirs
top_level = _top_level_modules()

check("parsed a non-empty bundle whitelist", bool(bundled_files) and bool(bundled_dirs),
      f"files={sorted(bundled_files)} dirs={sorted(bundled_dirs)}")

# The heart: no bundled module may import a top-level service module that is absent
# from the bundle.
missing = {}  # module -> list of importer relpaths
for py in _bundled_py_files(bundled_files, bundled_dirs):
    for root in _imported_roots(py):
        if root in top_level and root not in bundled:
            missing.setdefault(root, []).append(os.path.relpath(py, REPO))

detail = "; ".join(f"{m} <- {sorted(set(v))}" for m, v in sorted(missing.items())) or "none"
check("every top-level module imported by bundled code is bundled", not missing, detail)

print(f"\n{len(fails)} failures")
sys.exit(1 if fails else 0)
