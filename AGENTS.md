# AGENTS.md

**Trunk:** `main` is the only development trunk (per
`docs/archive/consolidation/2026-06-09-mac-canonical-baseline-adr.md`). It carries
the full v0 DAW slice plus the post-v0 work merged through 2026-06-27: the DAW-parity
conformance scoreboard (`docs/FEATURE_AUDIT.md`, regenerated from a live run — 134/152
in-scope eval rows pass; the 2026-06-09 baseline is archived), the tracktion itemID
patch (`patches/`), tempo ramps + audio warp, AU hosting, the iOS companion, **2-player
multiplayer** (PR #74), **always-on voice** (PR #71), the DAW project-file importers
(`ui/src/import/`), audio→MIDI (`/transcribe`), the from-scratch **v2 UI shell** (default;
classic preserved in `AppLegacy.tsx`), **generative render layers on any track** (MIDI/drum
auto-bounce), the single generative tier (the synthetic Tier-A neural insert was removed; the
real-time RAVE insert is gated behind `MOSH_ENABLE_ANIRA`), and the additive **Windows +
NVIDIA/CUDA port** (commit `962a03f`, unverified on hardware).
For the live status read `docs/CURRENT_STATUS.md`.

**Mission:** keep the DAW correct and verified — intensive testing, verification,
and hardening. New features land additively (snapshot/events stay
backward-compatible) and behind the same MoshOps seam.

**History:** the 2026-06-12 pause marker
(`docs/archive/hardening/2026-06-12-pause-alignment.md`) is **archived/historical** —
useful for old branch boundaries and parked work, not current status.

## First-Stranger Program (active — the current work)
The 6-week push to the first non-owner playtest. Entry point:
`docs/first-stranger-program/README.md` + `SPEC.md` (decision-complete; §1–§2 are settled —
do not re-open). Lanes (T/K/S/B/ST) live in `docs/first-stranger-program/backlog.jsonl`; each
has a gate-registered plan in `docs/first-stranger-program/lanes/FS-*.md`; the live board is
`docs/first-stranger-program/STATUS.md`.

**Picking up a lane? Read `docs/first-stranger-program/CODEX_HANDOFF.md`.** In one line: choose a
`ready` lane, read its `lanes/FS-*.md` plan, implement it in **its own git worktree** obeying
SPEC §0, run `scripts/auto-loop/gate.sh native <worktree> origin/main`, open a PR — **never merge.**
The owner merges; most lanes touch engine/auth/packaging/relay/state and are owner-gated by design.
(`scripts/first-stranger/codex-lane.sh <FS-ID>` prints a ready-to-paste prompt for exactly this.)

## Verify before any merge
```sh
cmake --build build
APP=build/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh
MOSH_NO_AUDIO=1 "$APP" --selftest        # 1032 checks (gate-dependent), 0 failed, 0 JUCE assertions
MOSH_NO_AUDIO=1 "$APP" --selftest-undo   # focused undo battery
```
Run it 3× for determinism and paste the tallies in the PR/commit — the LOCAL
battery is THE merge gate. **There is no hosted CI:** GitHub Actions were removed
on 2026-06-15 by owner decision (hosted macOS runners are paid, 10x minute
multiplier). If automated CI is ever wanted, use a self-hosted runner on the studio
Mac — never re-enable hosted triggers without a budget decision.

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
- **`codex/ios-companion-park`** — the iOS companion hardening slice (own
  worktree at `~/Documents/ClaudeMosh-ios`); `codex/ios-companion-main-merge`
  is its prebuilt merge candidate — do not merge without an explicit decision.
- **`claude/laughing-grothendieck-22549c`** — PARKED (PR #10 closed with
  the park note): the paused agent-training stack (MoshIR, replay harness,
  trajectory store, collab sync, Monster/GEPA, replication ladder) + its
  own DAW stages + `docs/HANDOFF.md` and recorded user corrections. Do NOT
  delete or "clean up". Resume = port atop this trunk when the owner calls
  it.
