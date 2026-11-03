#!/usr/bin/env python3
"""The small AI tools pack's setup scripts run from inside an installed app.

docs/AI-TOOLS-OPTIONAL-BRIEF-2026-11-02.md §5.3: the app's "Add AI tools" install runs
service/sketch/setup-sketch.sh and service/transcribe/setup-transcribe.sh from inside the
signed bundle on a Mac that may have no developer tools. This pins:
  1. --python <path> builds the venv from that interpreter and never runs a python3 found
     on PATH (on such a Mac that is the stub that opens the "install developer tools"
     dialog). A bad --python fails before anything runs.
  2. --env-dir <dir> writes <name>.env there and nothing next to the script.
  3. Unknown arguments fail instead of being ignored.
  4. run.sh sources that env dir after the in-tree .env files, and an explicit
     MOSH_SERVICE_PYTHON still wins over anything written there.

No flags keeps the owner's behaviour; venv_locations_test.py covers that path.
Hermetic: fake interpreters and a fake `uv` that records its arguments; no network.
"""

import os
import shutil
import stat
import subprocess
import sys
import tempfile

if sys.platform == "win32":
    print("skip ai_tools_scripts_test: the setup scripts and run.sh are bash (POSIX-only)")
    sys.exit(0)

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SERVICE = os.path.join(REPO, "service")

# (name, script relpath under service/, in-tree env file, env var)
PACK = [
    ("sketch", "sketch/setup-sketch.sh", ".sketch.env", "SKETCH_PY"),
    ("transcribe", "transcribe/setup-transcribe.sh", ".transcribe.env", "BASIC_PITCH_PY"),
]

FAILURES = []


def check(cond, label, out=None):
    if cond:
        print(f"  ok  {label}")
    else:
        print(f"  FAIL {label}")
        FAILURES.append(label)
        if out:
            print("    " + "\n    ".join(out.strip().splitlines()[-15:]))


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def write_exec(path, text):
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


class Sandbox:
    """A temp tree with the script copied in, a trapped PATH and a fake uv.

    Every python3* on PATH writes a marker and exits 1, so a script that falls back to
    PATH is caught. The fake uv records each call; `uv venv` makes a venv whose python
    exits 0 (so the script's import check passes), and `uv pip install` succeeds.
    """

    def __init__(self, name, rel, healthy_venv=False):
        self.tmp = tempfile.mkdtemp(prefix=f"aitools-{name}-")
        self.script_dir = os.path.join(self.tmp, "Mosh.app", "service", name)
        os.makedirs(self.script_dir)
        self.script = os.path.join(self.script_dir, os.path.basename(rel))
        shutil.copy2(os.path.join(SERVICE, rel), self.script)
        self.venv = os.path.join(self.tmp, "venvs", name)
        self.venv_py = os.path.join(self.venv, "bin", "python")
        if healthy_venv:
            os.makedirs(os.path.dirname(self.venv_py))
            write_exec(self.venv_py, "#!/bin/sh\nexit 0\n")

        self.fakebin = os.path.join(self.tmp, "bin")
        os.makedirs(self.fakebin)
        self.path_python_marker = os.path.join(self.tmp, "path-python-ran")
        for cand in ("python3", "python3.11", "python3.12"):
            write_exec(
                os.path.join(self.fakebin, cand),
                f'#!/bin/sh\necho "$0 $*" >> "{self.path_python_marker}"\nexit 1\n',
            )
        self.uv_log = os.path.join(self.tmp, "uv.log")
        write_exec(
            os.path.join(self.fakebin, "uv"),
            f"""#!/bin/sh
echo "$*" >> "{self.uv_log}"
if [ "$1" = venv ]; then
  for last; do :; done
  mkdir -p "$last/bin"
  printf '#!/bin/sh\\nexit 0\\n' > "$last/bin/python"
  chmod +x "$last/bin/python"
fi
exit 0
""",
        )
        # The managed interpreter the app would pass (python-build-standalone under
        # ~/Library/Mosh/python in slice 3).
        self.managed_py = os.path.join(self.tmp, "python", "bin", "python3.11")
        os.makedirs(os.path.dirname(self.managed_py))
        write_exec(self.managed_py, '#!/bin/sh\necho "Python 3.11.9"\n')

    def run(self, *args, cwd=None):
        env = {
            "PATH": self.fakebin + os.pathsep + "/usr/bin:/bin",
            "HOME": self.tmp,
            "MOSH_VENVS_DIR": os.path.join(self.tmp, "venvs"),
        }
        proc = subprocess.run(
            ["bash", self.script, *args],
            env=env,
            cwd=cwd or self.tmp,
            capture_output=True,
            text=True,
            timeout=60,
        )
        return proc.returncode, proc.stdout + proc.stderr

    def uv_calls(self):
        return read(self.uv_log).splitlines() if os.path.exists(self.uv_log) else []

    def path_python_ran(self):
        return os.path.exists(self.path_python_marker)


