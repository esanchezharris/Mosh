# AGENTS.md

**Trunk:** `main` is the only development trunk (per
`docs/archive/consolidation/2026-06-09-mac-canonical-baseline-adr.md`). It carries
the full v0 DAW slice plus the post-v0 work merged through 2026-07-16: the DAW-parity
conformance scoreboard (`docs/FEATURE_AUDIT.md`), the pinned Tracktion/JUCE
patches (`patches/` 0001–0006), tempo ramps + audio warp, AU hosting, the iOS companion + the phone
**DAWN recording pad** (#239/#267), **2-player multiplayer** (PR #74), **always-on voice**
(PR #71), the DAW project-file importers (`ui/src/import/`), audio→MIDI (`/transcribe`),
the from-scratch **v2 UI shell** (default; classic preserved in `AppLegacy.tsx`),
**generative render layers on any track** (MIDI/drum auto-bounce), the single generative
tier (the synthetic Tier-A neural insert was removed; the real-time RAVE insert is gated
behind `MOSH_ENABLE_ANIRA`), **Finish-My-Song Phases 1–3** (lyrics → skeleton → sing),
the re-imagine overhaul (in-place apply + reactive re-render), the real-recipes
beat generator (`generate_beat_recipe`), `add_drum_pattern` (DRM-002), and the additive
**Windows + NVIDIA/CUDA port** (refreshed 2026-07-07, FIT-010 #245; the Windows build
itself is the owner's step). During the active vocal-first program, live status
is `docs/vocal-map-program/STATUS.md`.

**Mission:** keep the DAW correct and verified — intensive testing, verification,
and hardening. New features land additively (snapshot/events stay
backward-compatible) and behind the same MoshOps seam.

**History:** the 2026-06-12 pause marker
(`docs/archive/hardening/2026-06-12-pause-alignment.md`) is **archived/historical** —
useful for old branch boundaries and parked work, not current status.

## Vocal Map Playtest Program (active — the current work)
The focused vocal-first push to a solo-novice playtest on 2026-09-17. Entry
point: `docs/vocal-map-program/README.md`; `SPEC.md` is decision-complete,
`STATUS.md` names the only active serial seat, and `DECISIONS.md` is append-only.

**Picking up work? Read `docs/vocal-map-program/STATUS.md` first.** Work only the
single `in progress` seat in its own git worktree. Run the complete class-correct
local gate, open a PR, and stop — never merge. The owner merges each PR before
the next serial seat starts. Research may accumulate evidence, but the roster
freezes 2026-08-13 and the stack freezes 2026-08-27.

The former First-Stranger automation is paused by its tracked
`docs/first-stranger-program/STOP` sentinel. Preserve its backlog, lane plans,
status board, and evidence as historical program state. Its configured ledger
target never became a tracked file before the pause.

## Verify before any merge
```sh
cmake --build build
APP=build/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh
MOSH_NO_AUDIO=1 "$APP" --selftest        # ~1200+ checks (gate-dependent), 0 failed, 0 JUCE assertions
MOSH_NO_AUDIO=1 "$APP" --selftest-undo   # focused undo battery
```
Run it 3× for determinism and paste the tallies in the PR/commit — the LOCAL
battery is THE merge gate. **CI is best-effort signal only:** GitHub Actions were
removed 2026-06-15, re-added 2026-07-07 as a PR gate (`.github/workflows/ci.yml` +
`linux-ci.yml`, #243/#244), and Actions billing died 2026-07-11 (recovered
2026-07-27 — a red hosted check is a real failure again) — but never treat a
green (or absent) hosted check as the merge authority; the local gate
(`scripts/auto-loop/gate.sh`) is.

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
- **`design-lab`** — Emilio + Claude's design playground (branch only; its old
  worktree at `~/Documents/ClaudeMosh-lab` no longer exists). Not program code;
  do not touch.
- **iOS companion** — the former park seat (`codex/ios-companion-park` +
  `~/Documents/ClaudeMosh-ios`) is GONE: the work landed on `main` and the seat
  was cleaned up in the 2026-07-09 consolidation (history preserved as the
  `archive/ios-companion-hardening-f898d64` tag). Route iOS work through `main`.
- **Parked agent-training stack** — the paused MoshIR/replay-harness/trajectory
  stack (PR #10, closed with the park note) is preserved as the
  `archive/pr10-laughing-grothendieck` tag (its worktree was removed in the
  consolidation). Resume = `git checkout -b <name> archive/pr10-laughing-grothendieck`
  and port atop the current trunk when the owner calls it.
