# ClaudeMosh de-slop verification-surface gate review

recommendation: REJECT

## originalIntent

Act as a read-only verification-surface audit agent for
`/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626`.
Map current available gates to a requested de-slop campaign and identify backlog gaps. Hosted CI is absent;
local evidence is authoritative. Installed app proof means `/Applications/Mosh.app`.

## desiredOutcome

A concise, artifact-backed report that tells the owner which gates can currently prove which wave types,
the exact commands to run, where evidence lands, and what backlog items are needed before the de-slop
campaign can be trusted.

## userOutcomeReview

The current tree exposes useful local gates, but it is not yet a complete de-slop campaign verification
surface. It can prove UI behavior, command-surface/native behavior, some render-to-WAV audio correctness,
and selected installed-app/manual surfaces when invoked with the correct binary. It does not yet force the
`remove-ai-slops` process guarantees: behavior-lock tests before cleanup, categorized slop review, overfit
test detection, LOC/no-excuse checks, or a review report that explicitly covers slop/overfit criteria.

The audited tracked source diff is empty against `origin/main`:

```sh
git -C /Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626 diff --stat origin/main...HEAD
git -C /Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626 rev-parse --short HEAD origin/main
```

Observed: empty tracked diff; both refs at `9429008d`. Local `.omo/evidence/` files are untracked
audit artifacts and are not source evidence.

## checked artifact paths

- `docs/CURRENT_STATUS.md`
- `docs/VERIFICATION.md`
- `CLAUDE.md`
- `docs/auto-loop/README.md`
- `docs/auto-loop/BACKLOG.md`
- `docs/auto-loop/backlog.jsonl`
- `docs/auto-loop/LEDGER.md`
- `.claude/workflows/auto-loop.workflow.js`
- `scripts/auto-loop/classify.sh`
- `scripts/auto-loop/gate.sh`
- `scripts/auto-loop/lib.sh`
- `scripts/auto-loop/discover.sh`
- `scripts/auto-loop/merge-one.sh`
- `scripts/auto-loop/new-worktree.sh`
- `scripts/auto-loop/seed-cache.sh`
- `scripts/macos-ui-automation-gate.py`
- `scripts/verify-hardware/README.md`
- `scripts/verify-hardware/verify.py`
- `scripts/verify-hardware/voice-loopback.sh`
- `scripts/verify-pc-build.ps1`
- `scripts/validate-command-log-contract.sh`
- `scripts/plugin-host-evidence-gate.sh`
- `ui/package.json`
- `ui/playwright.config.ts`
- `ui/vitest.config.ts`
- `CMakePresets.json`
- `CMakeLists.txt`
- `tests/CMakeLists.txt`

## non-mutating commands run

```sh
git status --short --branch
git diff --name-status origin/main...HEAD
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git log --oneline --decorate -5
scripts/auto-loop/classify.sh origin/main /Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626
cmake --list-presets=all
cmake --build --list-presets
cd ui && npm run
ctest --test-dir build-macos-arm64-release -N
ctest --test-dir build-macos-arm64-release --output-on-failure
find build-macos-arm64-release -maxdepth 3 \( -name CTestTestfile.cmake -o -name MoshTests \) -print
```

Observed:

- `classify.sh` returned `{"class":"native","excluded":false,"diff_empty":true,...}` for the current empty diff.
- CMake exposes configure presets `macos-arm64-debug`, `macos-arm64-release`, `windows-x64-debug`,
  `windows-x64-release` and app/test/plugin-fixture build presets, but no `testPresets`.
- Existing `build-macos-arm64-release` is not current evidence: `ctest` reported `No tests were found!!!`
  and no `CTestTestfile.cmake` or `MoshTests` binary exists there. The native gate must configure/build before CTest.

## gate map