def setup_script_checks():
    for name, rel, envfile, var in PACK:
        print(f"— {rel} —")

        # A fresh install from the app: managed python, env dir outside the bundle.
        sb = Sandbox(name, rel)
        env_dir = os.path.join(sb.tmp, "Application Support", "Mosh", "ai-tools")
        rc, out = sb.run("--python", sb.managed_py, "--env-dir", env_dir)
        check(rc == 0, f"{name}: installs with --python and --env-dir", out)
        venv_calls = [c for c in sb.uv_calls() if c.startswith("venv ")]
        check(
            venv_calls == [f"venv --python {sb.managed_py} {sb.venv}"],
            f"{name}: the venv is built from the --python interpreter",
            "\n".join(sb.uv_calls()),
        )
        check(not sb.path_python_ran(), f"{name}: no python3 on PATH ever runs")
        written = os.path.join(env_dir, f"{name}.env")
        check(os.path.isfile(written), f"{name}: wrote {name}.env into --env-dir")
        if os.path.isfile(written):
            check(f'{var}="{sb.venv_py}"' in read(written), f"{name}: {name}.env points {var} at the venv")
        check(
            not os.path.exists(os.path.join(sb.script_dir, envfile)),
            f"{name}: nothing written next to the script (inside the bundle)",
        )

        # Relative paths resolve against the caller's directory, not the script's.
        sb = Sandbox(name, rel, healthy_venv=True)
        rc, out = sb.run("--env-dir", "rel-env", cwd=sb.tmp)
        check(
            rc == 0 and os.path.isfile(os.path.join(sb.tmp, "rel-env", f"{name}.env")),
            f"{name}: a relative --env-dir resolves against the caller",
            out,
        )

        # A healthy venv with --env-dir: the cheap re-run, no installer.
        sb = Sandbox(name, rel, healthy_venv=True)
        rc, out = sb.run("--python", sb.managed_py, "--env-dir", os.path.join(sb.tmp, "env"))
        check(rc == 0 and sb.uv_calls() == [], f"{name}: a healthy re-run with flags installs nothing", out)

        # A --python that isn't there fails before anything runs.
        sb = Sandbox(name, rel)
        rc, out = sb.run("--python", os.path.join(sb.tmp, "nope", "python3"))
        check(
            rc != 0 and "is not an executable file" in out and sb.uv_calls() == [] and not sb.path_python_ran(),
            f"{name}: a missing --python fails without falling back to PATH",
            out,
        )

        # So does an unknown flag (it used to be ignored).
        sb = Sandbox(name, rel, healthy_venv=True)
        rc, out = sb.run("--pyhton", sb.managed_py)
        check(rc != 0 and "unknown argument: --pyhton" in out, f"{name}: an unknown argument fails", out)

        # Control: no flags still searches PATH (the owner's dev setup), which the trap catches.
        sb = Sandbox(name, rel)
        rc, out = sb.run()
        check(
            sb.path_python_ran() or any(c.startswith("venv --python python3") for c in sb.uv_calls()),
            f"{name}: control: without --python the script still picks python3 from PATH",
            out,
        )


