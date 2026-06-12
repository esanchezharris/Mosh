# Mosh Pause Alignment - 2026-06-12

This is the pause point for the current hardening work. Read this after
`AGENTS.md` before resuming any Mosh DAW, iOS companion, design-lab, or parked
Claude branch work.

## Current Trunk

- Program seat: `/Users/emiliosanchez-harris/Documents/ClaudeMosh`
- Branch: `main`
- Trunk before this doc-only pause marker: `95c09e2` (`Harden macOS UI
  usability gate`)
- Remote: `origin/main`
- Scope on trunk: macOS DAW hardening, local gates, rendered UI automation,
  command-log contract, and documentation.
- Hosted GitHub Actions remain manual-only. The local battery is still the
  merge gate.

`main` should not carry the new iOS companion hardening slice during this pause.
That work is preserved on side branches listed below.

## Branch And Worktree Boundaries

| Seat | Branch | Status | Rule |
| --- | --- | --- | --- |
| `/Users/emiliosanchez-harris/Documents/ClaudeMosh` | `main` | macOS program trunk | Work here for DAW hardening only. |
| `/Users/emiliosanchez-harris/Documents/ClaudeMosh-ios` | `codex/ios-companion-park` at `f898d64` | pushed side branch for iOS app continuation | Do iOS companion work here, not on `main`. |
| remote branch only | `codex/ios-companion-main-merge` at `b5881f3` | pushed exact merge candidate that combined `f898d64` with `95c09e2` | Reference or PR candidate only; do not merge without an explicit decision. |
| `/Users/emiliosanchez-harris/Documents/ClaudeMosh-lab` | `design-lab` | design playground | Off-limits for program trunk hardening. |
| `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/laughing-grothendieck-22549c` | `claude/laughing-grothendieck-22549c` | parked agent-stack stub | Do not delete, clean up, or port unless explicitly resumed. |

The pre-existing local `.claude/launch.json` path tweak was not staged into
this pause marker.

## What Is On Main

- The wave-line trunk and AGENTS contract.
- The 266-feature conformance audit and must-tier coverage from
  `docs/FEATURE_AUDIT.md`.
- Tracktion itemID patch, tempo ramps, audio warp, AU hosting, and iOS
  companion baseline that already existed on trunk before the newest side-branch
  iOS pass.
- `6a4a706` (`Harden piano roll UI automation`): rendered piano-roll UI gate
  coverage for lasso/draw, note edge resize, velocity lane, quantize, and undo
  grouping.
- `95c09e2` (`Harden macOS UI usability gate`): rendered usability gate coverage
  for the recent screenshot-visible issues: arrangement hit targets, automation
  lane affordance/interception risk, and light-mode MIDI grid visibility.

## What Is Parked Outside Main

- New iOS companion offline recovery and phone workflow hardening:
  `codex/ios-companion-park` at `f898d64`.
- Exact local main merge candidate for that iOS work:
  `codex/ios-companion-main-merge` at `b5881f3`.
- Design-lab creative experiments.
- The parked Claude agent-training stack and its separate DAW stages.

## Last Known Main Battery

Last full local battery for the current macOS trunk was run after `95c09e2`.
This pause marker is documentation-only and does not change app code.

| Gate | Command | Last result |
| --- | --- | --- |
| Build | `cmake --build build` | PASS, about 0.23s |
| Selftest | `MOSH_NO_AUDIO=1 "$APP" --selftest` | PASS, `650/650`, about 25.2s |
| Focused undo | `MOSH_NO_AUDIO=1 "$APP" --selftest-undo` | PASS, `18/18`, about 0.56s |
| CTest | `ctest --test-dir build --output-on-failure` | PASS, about 0.11s |
| Command-log contract | `scripts/validate-command-log-contract.sh` | PASS, 286 records |
| macOS UI automation | `scripts/macos-ui-automation-gate.py` | PASS |

Primary evidence:

- Main hardening report:
  `docs/hardening/2026-06-11-daw-hardening-report.md`
- Latest main UI evidence:
  `_preserved_artifacts/2026-06-08-consolidation/claudemosh/macos-ui-automation-20260611-234556`

Re-run before any code merge:

```sh
cmake --build build
APP=build/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh
MOSH_NO_AUDIO=1 "$APP" --selftest
MOSH_NO_AUDIO=1 "$APP" --selftest-undo
ctest --test-dir build --output-on-failure
scripts/validate-command-log-contract.sh
scripts/macos-ui-automation-gate.py
```

## Known Remaining Mac Risks

- The UI/usability loop needs broader screenshot/vision-style review, not just
  deterministic command validation.
- Piano roll still needs deeper audits for fold/scale, humanize/swing, dense
  chords, and multi-note edit behavior.
- Arrangement still needs rendered coverage for trim, split, snap at zoom
  extremes, and rapid undo/redo beyond the current hit-target/usability slice.
- Device settings, CoreAudio switching, and BlackHole loopback remain
  hardware-gated. The BlackHole gate can report `ENV-BLOCKED` when the system
  driver control probe is silent outside Mosh.
- Real plugin editor windows should stay in the rendered gate family because
  selftest cannot prove native editor visibility or responsiveness.

Do not start a SwiftUI rewrite as a pause action. If the renderer question comes
back, treat it as a separate architecture decision after the current JUCE/WebView
surface has screenshot-visible regression coverage.

## iOS Continuation Prompt

Use this in a separate thread when the iOS app work resumes:

```text
/goal Build out Mosh iOS Companion in /Users/emiliosanchez-harris/Documents/ClaudeMosh-ios on codex/ios-companion-park. Do not touch /Users/emiliosanchez-harris/Documents/ClaudeMosh main, /Users/emiliosanchez-harris/Documents/ClaudeMosh-lab, or .claude/worktrees/laughing-grothendieck-22549c. Start by reading AGENTS.md, docs/IPHONE_COMPANION.md, and the iOS hardening report on codex/ios-companion-park. Verify branch truth, Xcode signing/team state, simulator availability, and current HEAD f898d64 or descendant. Keep all DAW mutations on the Mac through the companion server and MoshOps; the iOS app must not mutate DAW state locally or queue offline mutations. Use simulator tests as the fast baseline, keep physical iPhone install/launch and real mic capture as separate hardware gates, save artifacts, document pass/fail evidence, and do not merge to main without explicit approval.
```

## Mac Resume Procedure

1. `cd /Users/emiliosanchez-harris/Documents/ClaudeMosh`
2. `git fetch origin --prune`
3. `git status --short --branch`
4. Confirm branch is `main` and HEAD is this pause marker or a descendant.
5. Read `AGENTS.md`, this file, and
   `docs/hardening/2026-06-11-daw-hardening-report.md`.
6. Re-run the local battery above before touching code if the working tree is
   not already known green.
7. Keep any iOS, design-lab, or parked Claude work out of this checkout unless
   the user explicitly changes the branch boundary.
