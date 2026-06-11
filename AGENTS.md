# AGENTS.md

**Trunk:** `main` is the only development trunk (per
`docs/consolidation/2026-06-09-mac-canonical-baseline-adr.md`). As of
2026-06-11 it carries the wave line: the 266-feature conformance audit
(`docs/FEATURE_AUDIT.md`, must-tier 82/82), the tracktion itemID patch
(`patches/`), tempo ramps + audio warp, AU hosting, the iOS companion.

**Mission for this phase:** intensive testing, verification, and hardening
of the DAW. No new features unless a bug demands one.

## Verify before any merge
```sh
cmake --build build
APP=build/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh
MOSH_NO_AUDIO=1 "$APP" --selftest        # 650/650, 0 failed, 0 JUCE assertions
MOSH_NO_AUDIO=1 "$APP" --selftest-undo   # 18/18
```
CI (`.github/workflows/macos-ci.yml`) runs the same on PRs and is a
REQUIRED check on main. NOTE 2026-06-11: hosted runners are blocked by a
GitHub Actions billing limit — fix in account Billing & plans; until then
runs fail in seconds with "job was not started".

## Hard rules (line-independent)
- macOS / Apple Silicon arm64 only.
- One mutation path: every user-visible change is a MoshOps command
  (validate → undo transaction → events → JSONL log → result envelope).
  One undo system (Tracktion's). Honest undo postures: machine/monitoring
  preferences are `undoable:false`.
- Snapshot/event changes must be ADDITIVE (existing consumers unbroken).
- No secrets in the repo, logs, or commits — keys live in
  `~/.config/mosh/env` (mode 600). Grep staged diffs before pushing.
- Tutorial/source media is processed locally only, never redistributed.

## Other branches
- **`design-lab`** — Emilio + Claude's design playground (own worktree at
  `~/Documents/ClaudeMosh-lab`). Not program code; do not touch.
- **`claude/laughing-grothendieck-22549c`** — PARKED (PR #10 closed with
  the park note): the paused agent-training stack (MoshIR, replay harness,
  trajectory store, collab sync, Monster/GEPA, replication ladder) + its
  own DAW stages + `docs/HANDOFF.md` and recorded user corrections. Do NOT
  delete or "clean up". Resume = port atop this trunk when the owner calls
  it.
