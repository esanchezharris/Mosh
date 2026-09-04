#!/usr/bin/env python3
"""Venv-location conformance: per-feature venvs must default OUTSIDE the repo tree.

Why: the in-tree service/<name>/.venv dirs sat under iCloud-synced ~/Documents and
iCloud silently evicted files out of them twice in two days (2026-07-02 onnxruntime
vanished from transcribe/.venv; 2026-07-03 basic_pitch/*.py vanished) — breaking
/transcribe (503) and the FCPE skeleton upgrade with no error at install time.

The contract this test pins (for every venv-creating setup-*.sh):
  1. The venv defaults to $MOSH_VENVS_DIR/<name> (default ~/Library/Mosh/venvs/<name>),
     never in-tree.
  2. The .env file next to the script is still written (single source of truth for
     run.sh / server.py / parseFlp.ts).
  3. Re-running against a healthy venv is CHEAP: validate imports, rewrite the .env,
     and do NOT touch the network / package installer at all.
  4. A legacy in-tree .venv is removed once the new venv validates.
  5. `--reinstall` forces the full install path.

Behavioral checks copy each script into a temp dir and run it against a shim venv
(a fake bin/python that exits 0) with a booby-trapped `uv` on PATH that exits 1 —
so any install attempt during a healthy re-run fails loudly. Hermetic: no network,
no pip, deterministic.
"""

import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import tempfile

if sys.platform == "win32":
    print(
        "skip venv_locations_test: it exercises the 8 setup-*.sh BASH scripts (POSIX-only"
        " by nature); the Windows analogue setup-feature-venv.ps1 is covered by"
        " service/scripts/venv_python_path_test.py"
    )
    sys.exit(0)

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SERVICE = os.path.join(REPO, "service")

# (name, script relpath under service/, env file name, env var)
SCRIPTS = [
    ("transcribe", "transcribe/setup-transcribe.sh", ".transcribe.env", "BASIC_PITCH_PY"),
    ("skeleton", "skeleton/setup-skeleton.sh", ".skeleton.env", "SKELETON_PY"),
    ("whisper", "whisper/setup-whisper.sh", ".whisper.env", "WHISPER_PY"),
    ("phonology", "phonology/setup-phonology.sh", ".phonology.env", "PHONOLOGY_PY"),
    ("sketch", "sketch/setup-sketch.sh", ".sketch.env", "SKETCH_PY"),
    ("transform", "transform/setup-transform.sh", ".transform.env", "TRANSFORM_PY"),
    ("flp", "flp/setup-flp.sh", ".flp.env", "FLP_PY"),
    ("sft", "sft/setup-sft.sh", ".sft.env", "SFT_PY"),
]

FAILURES = []


def check(cond, label):
    if cond:
        print(f"  ok  {label}")
    else:
        print(f"  FAIL {label}")
        FAILURES.append(label)


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def write_exec(path, text):
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def static_checks():
    print("— static: setup scripts default out-of-tree, keep the .env seam —")
    for name, rel, envfile, var in SCRIPTS:
        text = read(os.path.join(SERVICE, rel))
        # The VENV assignment itself must not point in-tree (LEGACY_VENV="$HERE/.venv",
        # used for cleanup, is fine — anchor at line start).
        check(
            not re.search(r'^VENV="\$HERE/\.venv"', text, re.MULTILINE),
            f"{rel}: no in-tree venv default",
        )
        check("MOSH_VENVS_DIR" in text, f"{rel}: MOSH_VENVS_DIR override supported")
        check("Library/Mosh/venvs" in text, f"{rel}: defaults under ~/Library/Mosh/venvs")
        check(f'ENVFILE="$HERE/{envfile}"' in text, f"{rel}: still writes {envfile}")
        check("--reinstall" in text, f"{rel}: supports --reinstall")

    run_sh = read(os.path.join(SERVICE, "run.sh"))
    for name, rel, envfile, var in SCRIPTS:
        if name in ("flp",):  # flp env is read by ui/src/import/parseFlp.ts, not run.sh
            continue
        check(f"{os.path.dirname(rel)}/{envfile}" in run_sh, f"run.sh sources {envfile}")

    server = read(os.path.join(SERVICE, "server.py"))
    check("def _venv_py(" in server, "server.py: shared _venv_py resolver exists")
    for var, name in [
        ("BASIC_PITCH_PY", "transcribe"),
        ("WHISPER_PY", "whisper"),
        ("SKETCH_PY", "sketch"),
        ("SKELETON_PY", "skeleton"),
        ("PHONOLOGY_PY", "phonology"),
        # teardown has no setup-teardown.sh (the venv is provisioned by hand, not by the
        # setup-*.sh convention the SCRIPTS list below exercises behaviorally) — this row
        # only pins that server.py resolves it through the shared _venv_py helper too.
        ("TEARDOWN_PY", "teardown"),
    ]:
        check(f'_venv_py("{var}", "{name}")' in server, f"server.py: {var} resolves via _venv_py")

    for rel in ("scripts/verify-hardware/rave_check.py", "scripts/verify-hardware/rave_insert_check.py"):
        text = read(os.path.join(REPO, rel))
        check("Library/Mosh/venvs" in text, f"{rel}: conventional-location fallback")


