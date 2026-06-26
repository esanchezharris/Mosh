# Gate Review: Mosh Native Completion Debug Plan

recommendation: APPROVE

originalIntent: Verify the branch `codex/mosh-native-completion-debug` as the final gate for fixing the native master-meter clipping issue, proving Space toggles transport in `/Applications/Mosh.app`, hardening deploy/codesign/xattr behavior, and preserving existing local merge gates after the final comment-only keymap cleanup.

desiredOutcome: The rebuilt and redeployed `/Applications/Mosh.app` contains the staged UI and bundled service, is ad-hoc signed, xattr-clean, and code-signature-valid; the topbar master meter remains bounded during clipping playback; Space in the installed app records `set_transport {"action":"toggle"}`; targeted UI, native build, installed selftest 3x, undo, ctest, and command-log gates all pass with current evidence.

userOutcomeReview: PASS. The final post-keymap evidence is current and complete. Manual/native evidence predates the comment-only `ui/src/interaction/keymap.ts` cleanup, but the post-comment rebuilt UI hash matches the installed UI hash (`db0997...` in `installed-app-match-final-post-keymap-comment.txt:5-7`), so the prior screenshots/log-tail remain valid for the same shipped UI bundle.

blockers: none

## Criteria Review

1. Master meter bounds: PASS
   - `ui/src/ui/Meter.tsx:44` toggles `meter-clip`, not global `clip`.
   - `ui/src/ui/mosh.css:410` scopes glow to `.meter.meter-clip .mbar`.
   - RED/GREEN proof: `meter-red.txt` failed before the class/selector change; `meter-green.txt` passed 2/2.
   - Real surface: `manual-final-launchctl-playing.png` shows the master meter contained in the topbar transport cluster during playback/clipping; `manual-final-launchctl-stopped.png` shows the stopped state remains contained.

2. Space toggles transport in installed native app: PASS
   - Native menu binding: `src/app/MenuController.cpp:158-164` assigns Space to Play/Pause; `src/app/MenuController.cpp:186-189` forwards `play_pause`.
   - UI dispatch: `ui/src/menuActions.ts:123-124` maps `play_pause` to `set_transport { action: "toggle" }`.
   - Installed manual evidence: `manual-final-launchctl-space-log-tail.txt:12` records `set_transport` toggle; `manual-final-launchctl-stop-log-tail.txt:12` records the later toggle.

3. Installed app/redeploy correctness: PASS
   - `deploy-final-post-keymap-comment.txt` reports deploy from `build-macos-arm64-release`, bundled service, valid ad-hoc signature, final xattr cleanup, and `xattrs: stripped`.
   - `codesign-xattr-pycache-final-post-keymap-comment.txt:1-5` reports codesign passed, xattr count 0, pycache count 0, service `run.sh` executable, and `server.py` present.
   - `installed-app-match-final-post-keymap-comment.txt:5-21` shows UI and Info.plist hashes match the rebuilt Release app, installed executable is ad-hoc signed, and service file count is 54.
   - Independent read-only check matched this: `git diff --check` exit 0, `codesign --verify --deep --strict /Applications/Mosh.app` exit 0, xattr count 0, pycache count 0, UI/Info.plist hashes equal, service file count 54.

4. Existing local merge gates: PASS
   - Targeted UI: `targeted-ui-tests-final-post-keymap-comment.txt:21-24` shows 6 files / 49 tests passed.
   - UI build: `ui-build-final-post-keymap-comment.txt` shows `tsc --noEmit && vite build` succeeded.
   - Native release build/restage: `cmake-release-build-final-post-keymap-comment.txt` shows UI build and Release app restaging succeeded.
   - Installed selftest 3x: `installed-selftest-3x-final-post-keymap-comment.txt:1131`, `:2265`, and `:3399` each show `1008/1008 checks passed, 0 failed`.
   - Undo: `installed-selftest-undo-final-post-keymap-comment.txt:24-25` shows 18/18 checks passed.
   - CTest: `ctest-release-final-post-keymap-comment.txt:3-5` shows `MoshTests` passed and 100% tests passed.
   - Command-log contract: `validate-command-log-contract-final-post-keymap-comment.txt:1` shows `PASS: checked 456 command records`.
   - Diff hygiene: `git-diff-check-final-after-all-gates.txt` is empty, consistent with clean `git diff --check`; independent rerun exited 0.

