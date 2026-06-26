# Mosh Native Completion Debug Ultrawork Notepad

## Objective
Implement and verify the Mosh Native Completion Debug Plan: fix the native master-meter overlay, resolve or document Space transport dispatch, harden `/Applications/Mosh.app` deploy signing, and prove the rebuilt installed app through targeted tests plus native GUI QA.

## Bootstrap
- Branch: `codex/mosh-native-completion-debug`.
- Worktree: primary checkout, not a linked worktree (`git_dir=.git`, `git_common=.git`, branch was `main`). Worked in place after creating a task branch because the user explicitly asked to implement in this workspace.
- Tier: HEAVY. Justification: user requested subagents/loop/thorough verification; work touches native GUI behavior, deploy/signing, real-surface QA, and installed app packaging.
- Skills used:
  - `systematic-debugging`: root cause before fixes.
  - `test-driven-development`: failing-first proof for behavior changes.
  - `verification-before-completion`: evidence before final claims.
  - `subagent-driven-development` / reviewer loop: user requested subagents; final review required.
  - `build-macos-apps:build-run-debug` and `test-triage`: macOS app build/run/test gates.
  - `computer-use:computer-use`: installed native app manual QA.
  - `using-git-worktrees`: checked isolation before branch work.

## Success Criteria And Scenarios
1. **Meter overlay fixed**
   - Scenario: run a focused UI regression test that forces `MasterMeter` into clip state and asserts the wrapper uses a meter-specific clipping class, never the global `.clip` class.
   - Expected evidence: `.omo/ultrawork/evidence/meter-red.txt`, `.omo/ultrawork/evidence/meter-green.txt`.
   - Real surface: `/Applications/Mosh.app`, click Play, screenshot topbar while master meter is active; PASS when master meter stays within topbar bounds and no tall overlay appears.
   - Expected evidence: `.omo/ultrawork/evidence/native-meter-play.png`, `.omo/ultrawork/evidence/native-meter-qa.txt`.

2. **Space transport path resolved**
   - Scenario: press Space in `/Applications/Mosh.app` with Arrange visible; PASS when command log gains `set_transport {"action":"toggle"}` and Play/Pause state changes. If not, capture exact blocker and fix smallest root cause.
   - Expected evidence: `.omo/ultrawork/evidence/native-space-qa.txt`.

3. **Deploy signing fixed**
   - Scenario: `./run-mosh.sh deploy`, then `codesign --verify --deep --strict /Applications/Mosh.app`.
   - Expected evidence: `.omo/ultrawork/evidence/deploy-codesign.txt`.

4. **Merge gates pass**
   - Scenario: targeted UI tests, Release app build, installed-app selftest 3x, undo selftest, ctest, command-log contract, final reviewer approval.
   - Expected evidence: `.omo/ultrawork/evidence/targeted-tests.txt`, `build-release.txt`, `selftest-*.txt`, `selftest-undo.txt`, `ctest.txt`, `command-log-contract.txt`, `reviewer.md`.

## Cleanup Receipts
- Pending.

## Findings
- Meter RED captured: `npm --prefix ui run test -- src/ui/Meter.test.ts` failed before production changes because `MasterMeter` used `clip` instead of `meter-clip`, and CSS lacked `.meter.meter-clip .mbar`. Evidence: `.omo/ultrawork/evidence/meter-red.txt`.
- Meter GREEN captured after the minimal rename in `ui/src/ui/Meter.tsx` and `ui/src/ui/mosh.css`: same command passes 2/2. Evidence: `.omo/ultrawork/evidence/meter-green.txt`.
