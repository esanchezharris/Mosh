#!/usr/bin/env python3
"""Per-feature venv interpreter-path resolution must be correct on BOTH platforms.

Why: `server._venv_py()` resolves the python interpreter for a feature venv. macOS/POSIX
venvs put the interpreter at `<venv>/bin/python`; Windows venvs put it at
`<venv>\\Scripts\\python.exe`. The original code hardcoded the POSIX layout (and the mac-only
`~/Library/Mosh/venvs` root), so on Windows the conventional-default tier could NEVER resolve
a real venv — every per-feature route (transcribe/whisper/phonology/skeleton) fell through to
FakeAdapter/503 even when a venv existed. This pins the cross-platform contract.

The pure `server.venv_python(base_dir, is_windows)` helper is host-agnostic (it uses the
explicit ntpath/posixpath module, not the ambient os.path), so BOTH platform branches are
verifiable from a single macOS test run. Hermetic + deterministic: no network, no venv, no
interpreter switch.
"""
import os
import sys

SERVICE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, SERVICE)
import server  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


# --- the pure helper: POSIX layout --------------------------------------------------
posix = server.venv_python("/Users/me/Library/Mosh/venvs/whisper", is_windows=False)
check("POSIX venv → bin/python",
      posix == "/Users/me/Library/Mosh/venvs/whisper/bin/python", posix)

# --- the pure helper: Windows layout (verified from macOS via explicit ntpath) ------
win = server.venv_python(r"C:\Users\me\AppData\Local\Mosh\venvs\whisper", is_windows=True)
check("Windows venv → Scripts\\python.exe",
      win == r"C:\Users\me\AppData\Local\Mosh\venvs\whisper\Scripts\python.exe", win)

# --- backslash separators must NOT leak into the POSIX branch, and vice-versa -------
check("POSIX branch has no backslash", "\\" not in posix, posix)
check("Windows branch uses backslashes", "/" not in win, win)

# --- tier-1 explicit env override is cross-platform (unchanged behaviour) -----------
os.environ["MOSH_TEST_VENV_PTR"] = r"D:\some\explicit\python.exe"
try:
    got = server._venv_py("MOSH_TEST_VENV_PTR", "whisper")
    check("explicit env-var override wins verbatim", got == r"D:\some\explicit\python.exe", got)
finally:
    del os.environ["MOSH_TEST_VENV_PTR"]

# --- on THIS host, the conventional default ends with the host-native interpreter ---
host_default = server._venv_py("MOSH_TEST_ABSENT_PTR", "whisper")
expected_tail = "python.exe" if os.name == "nt" else "python"
check("host default ends with the native interpreter name",
      os.path.basename(host_default) == expected_tail, host_default)

print(f"\n{len(fails)} failures")
sys.exit(1 if fails else 0)