def run_script(script_src, name, extra_env=None, args=()):
    """Copy the script into a temp tree and run it against a shim venv.

    Returns (rc, output, script_dir, shim_py). The temp PATH front-runs a `uv`
    that exits 1, so any install attempt fails the run.
    """
    tmp = tempfile.mkdtemp(prefix=f"venvloc-{name}-")
    script_dir = os.path.join(tmp, "svc", name)
    os.makedirs(script_dir)
    script = os.path.join(script_dir, os.path.basename(script_src))
    shutil.copy2(script_src, script)

    venv = os.path.join(tmp, "venvs", name)
    os.makedirs(os.path.join(venv, "bin"))
    shim_py = os.path.join(venv, "bin", "python")
    write_exec(shim_py, "#!/bin/sh\nexit 0\n")

    legacy = os.path.join(script_dir, ".venv")
    os.makedirs(legacy)
    with open(os.path.join(legacy, "marker.txt"), "w") as f:
        f.write("legacy in-tree venv\n")

    fakebin = os.path.join(tmp, "bin")
    os.makedirs(fakebin)
    write_exec(
        os.path.join(fakebin, "uv"),
        '#!/bin/sh\necho "uv invoked — install attempted on a healthy re-run" >&2\nexit 1\n',
    )

    env = dict(os.environ)
    env["PATH"] = fakebin + os.pathsep + env.get("PATH", "")
    env["MOSH_VENVS_DIR"] = os.path.join(tmp, "venvs")
    env.update(extra_env or {})

    proc = subprocess.run(
        ["bash", script, *args],
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    return proc.returncode, proc.stdout + proc.stderr, script_dir, shim_py


def behavioral_checks():
    print("— behavioral: healthy re-run is cheap (no installer), env written, legacy cleaned —")
    for name, rel, envfile, var in SCRIPTS:
        if name == "sft" and (platform.system() != "Darwin" or platform.machine() != "arm64"):
            print(f"  skip {rel} (sft setup is Apple-Silicon-only)")
            continue
        extra = None
        if name == "transform":  # keep the model-dir side effect out of $HOME
            extra = {"RAVE_MODEL_DIR": tempfile.mkdtemp(prefix="venvloc-models-")}
        src = os.path.join(SERVICE, rel)
        rc, out, script_dir, shim_py = run_script(src, name, extra_env=extra)
        ok = rc == 0
        check(ok, f"{rel}: healthy re-run exits 0 without installing")
        if not ok:
            print("    --- output ---")
            print("    " + "\n    ".join(out.strip().splitlines()[-15:]))
            continue
        envpath = os.path.join(script_dir, envfile)
        check(os.path.isfile(envpath), f"{rel}: wrote {envfile}")
        if os.path.isfile(envpath):
            content = read(envpath)
            check(
                f'{var}="{shim_py}"' in content,
                f"{rel}: {envfile} points {var} at the MOSH_VENVS_DIR venv",
            )
        check(
            not os.path.isdir(os.path.join(script_dir, ".venv")),
            f"{rel}: legacy in-tree .venv removed after validation",
        )

    # --reinstall must force the full install path (the booby-trapped uv fires).
    rc, out, _, _ = run_script(
        os.path.join(SERVICE, "transcribe/setup-transcribe.sh"), "transcribe", args=("--reinstall",)
    )
    check(rc != 0 and "uv invoked" in out, "setup-transcribe.sh --reinstall forces the install path")


def main():
    static_checks()
    behavioral_checks()
    print()
    if FAILURES:
        print(f"✗ venv_locations_test: {len(FAILURES)} failure(s)")
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    print("✓ venv_locations_test: all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