5. remove-ai-slops risk pass: PASS
   - Overfit tests: `Meter.test.ts:56-60` is implementation-proximal because it asserts selector text, but it is not the sole proof; the runtime class test plus manual screenshot prove the behavior. Accepted as narrow regression for the known CSS class collision, not as real-surface proof.
   - Fake/shallow proof: Not relied on alone. Native app screenshots, command-log tails, installed bundle hashes, codesign/xattr checks, and installed selftests back the unit tests.
   - Stale evidence: Latest `final-post-keymap-comment` files are used. Manual evidence is accepted because the post-comment generated UI hash is unchanged and matches the installed app.
   - Unnecessary comments: No blocking comment slop found in the changed hunks. The keymap cleanup is comment-only and clarifies the single shortcut owner; deploy comments explain macOS provenance/xattr timing rather than restating code.
   - No skipped tests, `.only`, `@ts-ignore`, `@ts-expect-error`, or `as any` found in the changed TS/TSX test/source files.

6. Programming maintainability pass: PASS
   - Ownership boundaries: Native `MenuController` forwards menu intents only; UI `runAction` remains the MoshOps dispatch boundary. No direct Tracktion mutation was added to native menu code.
   - Shortcut regressions: App-level hook now owns keymap dispatch; it yields native-menu-owned actions when `nativeMenuPresent()` is true, preserves Delete in WebView, and avoids hijacking Space when the Moshi prompt has text. Tests cover those cases in `useKeyboardShortcuts.test.ts:57-133`.
   - Deploy script correctness: `run-mosh.sh` signs after service bundling, performs final xattr cleanup/verification, and reuses `sign_app` for default and anira deploys. `service/run.sh` preserves explicit `MOSH_ENABLE_SA3` override and disables pycache creation.
   - Type/test quality: Focused tests are small and typed; no broad mocks beyond the bridge boundary, no type suppressions, no deleted/disabled tests. `ui/src/Arrange.tsx` remains oversized at 648 pure LOC, but this branch removed shortcut ownership from it and did not expand that existing module.

checkedArtifactPaths:
- `run-mosh.sh`
- `service/run.sh`
- `src/app/MenuController.cpp`
- `src/app/MenuController.h`
- `src/app/SelfTest.cpp`
- `ui/src/hooks/useKeyboardShortcuts.ts`
- `ui/src/hooks/useKeyboardShortcuts.test.ts`
- `ui/src/interaction/keymap.ts`
- `ui/src/ui/Arrange.tsx`
- `ui/src/ui/Meter.tsx`
- `ui/src/ui/Meter.test.ts`
- `ui/src/ui/mosh.css`
- `.omo/ultrawork/evidence/meter-red.txt`
- `.omo/ultrawork/evidence/meter-green.txt`
- `.omo/ultrawork/evidence/space-hook-red.txt`
- `.omo/ultrawork/evidence/space-hook-green.txt`
- `.omo/ultrawork/evidence/space-hook-focused-prompt-green.txt`
- `.omo/ultrawork/evidence/targeted-ui-tests-final-post-keymap-comment.txt`
- `.omo/ultrawork/evidence/ui-build-final-post-keymap-comment.txt`
- `.omo/ultrawork/evidence/cmake-release-build-final-post-keymap-comment.txt`
- `.omo/ultrawork/evidence/deploy-final-post-keymap-comment.txt`
- `.omo/ultrawork/evidence/installed-selftest-3x-final-post-keymap-comment.txt`
- `.omo/ultrawork/evidence/installed-selftest-undo-final-post-keymap-comment.txt`
- `.omo/ultrawork/evidence/ctest-release-final-post-keymap-comment.txt`
- `.omo/ultrawork/evidence/validate-command-log-contract-final-post-keymap-comment.txt`
- `.omo/ultrawork/evidence/codesign-xattr-pycache-final-post-keymap-comment.txt`
- `.omo/ultrawork/evidence/installed-app-match-final-post-keymap-comment.txt`
- `.omo/ultrawork/evidence/git-diff-check-final-after-all-gates.txt`
- `.omo/ultrawork/evidence/manual-final-launchctl-playing.png`
- `.omo/ultrawork/evidence/manual-final-launchctl-space-log-tail.txt`
- `.omo/ultrawork/evidence/manual-final-launchctl-stopped.png`
- `.omo/ultrawork/evidence/manual-final-launchctl-stop-log-tail.txt`

exactEvidenceGaps: none blocking.

residualRisks:
- Native text-field Space behavior with a non-empty Moshi prompt is covered by the WebView-level unit test, not a separate installed-app manual typing capture.
- `Meter.test.ts` includes one selector-text assertion; it is acceptable here because real-surface screenshot evidence and runtime class behavior are the approval basis.
- `ui/src/ui/Arrange.tsx` is still oversized pre-existing code; this branch reduces its shortcut responsibility but does not refactor the module.
