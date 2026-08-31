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
import shutil
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SERVICE = os.path.join(REPO, "service")
RUN_MOSH = os.path.join(REPO, "run-mosh.sh")
RUN_MOSH_PS1 = os.path.join(REPO, "run-mosh.ps1")
PACKAGE_GUEST = os.path.join(REPO, "scripts", "playtest", "package-guest-zip.sh")

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


def _shell_brain_keys():
    return set(re.findall(
        r"\bMOSH_BRAIN_PROXY_[A-Z]+\b", _shell_function("bundle_brain_key")))


def _ps1_brain_keys():
    return set(re.findall(
        r"\bMOSH_BRAIN_PROXY_[A-Z]+\b", _ps1_function("Write-BundledBrainKey")))


def _shell_function(name: str) -> str:
    src = open(RUN_MOSH, encoding="utf-8").read()
    start = src.index(f"{name}()")
    end = re.search(r"\n\}", src[start:])
    return src[start:start + (end.end() if end else len(src) - start)]


def _bundle_shell_brain_env(proxy_url: str, proxy_key: str):
    with tempfile.TemporaryDirectory() as tmp:
        app = os.path.join(tmp, "Mosh.app")
        resources = os.path.join(app, "Contents", "Resources")
        os.makedirs(resources)
        script = "\n".join((
            "set -euo pipefail",
            _shell_function("refuse_provider_brain_keys"),
            _shell_function("validate_brain_proxy_value"),
            _shell_function("brain_env_is_proxy_only"),
            _shell_function("bundle_brain_key"),
            'bundle_brain_key "$1"',
        ))
        env = os.environ.copy()
        for key in ("OPENAI_API_KEY", "DEEPSEEK_API_KEY", "XAI_API_KEY",
                    "GROK_API_KEY", "LOCAL_API_KEY"):
            env.pop(key, None)
        env["MOSH_BRAIN_PROXY_URL"] = proxy_url
        env["MOSH_BRAIN_PROXY_APIKEY"] = proxy_key
        result = subprocess.run(
            ["bash", "-c", script, "brain-bundle-check", app],
            env=env, check=False, capture_output=True, text=True)
        brain_file = os.path.join(resources, "brain.env")
        contents = open(brain_file, encoding="utf-8").read() \
            if os.path.isfile(brain_file) else None
        return result, contents


def _ps1_function(name: str) -> str:
    src = open(RUN_MOSH_PS1, encoding="utf-8").read()
    start = src.index(f"function {name}")
    end = re.search(r"\n\}", src[start:])
    return src[start:start + (end.end() if end else len(src) - start)]


