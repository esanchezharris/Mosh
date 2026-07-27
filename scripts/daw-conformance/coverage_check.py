#!/usr/bin/env python3
"""Command-coverage ledger — the structural guarantee that "shipped but untested" cannot
silently recur (DAW-parity program, P1).

Extracts the FULL MoshOps dispatch list from src/moshops/MoshOps.cpp (the same regex
technique ui/src/agent/commands.contract.test.ts already uses on the same file) and
requires every command to appear, quoted, in at least one test surface:

  conformance  scripts/daw-conformance/conformance.py (state-level families)
  verify       scripts/verify-hardware/*.py           (rendered-audio checks)
  selftest     src/app/SelfTest.cpp                   (hermetic native harness)
  e2e          ui/e2e/*.ts                            (UI reachability specs)

A command exercised nowhere must carry a waiver in coverage_waivers.json:
  {"command": "...", "reason": "...", "expires": "YYYY-MM-DD"}
Waivers EXPIRE (forcing re-review), fail when their command disappears from the dispatch
list (stale), and fail once their command gains coverage (remove the waiver in that PR —
the file is the shrinking to-do list of the parity program, and it only shrinks).

Pure static text analysis: no binary, no build, <1s — runs in the CHEAP gate lane.
Exit 0 = every command covered or validly waived.
"""
import datetime
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SELF = Path(__file__).resolve().parent
DISPATCH = REPO / "src" / "moshops" / "MoshOps.cpp"
WAIVERS = SELF / "coverage_waivers.json"

SURFACES = {
    "conformance": lambda: [SELF / "conformance.py"],
    "verify": lambda: sorted((REPO / "scripts" / "verify-hardware").glob("*.py")),
    "selftest": lambda: [REPO / "src" / "app" / "SelfTest.cpp"],
    "e2e": lambda: sorted((REPO / "ui" / "e2e").glob("*.ts")),
}


def dispatch_commands():
    """Every command name the MoshOps dispatch chain answers to."""
    text = DISPATCH.read_text(encoding="utf-8", errors="replace")
    return sorted(set(re.findall(r'if \(name == "([a-z_0-9]+)"', text)))


def load_waivers():
    if not WAIVERS.exists():
        return []
    return json.loads(WAIVERS.read_text())


def compute(today=None):
    """Full coverage picture. Returns a dict scoreboard.py renders from:
    {commands: {cmd: [surface,...]}, waived: {cmd: waiver}, uncovered: [cmd,...],
     problems: [message,...]}  — `problems` are gate failures beyond plain uncoverage."""
    today = today or datetime.date.today().isoformat()
    cmds = dispatch_commands()
    surface_text = {name: "\n".join(p.read_text(encoding="utf-8", errors="replace")
                                    for p in paths())
                    for name, paths in SURFACES.items()}

    commands = {}
    for c in cmds:
        needle = f'"{c}"'
        commands[c] = sorted(s for s, t in surface_text.items() if needle in t)

    problems = []
    waived = {}
    for w in load_waivers():
        c = w.get("command", "")
        if c not in commands:
            problems.append(f"stale waiver: '{c}' is not in the MoshOps dispatch list — remove it")
            continue
        if commands[c]:
            problems.append(f"waiver no longer needed: '{c}' is covered by "
                            f"{','.join(commands[c])} — remove the waiver in this PR")
            continue
        if not w.get("reason", "").strip():
            problems.append(f"waiver for '{c}' has no reason")
        if w.get("expires", "") < today:
            problems.append(f"waiver for '{c}' EXPIRED {w.get('expires', '<unset>')} — "
                            f"cover the command or renew the waiver with a fresh review")
        waived[c] = w

    uncovered = [c for c in cmds if not commands[c] and c not in waived]
    return {"commands": commands, "waived": waived, "uncovered": uncovered,
            "problems": problems, "total": len(cmds)}


def main():
    cov = compute()
    n_cov = sum(1 for s in cov["commands"].values() if s)
    print(f"coverage: {cov['total']} dispatch commands | {n_cov} covered | "
          f"{len(cov['waived'])} waived | {len(cov['uncovered'])} uncovered")
    for m in cov["problems"]:
        print(f"  PROBLEM: {m}")
    for c in cov["uncovered"]:
        print(f"  UNCOVERED: {c} — add a test (conformance/verify/selftest/e2e) or a "
              f"reasoned, expiring waiver in {WAIVERS.name}")
    if cov["problems"] or cov["uncovered"]:
        print("coverage: FAIL")
        return 1
    print("coverage: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