| Gate | Exact command | Evidence path | Applies to wave types | Notes |
| --- | --- | --- | --- | --- |
| Diff classification | `scripts/auto-loop/classify.sh origin/main <worktree>` | JSON stdout | Routing only: cheap vs native; exclusion detection | Current mismatch: `scripts/auto-loop/*` is cheap, but rulebook says the loop must not edit its own gate/rulebook. |
| Cheap auto-loop gate | `scripts/auto-loop/gate.sh cheap <worktree> origin/main` | JSON stdout only unless caller preserves it; Playwright may write `ui/e2e-report/` and `ui/e2e-results/` | UI-only, docs, selected service/relay Python, auto-loop scripts | Runs `npm run typecheck`, `npm test`, `npm run test:e2e`, touched-dir Python tests, and swappability by classification. No durable step logs; no lint/static/security/slop pass. |
| Native auto-loop gate | `MOSH_SELFTEST_BASELINE=<N> scripts/auto-loop/gate.sh native <worktree> origin/main` | JSON stdout; `verify-artifacts/report.json` and WAVs from `verify.py`; command/session logs under `~/Library/Mosh/<session>/` | C++/MoshOps/native app, CMake/build resources, model-fed service adapter/color/SA3 changes, native backlog items | Builds Release app/tests, runs CTest/Catch2, `--selftest` x3, `verify.py`, and vitest. Uses worktree build binary, not installed app. |
| CMake app build | `cmake --preset macos-arm64-release && cmake --build --preset macos-arm64-release-app` | `build-macos-arm64-release/Mosh_artefacts/Release/Mosh.app` | Native release verification and native auto-loop gate | Build output is local, not installed-app proof. |
| CMake Catch2 | `cmake --build --preset macos-arm64-release-tests && ctest --test-dir build-macos-arm64-release --output-on-failure` | CTest stdout; `build-macos-arm64-release/tests/` after configure | Engine-free C++ units: render layer, remote companion, sections, annotations, multiplayer IDs/locks, training | Add a CMake `testPresets` entry and fail if zero tests are registered. |
| Command-surface selftest | `APP=build-macos-arm64-release/Mosh_artefacts/Release/Mosh.app/Contents/MacOS/Mosh; MOSH_NO_AUDIO=1 MOSH_SELFTEST_SESSION=<unique> MOSH_SERVICE_PORT=<free> "$APP" --selftest` | stdout tally; `~/Library/Mosh/<session>/mosh-log.jsonl` | MoshOps command contract, undo, snapshot/events, native headless behavior | Auto-loop native gate runs x3 with deterministic check-count and assertion checks. |
| Undo selftest | `MOSH_NO_AUDIO=1 "$APP" --selftest-undo` | stdout tally; session logs | Focused undo regression waves | Mentioned in docs; not part of auto-loop `gate.sh`. |
| Command-log contract | `scripts/validate-command-log-contract.sh ~/Library/Mosh/<session>/mosh-log.jsonl 500` | stdout | MoshOps JSONL schema / expected commands | Mentioned in docs; not part of auto-loop `gate.sh`. |
| UI typecheck/unit/e2e | `cd ui && npm run typecheck && npm test && npm run test:e2e` | stdout; `ui/e2e-report/`; `ui/e2e-results/` on failures | Cheap UI and frontend contract waves | Local Playwright has `forbidOnly` only under `CI`; hosted CI is absent, so `.only` needs an explicit local grep or env guard. |
| macOS UI automation | `MOSH_APP_BUNDLE=/Applications/Mosh.app MOSH_EVID=<artifact-dir> python3 scripts/macos-ui-automation-gate.py` | `<artifact-dir>/result.json`, `REPORT.md`, screenshots, `service.log`, `mosh-app.log`, `last-ax.tsv` | Installed-app visual/UI interaction smoke, if invoked with `/Applications/Mosh.app` | Default app path is the Debug build, not installed app. `main()` currently exercises demo6 only; demo3/demo5 helpers exist but are not run. |
| Offline render-to-WAV | `python3 scripts/verify-hardware/verify.py --bin /Applications/Mosh.app/Contents/MacOS/Mosh` | `verify-artifacts/report.json`, `*.wav`, `*.script.jsonl`, `*.results.jsonl`; session render artifacts under `~/Library/Mosh/<session>/renders/` | Audio/export/render-layer regressions, transform fake path, relative-ref export hang, bypass reroute, render-artifact portability | Default binary search prefers local build before installed app; installed-app proof must pass `--bin /Applications/Mosh.app/Contents/MacOS/Mosh`. |
| SA3 render | `python3 scripts/verify-hardware/verify.py --bin /Applications/Mosh.app/Contents/MacOS/Mosh --sa3` | `verify-artifacts/report.json`, SA3 output WAV/manifest | Real SA3/generative model changes | Requires wired SA3 service/model. |
| RAVE transform | `python3 scripts/verify-hardware/verify.py --bin /Applications/Mosh.app/Contents/MacOS/Mosh --rave` | `verify-artifacts/report.json`; RAVE temp/model outputs | Real RAVE transform path | Requires transform venv/model setup. |
| RAVE insert | `python3 scripts/verify-hardware/verify.py --rave-insert --bin build-anira/Mosh_artefacts/Release/Mosh.app/Contents/MacOS/Mosh` | `verify-artifacts/report.json`; RAVE insert WAV details | Anira/LibTorch real-time insert waves | Not installed-app unless the installed app is the anira bundle and `--bin /Applications/...` is used. |
| Voice smoke | `/Applications/Mosh.app/Contents/MacOS/Mosh --voice-smoke` or `scripts/verify-hardware/voice-loopback.sh /Applications/Mosh.app/Contents/MacOS/Mosh` | stdout; `~/Library/Mosh/voice-smoke-result.txt`; loopback script restores devices | Speech Recognition / mic waves | Permission-gated; live/machine state gate, not auto-loop work. |
| Plugin-host evidence | `MOSH_APP_BIN=/Applications/Mosh.app/Contents/MacOS/Mosh MOSH_EVID=<artifact-dir> scripts/plugin-host-evidence-gate.sh` | `<artifact-dir>/selftest.log`, `REPORT.md`, optional `assertions.txt` | Plugin-hosting smoke and installed-app selftest evidence | Not part of auto-loop gate. |
| Windows/NVIDIA port | `pwsh -NoProfile -File scripts\\verify-pc-build.ps1 -Repeat 3` and optionally `-RealSA3` | PowerShell stdout and redirected temp selftest logs | Windows/CUDA waves only | Must run on Windows/NVIDIA hardware. Mac-local proof is insufficient. |