def run_sh(env_dir_entries, intree=None, explicit_service_python=False, default_dir=False):
    """Run a copy of run.sh with a stub interpreter that dumps what it was given."""
    tmp = tempfile.mkdtemp(prefix="aitools-runsh-")
    svc = os.path.join(tmp, "service")
    os.makedirs(svc)
    shutil.copy2(os.path.join(SERVICE, "run.sh"), svc)
    for rel, text in (intree or {}).items():
        os.makedirs(os.path.dirname(os.path.join(svc, rel)), exist_ok=True)
        with open(os.path.join(svc, rel), "w") as f:
            f.write(text)

    env_dir = (
        os.path.join(tmp, "Library", "Application Support", "Mosh", "ai-tools")
        if default_dir
        else os.path.join(tmp, "ai-tools")
    )
    os.makedirs(env_dir)
    for fname, text in env_dir_entries.items():
        with open(os.path.join(env_dir, fname), "w") as f:
            f.write(text)

    dump = os.path.join(tmp, "dump.txt")
    stub = os.path.join(tmp, "stub-python")
    write_exec(
        stub,
        f'#!/bin/sh\nprintf "SKETCH_PY=%s\\nBASIC_PITCH_PY=%s\\nPY=%s\\n" '
        f'"$SKETCH_PY" "$BASIC_PITCH_PY" "$0" > "{dump}"\n',
    )
    other = os.path.join(tmp, "managed-python")
    write_exec(other, f'#!/bin/sh\necho "PY=$0" > "{dump}"\n')

    env = {
        "PATH": "/usr/bin:/bin",
        "HOME": tmp,
        "MOSH_SERVICE_LOG": os.path.join(tmp, "service.log"),
        "MOSH_ENABLE_SA3": "0",
        "MOSH_SERVICE_PYTHON": stub,
    }
    if not default_dir:
        env["MOSH_AI_TOOLS_ENV_DIR"] = env_dir
    if not explicit_service_python:
        # Let the env dir supply the interpreter instead.
        env.pop("MOSH_SERVICE_PYTHON")
        env_dir_entries_py = os.path.join(env_dir, "service.env")
        with open(env_dir_entries_py, "w") as f:
            f.write(f'export MOSH_SERVICE_PYTHON="{stub}"\n')
    else:
        with open(os.path.join(env_dir, "service.env"), "w") as f:
            f.write(f'export MOSH_SERVICE_PYTHON="{other}"\n')

    proc = subprocess.run(["bash", os.path.join(svc, "run.sh")], env=env, capture_output=True, text=True, timeout=60)
    log = read(env["MOSH_SERVICE_LOG"]) if os.path.exists(env["MOSH_SERVICE_LOG"]) else ""
    values = {}
    if os.path.exists(dump):
        for line in read(dump).splitlines():
            k, _, v = line.partition("=")
            values[k] = v
    return proc.returncode, values, proc.stdout + proc.stderr + log, stub


def run_sh_checks():
    print("— run.sh —")
    rc, v, out, _ = run_sh({"sketch.env": 'export SKETCH_PY="/managed/sketch/bin/python"\n'})
    check(rc == 0 and v.get("SKETCH_PY") == "/managed/sketch/bin/python", "run.sh sources the env dir", out)

    rc, v, out, _ = run_sh({"sketch.env": 'export SKETCH_PY="/managed/sketch/bin/python"\n'}, default_dir=True)
    check(
        rc == 0 and v.get("SKETCH_PY") == "/managed/sketch/bin/python",
        "run.sh's default env dir is ~/Library/Application Support/Mosh/ai-tools",
        out,
    )

    rc, v, out, _ = run_sh(
        {"transcribe.env": 'export BASIC_PITCH_PY="/managed/transcribe/bin/python"\n'},
        intree={
            "transcribe/.transcribe.env": 'export BASIC_PITCH_PY="/intree/transcribe/bin/python"\n',
            "sketch/.sketch.env": 'export SKETCH_PY="/intree/sketch/bin/python"\n',
        },
    )
    check(
        rc == 0
        and v.get("BASIC_PITCH_PY") == "/managed/transcribe/bin/python"
        and v.get("SKETCH_PY") == "/intree/sketch/bin/python",
        "the env dir wins over an in-tree file; an in-tree file it doesn't cover still applies",
        out,
    )

    rc, v, out, stub = run_sh({}, explicit_service_python=True)
    check(rc == 0 and v.get("PY") == stub, "an explicit MOSH_SERVICE_PYTHON beats one from the env dir", out)

    rc, v, out, stub = run_sh({})
    check(rc == 0 and v.get("PY") == stub, "the env dir can supply the service interpreter", out)


def main():
    setup_script_checks()
    run_sh_checks()
    print()
    if FAILURES:
        print(f"✗ ai_tools_scripts_test: {len(FAILURES)} failure(s)")
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    print("✓ ai_tools_scripts_test: all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