def _windows_brain_bundle_rejects_control_chars() -> bool:
    shell = shutil.which("pwsh") or shutil.which("powershell")
    functions = "\n\n".join((
        _ps1_function("Assert-SingleLineBrainProxyValue"),
        _ps1_function("Write-BundledBrainKey"),
    ))
    if not shell:
        return all(token in functions for token in (
            "[char]0", "[char]10", "[char]13",
            "Assert-SingleLineBrainProxyValue -Name \"MOSH_BRAIN_PROXY_URL\"",
            "Assert-SingleLineBrainProxyValue -Name \"MOSH_BRAIN_PROXY_APIKEY\"",
            "[System.IO.File]::ReadAllLines($BrainFile)",
            "$written.Count -ne 2",
            "'^MOSH_BRAIN_PROXY_URL=.+$'",
            "'^MOSH_BRAIN_PROXY_APIKEY=.+$'",
        ))

    with tempfile.TemporaryDirectory() as tmp:
        brain_file = os.path.join(tmp, "brain.env")
        test = os.path.join(tmp, "brain-bundle-test.ps1")
        with open(test, "w", encoding="utf-8") as handle:
            handle.write(functions)
            handle.write("\n".join((
                "$ok = $true",
                'foreach ($bad in @("bad`nline", "bad`rline", "bad$([char]0)line")) {',
                '    try { Assert-SingleLineBrainProxyValue -Name "test" -Value $bad; $ok = $false } catch { }',
                "}",
                '$env:MOSH_BRAIN_PROXY_URL = "https://example.invalid/brain"',
                '$env:MOSH_BRAIN_PROXY_APIKEY = "test-publishable"',
                "Write-BundledBrainKey $args[0]",
                '$expected = "MOSH_BRAIN_PROXY_URL=https://example.invalid/brain`nMOSH_BRAIN_PROXY_APIKEY=test-publishable`n"',
                "if ([System.IO.File]::ReadAllText($args[0]) -ne $expected) { $ok = $false }",
                '$env:MOSH_BRAIN_PROXY_URL = "https://example.invalid/brain`nOPENAI_API_KEY=test-injected"',
                "try { Write-BundledBrainKey $args[0]; $ok = $false } catch { }",
                "if (Test-Path $args[0]) { $ok = $false }",
                "if ($ok) { exit 0 } else { exit 1 }",
                "",
            )))
        result = subprocess.run(
            [shell, "-NoProfile", "-File", test, brain_file],
            check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return result.returncode == 0 and not os.path.exists(brain_file)


def _package_guest_brain_configured(env_text: str) -> bool:
    src = open(PACKAGE_GUEST, encoding="utf-8").read()
    start = src.index("brain_env_configured()")
    end = re.search(r"\n\}", src[start:])
    body = src[start:start + (end.end() if end else len(src) - start)]
    with tempfile.NamedTemporaryFile("w", encoding="utf-8") as env_file:
        env_file.write(env_text)
        env_file.flush()
        result = subprocess.run(
            ["bash", "-c", body + '\nbrain_env_configured "$1"', "brain-env-check", env_file.name],
            check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return result.returncode == 0


def _package_guest_has_provider_key(env_text: str) -> bool:
    src = open(PACKAGE_GUEST, encoding="utf-8").read()
    start = src.index("brain_env_has_provider_key()")
    end = re.search(r"\n\}", src[start:])
    body = src[start:start + (end.end() if end else len(src) - start)]
    with tempfile.NamedTemporaryFile("w", encoding="utf-8") as env_file:
        env_file.write(env_text)
        env_file.flush()
        result = subprocess.run(
            ["bash", "-c", body + '\nbrain_env_has_provider_key "$1"', "brain-env-check", env_file.name],
            check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return result.returncode == 0


def _package_guest_extracted_functions() -> set:
    src = open(PACKAGE_GUEST, encoding="utf-8").read()
    match = re.search(r"for fn in (.*?); do", src)
    return set(match.group(1).split()) if match else set()


def _release_refuses_provider_key() -> bool:
    with tempfile.NamedTemporaryFile("w", encoding="utf-8") as env_file:
        env_file.write(" OPENAI_API_KEY = test-provider\n")
        env_file.flush()
        env = os.environ.copy()
        for key in ("OPENAI_API_KEY", "DEEPSEEK_API_KEY", "XAI_API_KEY", "GROK_API_KEY", "LOCAL_API_KEY"):
            env.pop(key, None)
        env["MOSH_BRAIN_ENV"] = env_file.name
        try:
            result = subprocess.run(
                [RUN_MOSH, "release"], env=env, check=False, capture_output=True, text=True,
                timeout=10)
        except subprocess.TimeoutExpired:
            return False
    return result.returncode != 0 and "refusing to bundle provider API keys" in (
        result.stdout + result.stderr)


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

check("macOS deploy preserves the owner local-brain launcher",
      "service/sft/launch_local_brain.py" in body and "sft" in _referenced_dirs(body))

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
    shell_brain_keys = _shell_brain_keys()
    ps1_brain_keys = _ps1_brain_keys()
    check("macOS brain bundle is proxy-only",
          shell_brain_keys == {"MOSH_BRAIN_PROXY_URL", "MOSH_BRAIN_PROXY_APIKEY"},
          f"keys={sorted(shell_brain_keys)}")
    check("run-mosh.ps1 brain bundle keys == run-mosh.sh",
          ps1_brain_keys == shell_brain_keys,
          f"ps1-only={sorted(ps1_brain_keys - shell_brain_keys)} sh-only={sorted(shell_brain_keys - ps1_brain_keys)}")
    valid_result, valid_contents = _bundle_shell_brain_env(
        "https://example.invalid/brain", "test-publishable")
    check("macOS brain bundle serializes exactly two proxy-only lines",
          valid_result.returncode == 0 and valid_contents == (
              "MOSH_BRAIN_PROXY_URL=https://example.invalid/brain\n"
              "MOSH_BRAIN_PROXY_APIKEY=test-publishable\n"))
    injected_result, injected_contents = _bundle_shell_brain_env(
        "https://example.invalid/brain\nOPENAI_API_KEY=test-injected",
        "test-publishable")
    carriage_result, carriage_contents = _bundle_shell_brain_env(
        "https://example.invalid/brain",
        "test-publishable\rXAI_API_KEY=test-injected")
    check("macOS brain bundle rejects CR and LF injection before writing",
          injected_result.returncode != 0 and injected_contents is None
          and carriage_result.returncode != 0 and carriage_contents is None)
    check("Windows brain bundle rejects NUL, CR, and LF injection",
          _windows_brain_bundle_rejects_control_chars())
    check("guest package recognizes proxy-only brain configuration",
          _package_guest_brain_configured(
              "MOSH_BRAIN_PROXY_URL=https://example.invalid/brain\n"
              "MOSH_BRAIN_PROXY_APIKEY=test-publishable\n"))
    check("guest package rejects direct-provider brain configuration",
          not _package_guest_brain_configured(" OPENAI_API_KEY = test-provider\n")
          and _package_guest_has_provider_key(" OPENAI_API_KEY = test-provider\n"))
    check("guest package rejects keyless or incomplete brain configuration",
          not _package_guest_brain_configured("MOSHI_BRAIN_PROVIDER=openai\n")
          and not _package_guest_brain_configured(
              "MOSH_BRAIN_PROXY_URL=https://example.invalid/brain\n"))
    check("guest package extracts every brain-bundle validation helper",
          {"refuse_provider_brain_keys", "validate_brain_proxy_value",
           "brain_env_is_proxy_only", "bundle_brain_key"}.issubset(
               _package_guest_extracted_functions()))
    check("run-mosh.sh release refuses a configured provider key before preflight",
          _release_refuses_provider_key())
else:
    check("run-mosh.ps1 exists (Windows packaging whitelist mirror)", False, "run-mosh.ps1 missing")

print(f"\n{len(fails)} failures")
sys.exit(1 if fails else 0)