## de-slop criteria coverage

Direct `remove-ai-slops` / `programming` pass result:

- Current gates verify behavior surfaces, but no gate enforces categorized slop cleanup:
  obvious comments, over-defensive code, excessive complexity, needless abstraction, boundary violations,
  dead code, duplication, performance equivalence, missing tests, oversized modules.
- No gate requires behavior-lock tests before deleting cleanup targets.
- No gate checks for overfit/slop tests: deletion-only tests, tests that merely verify a requested removal,
  tautological tests, implementation-mirroring tests, excessive/useless tests, or unnecessary production extraction,
  parsing, or normalization.
- No gate enforces the 250 pure-LOC ceiling or `programming` no-excuse checks on changed source files.
- No gate runs a local lint/static/security scanner. Typecheck exists for UI; C++/Python lint/security is absent.
- The workflow adversarial review prompt checks prime directives, gate weakening, scope creep, correctness/races,
  and secrets. It does not explicitly require the remove-ai-slops overfit/slop pass or proof that the code-review report
  covered that criterion. This is an approval blocker for a de-slop campaign.

## blockers

1. Review coverage is incomplete for de-slop. `.claude/workflows/auto-loop.workflow.js` review prompt does not require
   `remove-ai-slops` criteria, overfit-test detection, or unnecessary abstraction/extraction checks.
2. The provided input did not include executor evidence, code review report, manual QA matrix, or notepad path. Those are
   exact evidence gaps for final approval.
3. Auto-loop gate evidence is not durable enough. `gate.sh` writes step logs to temp files, emits JSON to stdout, and the
   ledger keeps only a digest after finalize. A failed or passed gate needs a preserved artifact bundle.
4. Installed-app truth is not part of the native auto-loop gate. The native gate uses the worktree Release binary; installed
   app proof requires explicit `/Applications/Mosh.app/Contents/MacOS/Mosh` commands.
5. Gate/rulebook self-protection is inconsistent. `docs/auto-loop/README.md` and workflow text say the loop must not edit
   its own gate/rulebook, but `classify.sh` treats `scripts/auto-loop/*` as cheap and not excluded; workflow edits are native
   but not hard-excluded.
6. Local `.only`/skip protection is weak. Playwright `forbidOnly` is tied to `CI`, but hosted CI is absent; Vitest has no
   explicit local `.only` guard in the gate.
7. No CMake test preset exists, and current `build-macos-arm64-release` had no registered CTest tests. The gate configures
   first, but a backlog hardening item should fail closed on zero tests and stale test binaries.

## backlog gaps to add

1. **De-slop review prompt hardening**: extend workflow review to require a direct `remove-ai-slops` overfit/slop pass over
   diff, tests, and production code; output must mention each criterion and blockers.
2. **Durable gate artifact bundle**: teach `gate.sh` / `merge-one.sh prepare` to write
   `_preserved_artifacts/auto-loop/<item>/<timestamp>/gate.json`, per-step logs, selftest logs, verify.py report, and PR diff.
3. **Gate self-protection**: move `scripts/auto-loop/*`, `.claude/workflows/auto-loop.workflow.js`, and non-state
   `docs/auto-loop/*` rulebook files to a hard-exclusion or needs-human route.
4. **Installed-app lane**: add a non-auto-merge/manual gate for release/deploy waves:
   `codesign --verify --deep --strict /Applications/Mosh.app` plus
   `MOSH_NO_AUDIO=1 /Applications/Mosh.app/Contents/MacOS/Mosh --selftest` and selected `verify.py --bin /Applications/...`.
5. **No `.only` / skip gate**: add a local fail-fast grep or runner flag for `test.only`, `describe.only`, `it.only`,
   `test.skip`, and unexpected skipped native/selftest sections.
6. **No-excuse source checks**: add changed-file pure LOC measurement and language-specific checks for Python/TS/C++ where
   available; at minimum report files over 250 pure LOC when touched.
7. **CMake test preset + zero-test guard**: add `testPresets` and fail the native gate if CTest registers zero tests or if
   the test target build fails before CTest.
8. **Manual/hardware matrix capture**: create a small matrix artifact for voice, live audio, two-window multiplayer visual
   sync, iPhone physical device, Windows/NVIDIA, SA3/RAVE real-model gates, and by-ear A/B confirmations.

## final assessment

The available gates are useful and mostly well-targeted by wave class, but they currently prove "the class-correct
functional gate passed" rather than "a de-slop cleanup is behavior-preserving, non-overfit, and maintenance-positive."
Do not approve the de-slop campaign as self-governing until the blockers above are addressed.
